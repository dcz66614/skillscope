/**
 * OpenMausBot full read-only adapter (P023 T007, S2).
 *
 * The T003 PoC (`openmausbot-poc.ts`) is the S0 production side and is
 * NOT modified here: the S0 gate calls it directly, and this adapter
 * layers on top of it. The adapter wires the host's public config and
 * the versioned per-bot snapshot into the T006 rule engine
 * (`src/resolver`), adding the checks the PoC does not own:
 *
 *   1. Data-dir resolution (§4.5): explicit `dataDir` > `OMB_DATA_DIR`
 *      > `<home>/.openmausbot`. The resolved dir and its source are
 *      reported, so a test can prove which dir was actually read.
 *   2. Snapshot acquisition + contract validation (`snapshot.ts`):
 *      inline snapshot > `snapshotPath` file > missing. A missing,
 *      unreadable or malformed snapshot means the per-bot inventory
 *      is not enumerated (ADR-007) — unlike the PoC, which treats a
 *      missing snapshot as an empty inventory. An unknown version
 *      still flows to the PoC's version gate.
 *   3. Missing per-bot lists: every kind in `requireLists` (default
 *      assigned / imported / plugin) must either appear in the
 *      snapshot or be declared empty in `emptyLists`; otherwise the
 *      audit is INCOMPLETE for that scope. Absence is never read as
 *      empty.
 *   4. Plugin disable path (T006 leftover, #5449 item 8): a plugin
 *      skill listed in `disabledPluginIds` is DISABLED and produces
 *      no policy leak; a plugin skill with NO `pluginId` has no
 *      per-plugin disable path at all, so the adapter marks it
 *      UNKNOWN and reports SOURCE_NOT_ENUMERATED for PLUGIN
 *      (ADR-008) instead of silently treating it as switchable.
 *   5. Inventory completeness: a snapshot skill whose directory
 *      exists but yields no instance (no readable SKILL.md) is
 *      SOURCE_NOT_ENUMERATED; and `scanRoots` are reconciled against
 *      the snapshot with the T005 bounded discovery — a skill present
 *      on disk but absent from the snapshot is SOURCE_NOT_ENUMERATED
 *      for its scope, and a missing/unreadable scan root is too.
 *   6. Full manifest validation: every snapshot-listed skill is
 *      re-checked with the T005 full YAML frontmatter parser
 *      (`src/manifest`); skills the PoC's minimal parser passes but
 *      the full parser rejects (reserved names, duplicate keys)
 *      gain an INVALID_MANIFEST (P2) finding. Skills the PoC already
 *      flagged are not double-reported.
 *
 * Policy (ADR-005/ADR-006) is owned by the kernel: the adapter passes
 * the caller's policy through to `resolveOpenMausBotAudit` and never
 * compares policy itself. The effective set is ELIGIBLE only, so a
 * DISCOVERED skill (host flag off) never leaks and an UNKNOWN skill
 * never leaks either — it fails closed as INCOMPLETE instead.
 *
 * Read-only: the adapter only reads config / opt-out / snapshot /
 * SKILL.md files. It never writes config.json, library-opt-out.json
 * or bot state, never calls a private API, never guesses an
 * undocumented SQLite schema, and never trusts an unknown snapshot
 * version. Finding details never contain absolute paths (§4.2
 * rule 5): paths are reported fixture-relative or by skill name.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSkillRoot } from "../../discovery/discovery.js";
import { parseManifest } from "../../manifest/manifest.js";
import type { PolicyV1 } from "../../policy/index.js";
import {
  resolveOpenMausBotAudit,
  type AuditResult,
  type DiscoveryInput,
} from "../../resolver/index.js";
import { sha256Hex } from "../shared/skill-scan.js";
import {
  OPENMAUSBOT_SNAPSHOT_VERSION,
  resolveOpenMausBotFixture,
  type OpenMausBotPocFinding,
  type OpenMausBotPocInput,
  type OpenMausBotPocResult,
  type OpenMausBotSkillKind,
} from "./openmausbot-poc.js";
import {
  kindsPresent,
  loadSnapshotFile,
  toPocSnapshot,
  validateSnapshotShape,
  type OpenMausBotSnapshotV1,
} from "./snapshot.js";

/** Scope per snapshot kind (mirrors the PoC's §4.5 table). */
const KIND_SCOPE: Record<OpenMausBotSkillKind, string> = {
  assigned: "BOT_ASSIGNED",
  imported: "IMPORTED",
  native: "SYSTEM",
  plugin: "PLUGIN",
  repo: "REPO",
  library: "SHARED_LIBRARY",
  "user-claude": "USER",
};

/** Per-bot lists the audit requires the snapshot to account for. */
export const DEFAULT_REQUIRE_LISTS: readonly OpenMausBotSkillKind[] = [
  "assigned",
  "imported",
  "plugin",
];

export type DataDirSource = "explicit" | "env" | "default";

export type SnapshotSource =
  | "inline"
  | "file"
  | "missing"
  | "invalid-json"
  | "invalid-shape"
  | "unknown-version";

export interface ScanRootInput {
  scope: string;
  /** Path of the skill root, fixture-relative when `fixtureDir` is set. */
  path: string;
}

export interface OpenMausBotAdapterInput {
  profileId: string;
  botId: string;
  /** Explicit data dir (highest precedence; fixture-relative when given). */
  dataDir?: string;
  /** Synthetic home dir for the default-data-dir rule (fixture-relative). Defaults to os.homedir(). */
  homeDir?: string;
  /** Environment overrides; defaults to process.env. */
  env?: Record<string, string | undefined>;
  /** Inline snapshot document (takes precedence over `snapshotPath`). */
  snapshot?: unknown;
  /** Path to a snapshot JSON file (fixture-relative when given). */
  snapshotPath?: string;
  /** Per-bot lists the snapshot must account for. Default: assigned, imported, plugin. */
  requireLists?: readonly OpenMausBotSkillKind[];
  /** Disk roots to reconcile against the snapshot inventory (fixture-relative). */
  scanRoots?: readonly ScanRootInput[];
  /** User policy, passed through to the kernel (ADR-005). */
  policy?: PolicyV1;
  /** Directory fixture-relative paths resolve against. Defaults to process.cwd(). */
  fixtureDir?: string;
}

export interface OpenMausBotAdapterResult {
  profileId: string;
  botId: string;
  /** Absolute resolved data dir. */
  dataDir: string;
  dataDirSource: DataDirSource;
  configSource: "file" | "defaults" | "invalid";
  snapshotSource: SnapshotSource;
  snapshotVersion: string | null;
  audit: AuditResult;
  diagnostics: {
    /** Required kinds absent from the snapshot and not declared empty. */
    missingLists: OpenMausBotSkillKind[];
    /** Plugin skill names listed without a pluginId. */
    unattributedPlugins: string[];
    reconciliation: {
      rootsScanned: number;
      /** Scopes whose scan root was missing or unreadable. */
      rootsMissing: string[];
      skillsOnDisk: number;
      /** "<scope>:<folderName>" keys present on disk but absent from the snapshot. */
      skillsMissingFromSnapshot: string[];
    };
    manifestRechecks: {
      checked: number;
      /** Native PoC instance ids (`snapshot:<kind>:<sha256>`) the full parser rejects. */
      invalid: string[];
    };
  };
}

const EMPTY_SNAPSHOT: OpenMausBotSnapshotV1 = {
  version: OPENMAUSBOT_SNAPSHOT_VERSION,
  skills: [],
  loadableRoots: [],
};

function resolveFixtureRelative(
  value: string,
  fixtureDir: string,
): string {
  return path.isAbsolute(value) ? value : path.resolve(fixtureDir, value);
}

function resolveDataDir(
  input: OpenMausBotAdapterInput,
  fixtureDir: string,
): { dataDir: string; source: DataDirSource } {
  if (input.dataDir !== undefined) {
    return {
      dataDir: resolveFixtureRelative(input.dataDir, fixtureDir),
      source: "explicit",
    };
  }
  const env = input.env ?? process.env;
  const envDir = env["OMB_DATA_DIR"];
  if (envDir !== undefined && envDir !== "") {
    return { dataDir: path.resolve(envDir), source: "env" };
  }
  const home =
    input.homeDir !== undefined
      ? resolveFixtureRelative(input.homeDir, fixtureDir)
      : os.homedir();
  return { dataDir: path.join(home, ".openmausbot"), source: "default" };
}

function sourceNotEnumerated(
  sourceScope: string,
  detail: string,
): OpenMausBotPocFinding {
  return {
    id: "SOURCE_NOT_ENUMERATED",
    severity: "P1",
    sourceScope,
    detail,
    instanceIds: [],
  };
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Run the full OpenMausBot audit for one bot: resolve the data dir,
 * acquire and validate the versioned snapshot, run the frozen PoC,
 * apply the adapter's completeness checks, and hand the result to
 * the T006 kernel for policy comparison and status derivation.
 */
export function auditOpenMausBot(
  input: OpenMausBotAdapterInput,
): OpenMausBotAdapterResult {
  const fixtureDir =
    input.fixtureDir !== undefined
      ? path.resolve(input.fixtureDir)
      : process.cwd();
  const { dataDir, source: dataDirSource } = resolveDataDir(input, fixtureDir);

  // ---- Snapshot acquisition. ----
  let snapshotDoc: OpenMausBotSnapshotV1 | null = null;
  let snapshotSource: SnapshotSource = "missing";
  let snapshotErrors: string[] = [];
  if (input.snapshot !== undefined) {
    const errors = validateSnapshotShape(input.snapshot);
    if (errors.length > 0) {
      snapshotSource = "invalid-shape";
      snapshotErrors = errors;
    } else {
      snapshotSource = "inline";
      snapshotDoc = input.snapshot as OpenMausBotSnapshotV1;
    }
  } else if (input.snapshotPath !== undefined) {
    const snapPath = resolveFixtureRelative(input.snapshotPath, fixtureDir);
    const loaded = loadSnapshotFile(snapPath);
    if (loaded.ok) {
      snapshotSource = "file";
      snapshotDoc = loaded.snapshot;
    } else {
      snapshotSource =
        loaded.reason === "missing"
          ? "missing"
          : loaded.reason === "invalid-json"
            ? "invalid-json"
            : "invalid-shape";
      snapshotErrors = loaded.errors;
    }
  }
  const snapshotVersion = snapshotDoc !== null ? snapshotDoc.version : null;
  if (
    snapshotDoc !== null &&
    snapshotDoc.version !== OPENMAUSBOT_SNAPSHOT_VERSION
  ) {
    snapshotSource = "unknown-version";
  }
  const snapshotTrusted =
    snapshotDoc !== null &&
    snapshotDoc.version === OPENMAUSBOT_SNAPSHOT_VERSION;

  // ---- PoC run. When the snapshot is unusable the adapter probes the
  // config through the PoC with an empty trusted snapshot (the probe
  // reads config.json + opt-out only; no inventory is claimed) and
  // then overrides the snapshot half of the coverage below. ----
  const pocInput: OpenMausBotPocInput = {
    profileId: input.profileId,
    botId: input.botId,
    dataDir,
    snapshot: toPocSnapshot(snapshotDoc ?? EMPTY_SNAPSHOT),
  };
  const poc: OpenMausBotPocResult = resolveOpenMausBotFixture(
    pocInput,
    fixtureDir,
  );

  const extraFindings: OpenMausBotPocFinding[] = [];
  const extraUnknownScopes: string[] = [];
  let extraEnumerated = 0;
  let extraRequired = 0;
  const diagnostics: OpenMausBotAdapterResult["diagnostics"] = {
    missingLists: [],
    unattributedPlugins: [],
    reconciliation: {
      rootsScanned: 0,
      rootsMissing: [],
      skillsOnDisk: 0,
      skillsMissingFromSnapshot: [],
    },
    manifestRechecks: { checked: 0, invalid: [] },
  };

  if (snapshotDoc === null) {
    // No usable snapshot: the inventory half of the coverage was not
    // enumerated. The probe counted it; take it back.
    extraEnumerated -= 1;
    extraUnknownScopes.push("SNAPSHOT");
    const detail =
      snapshotSource === "invalid-json"
        ? "snapshot file is not valid JSON; per-bot inventory cannot be enumerated"
        : snapshotSource === "invalid-shape"
          ? `snapshot failed contract validation (${snapshotErrors.join("; ")}); per-bot inventory cannot be enumerated`
          : "no versioned snapshot was provided (neither inline snapshot nor snapshotPath); per-bot inventory cannot be enumerated";
    extraFindings.push(sourceNotEnumerated("SYSTEM", detail));
  } else if (snapshotTrusted) {
    // ---- Missing per-bot lists (ADR-007). ----
    const present = kindsPresent(snapshotDoc);
    const declaredEmpty = new Set(snapshotDoc.emptyLists ?? []);
    const requireLists = input.requireLists ?? DEFAULT_REQUIRE_LISTS;
    for (const kind of requireLists) {
      if (present.has(kind) || declaredEmpty.has(kind)) {
        continue;
      }
      const scope = KIND_SCOPE[kind];
      diagnostics.missingLists.push(kind);
      extraUnknownScopes.push(scope);
      extraFindings.push(
        sourceNotEnumerated(
          scope,
          `per-bot ${kind} list is absent from the versioned snapshot and not declared empty in emptyLists; the ${kind} inventory cannot be proven complete`,
        ),
      );
    }

    // ---- Per-skill completeness: unattributed plugins, missing
    // SKILL.md, full-manifest re-check. ----
    const instanceByHash = new Map(
      poc.instances.map((inst) => [inst.canonicalPathHash, inst]),
    );
    for (const skill of snapshotDoc.skills) {
      const skillDir = resolveFixtureRelative(skill.path, fixtureDir);
      const skillFile = path.join(skillDir, "SKILL.md");
      let canonicalHash: string | null = null;
      let skillContent: string | null = null;
      try {
        const canonicalPath = fs.realpathSync(skillFile);
        canonicalHash = sha256Hex(canonicalPath);
        skillContent = fs.readFileSync(skillFile, "utf8");
      } catch {
        canonicalHash = null;
      }
      const instance =
        canonicalHash !== null
          ? instanceByHash.get(canonicalHash)
          : undefined;

      if (instance === undefined) {
        // The skill directory exists but produced no instance: no
        // readable SKILL.md. (A missing directory is already reported
        // by the PoC; do not double-report it.)
        if (fs.existsSync(skillDir)) {
          const scope = KIND_SCOPE[skill.kind];
          extraUnknownScopes.push(scope);
          extraFindings.push(
            sourceNotEnumerated(
              scope,
              `snapshot skill "${skill.name}" (${skill.kind}) points at a directory with no readable SKILL.md; the skill cannot be enumerated`,
            ),
          );
        }
        continue;
      }

      // Unattributed plugin skill (ADR-008): no pluginId means no
      // per-plugin disable path can ever cover it.
      if (skill.kind === "plugin" && skill.pluginId === undefined) {
        diagnostics.unattributedPlugins.push(skill.name);
        extraUnknownScopes.push("PLUGIN");
        extraFindings.push({
          id: "SOURCE_NOT_ENUMERATED",
          severity: "P1",
          sourceScope: "PLUGIN",
          detail: `plugin skill "${skill.name}" has no pluginId; no per-plugin disable path (disabledPluginIds) can cover it`,
          instanceIds: [instance.instanceId],
        });
        // Fail closed: the skill's loadability cannot be proven
        // switchable, so it leaves the effective set.
        instance.status = "UNKNOWN";
      }

      // Full-manifest re-check (T005 parser). Skills the PoC already
      // flagged INVALID are not double-reported.
      const alreadyFlagged = poc.findings.some(
        (finding) =>
          finding.id === "INVALID_MANIFEST" &&
          finding.instanceIds.includes(instance.instanceId),
      );
      if (!alreadyFlagged && skillContent !== null) {
        diagnostics.manifestRechecks.checked += 1;
        const manifest = parseManifest(skillContent);
        if (!manifest.valid) {
          diagnostics.manifestRechecks.invalid.push(instance.instanceId);
          extraFindings.push({
            id: "INVALID_MANIFEST",
            severity: "P2",
            sourceScope: KIND_SCOPE[skill.kind],
            detail: `SKILL.md for "${skill.name}" fails full frontmatter validation: ${manifest.errors.join(", ")}`,
            instanceIds: [instance.instanceId],
          });
        }
      }
    }

    // ---- Disk-vs-snapshot reconciliation (T005 discovery). ----
    const pocHashes = new Set(
      poc.instances.map((inst) => inst.canonicalPathHash),
    );
    const discoveryInputs: DiscoveryInput[] = [];
    for (const root of input.scanRoots ?? []) {
      const rootAbs = resolveFixtureRelative(root.path, fixtureDir);
      const result = discoverSkillRoot(rootAbs);
      discoveryInputs.push({ sourceScope: root.scope, skipped: result.skipped });
      diagnostics.reconciliation.rootsScanned += 1;
      extraRequired += 1;
      if (
        result.skipped.some(
          (skip) => skip.reason === "ROOT_MISSING_OR_UNREADABLE",
        )
      ) {
        diagnostics.reconciliation.rootsMissing.push(root.scope);
        extraUnknownScopes.push(root.scope);
        extraFindings.push(
          sourceNotEnumerated(
            root.scope,
            `scan root for ${root.scope} is missing or unreadable; its skills cannot be enumerated`,
          ),
        );
        continue;
      }
      extraEnumerated += 1;
      diagnostics.reconciliation.skillsOnDisk += result.skills.length;
      for (const discovered of result.skills) {
        if (pocHashes.has(sha256Hex(discovered.canonicalPath))) {
          continue;
        }
        const key = `${root.scope}:${discovered.folderName}`;
        diagnostics.reconciliation.skillsMissingFromSnapshot.push(key);
        extraUnknownScopes.push(root.scope);
        extraFindings.push(
          sourceNotEnumerated(
            root.scope,
            `skill "${discovered.folderName}" exists on disk under ${root.scope} but is absent from the versioned snapshot inventory`,
          ),
        );
      }
    }

    // ---- Kernel. ----
    const modifiedPoc: OpenMausBotPocResult = {
      ...poc,
      findings: [...poc.findings, ...extraFindings],
      coverage: {
        enumeratedSources:
          poc.coverage.enumeratedSources + extraEnumerated,
        requiredSources: poc.coverage.requiredSources + extraRequired,
        unknownScopes: sortedUnique([
          ...poc.coverage.unknownScopes,
          ...extraUnknownScopes,
        ]),
      },
    };
    const audit = resolveOpenMausBotAudit(
      modifiedPoc,
      input.policy,
      discoveryInputs,
    );
    return {
      profileId: input.profileId,
      botId: input.botId,
      dataDir,
      dataDirSource,
      configSource: poc.flags.configSource,
      snapshotSource,
      snapshotVersion,
      audit,
      diagnostics,
    };
  }

  // Snapshot present but untrusted (unknown version): the PoC already
  // reported SOURCE_NOT_ENUMERATED for SNAPSHOT and produced no
  // instances. No inventory-dependent checks can run.
  const modifiedPoc: OpenMausBotPocResult = {
    ...poc,
    findings: [...poc.findings, ...extraFindings],
    coverage: {
      enumeratedSources: poc.coverage.enumeratedSources + extraEnumerated,
      requiredSources: poc.coverage.requiredSources + extraRequired,
      unknownScopes: sortedUnique([
        ...poc.coverage.unknownScopes,
        ...extraUnknownScopes,
      ]),
    },
  };
  const audit = resolveOpenMausBotAudit(modifiedPoc, input.policy, []);
  return {
    profileId: input.profileId,
    botId: input.botId,
    dataDir,
    dataDirSource,
    configSource: poc.flags.configSource,
    snapshotSource,
    snapshotVersion,
    audit,
    diagnostics,
  };
}
