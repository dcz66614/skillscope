/**
 * OpenMausBot skill-scope PoC adapter (T003).
 *
 * Rules implemented (PROJECT_BOOK §4.5, OpenMausBot feature-flags docs
 * and Issue #5449 — used as a real fault-mode source, never claiming all
 * nine items are still unfixed):
 * - Server config.json lives in the data dir (~/.openmausbot or
 *   OMB_DATA_DIR). Missing config => documented defaults apply
 *   (claudeUserSkills off, skillsLibrary off). Present but invalid or
 *   unreadable config => flag state is UNKNOWN => INCOMPLETE. The
 *   flags live under `features` in config.json (official
 *   docs/feature-flags.md — FIX-R1, P0-R1-04); top-level flag keys
 *   are not part of the documented schema and are ignored. Existence
 *   is checked with an error-discriminating stat, not `existsSync`:
 *   an unreadable config is "invalid", never "defaults" (FIX-R1,
 *   P1-R1-02). The same rule applies to the every-bot opt-out file.
 * - claudeUserSkills off (default): a Claude bot does NOT load the
 *   machine's personal ~/.claude/skills. On: those skills load.
 * - skillsLibrary off (default): shared-library every-bot skills do NOT
 *   load. On: they load unless the bot opted out of them.
 * - every-bot opt-out state is skill-state/<bot-id>/library-opt-out.json.
 *   Missing file => no opt-outs. Present but invalid/unreadable =>
 *   FAIL_OPEN_CONFIG (P1) + INCOMPLETE: per the public docs the bot may
 *   regain the every-bot skills, so the result must not claim PASS.
 * - Per-bot inventory comes from a versioned snapshot
 *   ("openmausbot-snapshot/v1"). An unknown snapshot version => the
 *   inventory cannot be trusted => INCOMPLETE.
 * - Imported skills: closing the imported copy does NOT unload the
 *   original folder (#5449 item 7). When a closed imported skill's
 *   original path sits under a loadable root, the original is still
 *   active => IMPORT_ORIGINAL_PATH_STILL_ACTIVE (P1).
 * - Native skills are switched per bot BY NAME (#5449 items 1-2). A
 *   name switch that also matches a same-named repo/library skill is a
 *   NAME_SELECTOR_BLAST_RADIUS (P1).
 * - Account-installed plugin skills reach bot turns; the snapshot lists
 *   them with a namespaced logical name. A per-bot switch is
 *   `disabledPluginIds`; without it, plugin skills stay active and are
 *   subject to the policy like any other scope.
 *
 * Adapter boundary (§4.5): read-only on the documented config and
 * opt-out files plus the versioned snapshot. No SQLite schema guessing,
 * no private HTTP API, no writes to config.json / opt-out / bot state.
 *
 * Status precedence: INCOMPLETE > FAIL > PASS. P2 findings (same-name
 * collision, duplicate content) are recorded but do not flip PASS to FAIL.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  type AuditStatus,
  type SkillInstanceV1,
} from "../../contracts/index.js";
import { classifyPath } from "../../fsutil/index.js";
import { parseFrontmatter, sha256Hex, type ScannedSkill } from "../shared/skill-scan.js";

export const OPENMAUSBOT_SNAPSHOT_VERSION = "openmausbot-snapshot/v1";

export type OpenMausBotSkillKind =
  | "assigned"
  | "imported"
  | "native"
  | "plugin"
  | "repo"
  | "library"
  | "user-claude";

export interface OpenMausBotSnapshotSkill {
  name: string;
  kind: OpenMausBotSkillKind;
  /** Absolute path of the skill directory (synthetic fixture path). */
  path: string;
  /** IMPORTED only: "active" or "closed" (the imported copy was switched off). */
  importState?: "active" | "closed";
  /** IMPORTED only: the original folder the import came from. */
  originalPath?: string;
  /** PLUGIN only: the plugin that installed the skill. */
  pluginId?: string;
}

export interface OpenMausBotSnapshot {
  version: string;
  skills: OpenMausBotSnapshotSkill[];
  /** Absolute paths the host would load skills from (repo/user roots). */
  loadableRoots: string[];
  /** Plugin ids switched off for this bot (turn/start disabledPluginIds). */
  disabledPluginIds?: string[];
  /** Native skill names switched off for this bot (name-based). */
  nativeDisabledNames?: string[];
}

export interface OpenMausBotPocInput {
  profileId: string;
  botId: string;
  /** Synthetic data dir holding config.json and skill-state/. */
  dataDir: string;
  snapshot: OpenMausBotSnapshot;
  policy?: {
    allowedScopes?: string[];
    forbiddenScopes?: string[];
  };
}

export interface OpenMausBotPocFinding {
  id: string;
  severity: "P1" | "P2";
  sourceScope: string;
  detail: string;
  instanceIds: string[];
}

export interface OpenMausBotPocResult {
  profileId: string;
  botId: string;
  engine: "openmausbot";
  instances: SkillInstanceV1[];
  findings: OpenMausBotPocFinding[];
  coverage: {
    enumeratedSources: number;
    requiredSources: number;
    unknownScopes: string[];
  };
  status: AuditStatus;
  flags: {
    claudeUserSkills: boolean;
    skillsLibrary: boolean;
    configSource: "file" | "defaults" | "invalid";
  };
}

const KIND_SCOPE: Record<OpenMausBotSkillKind, string> = {
  assigned: "BOT_ASSIGNED",
  imported: "IMPORTED",
  native: "SYSTEM",
  plugin: "PLUGIN",
  repo: "REPO",
  library: "SHARED_LIBRARY",
  "user-claude": "USER",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readJsonFile(filePath: string): { ok: true; value: unknown } | { ok: false; reason: string } {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, reason: "unreadable" };
  }
  try {
    return { ok: true, value: JSON.parse(raw) as unknown };
  } catch {
    return { ok: false, reason: "invalid-json" };
  }
}

function ombInstanceId(rootId: string, scanned: ScannedSkill): string {
  // Snapshot skills are single folders, not roots: folder names alone are
  // not unique across parents, so the canonical path hash disambiguates.
  return `${rootId}:${sha256Hex(scanned.canonicalPath)}`;
}

function instanceFromScan(
  scanned: ScannedSkill,
  rootId: string,
  scope: string,
  logicalName: string,
  status: SkillInstanceV1["status"],
  botId: string,
): SkillInstanceV1 {
  return {
    instanceId: ombInstanceId(rootId, scanned),
    engine: "openmausbot",
    botId,
    sourceRootId: rootId,
    sourceScope: scope,
    relativePath: scanned.relativePath,
    canonicalPathHash: sha256Hex(scanned.canonicalPath),
    logicalName,
    folderName: scanned.folderName,
    ...(scanned.manifestName !== null ? { manifestName: scanned.manifestName } : {}),
    contentSha256: scanned.contentSha256,
    status,
    evidenceLevel: "STATIC_RULE",
  };
}

export function resolveOpenMausBotPoc(
  input: OpenMausBotPocInput,
): OpenMausBotPocResult {
  const instances: SkillInstanceV1[] = [];
  const findings: OpenMausBotPocFinding[] = [];
  const unknownScopes: string[] = [];
  let enumeratedSources = 0;
  const requiredSources = 2; // config + snapshot

  // ---- 1. Server config: flags, or defaults when the file is absent. ----
  //
  // FIX-R1 (P0-R1-04): the flags live under `features` in config.json
  // (official docs/feature-flags.md: "The server stores these options
  // under `features` in its `config.json`"). Top-level
  // `claudeUserSkills` / `skillsLibrary` keys are not part of the
  // documented schema and are ignored: a config that only sets them
  // reads as defaults (both off). `features` absent means defaults;
  // `features` present but not an object, or with non-boolean flags,
  // means the flag state is unknown (FAIL_OPEN_CONFIG + INCOMPLETE).
  //
  // FIX-R1 (P1-R1-02): the existence check is a stat with error
  // discrimination, not `existsSync`. A config that exists but cannot
  // be read (EACCES on the file or its directory) is "invalid", never
  // "defaults": `existsSync` returns false for both, which used to
  // misread an unreadable library-ON config as defaults (both off).
  let claudeUserSkills = false;
  let skillsLibrary = false;
  let configSource: "file" | "defaults" | "invalid" = "defaults";
  const configPath = path.join(input.dataDir, "config.json");
  const configAccess = classifyPath(configPath);
  if (configAccess === "missing") {
    configSource = "defaults";
    enumeratedSources += 1;
  } else if (configAccess === "unreadable") {
    configSource = "invalid";
    unknownScopes.push("CONFIG");
    findings.push({
      id: "FAIL_OPEN_CONFIG",
      severity: "P1",
      sourceScope: "SYSTEM",
      detail: `config.json at ${configPath} exists but cannot be read; flag state unknown, host may fall back to defaults`,
      instanceIds: [],
    });
  } else {
    const parsed = readJsonFile(configPath);
    if (!parsed.ok || !isRecord(parsed.value)) {
      configSource = "invalid";
      unknownScopes.push("CONFIG");
      findings.push({
        id: "FAIL_OPEN_CONFIG",
        severity: "P1",
        sourceScope: "SYSTEM",
        detail: `config.json at ${configPath} is ${parsed.ok ? "not an object" : parsed.reason}; flag state unknown, host may fall back to defaults`,
        instanceIds: [],
      });
    } else {
      const features = parsed.value["features"];
      if (features !== undefined && !isRecord(features)) {
        configSource = "invalid";
        unknownScopes.push("CONFIG");
        findings.push({
          id: "FAIL_OPEN_CONFIG",
          severity: "P1",
          sourceScope: "SYSTEM",
          detail: "config.json has a non-object \"features\" value; flag state unknown",
          instanceIds: [],
        });
      } else {
        const userSkills =
          features === undefined ? undefined : features["claudeUserSkills"];
        const library =
          features === undefined ? undefined : features["skillsLibrary"];
        if (
          (userSkills !== undefined && typeof userSkills !== "boolean") ||
          (library !== undefined && typeof library !== "boolean")
        ) {
          configSource = "invalid";
          unknownScopes.push("CONFIG");
          findings.push({
            id: "FAIL_OPEN_CONFIG",
            severity: "P1",
            sourceScope: "SYSTEM",
            detail: "config.json has non-boolean features.claudeUserSkills/skillsLibrary flags; flag state unknown",
            instanceIds: [],
          });
        } else {
          configSource = "file";
          enumeratedSources += 1;
          claudeUserSkills = userSkills === true;
          skillsLibrary = library === true;
        }
      }
    }
  }

  // ---- 2. Snapshot version gate. ----
  let snapshotTrusted = true;
  if (input.snapshot.version !== OPENMAUSBOT_SNAPSHOT_VERSION) {
    snapshotTrusted = false;
    unknownScopes.push("SNAPSHOT");
    findings.push({
      id: "SOURCE_NOT_ENUMERATED",
      severity: "P1",
      sourceScope: "SYSTEM",
      detail: `snapshot version "${input.snapshot.version}" is unknown; per-bot inventory cannot be trusted`,
      instanceIds: [],
    });
  } else {
    enumeratedSources += 1;
  }

  // ---- 3. Every-bot opt-out state (only meaningful when the library is on). ----
  //
  // FIX-R1 (P1-R1-02): same existsSync flaw as the config above. An
  // opt-out file that exists but cannot be read (EACCES on the file
  // or on skill-state/<bot-id>/) is FAIL_OPEN_CONFIG + INCOMPLETE,
  // not "no opt-outs". The affected skills stay ELIGIBLE — per the
  // public docs an unreadable opt-out file means the bot keeps the
  // every-bot skills — but the audit cannot claim PASS while the
  // opt-out state is unverified.
  const optedOut = new Set<string>();
  let optOutUnknown = false;
  if (skillsLibrary && configSource !== "invalid") {
    const optOutPath = path.join(
      input.dataDir,
      "skill-state",
      input.botId,
      "library-opt-out.json",
    );
    const optOutAccess = classifyPath(optOutPath);
    if (optOutAccess === "unreadable") {
      optOutUnknown = true;
      unknownScopes.push("SHARED_LIBRARY");
      findings.push({
        id: "FAIL_OPEN_CONFIG",
        severity: "P1",
        sourceScope: "SHARED_LIBRARY",
        detail: `library opt-out file at ${optOutPath} exists but cannot be read; per public docs the bot may regain every-bot skills`,
        instanceIds: [],
      });
    } else if (optOutAccess === "present") {
      const parsed = readJsonFile(optOutPath);
      if (!parsed.ok || !Array.isArray(parsed.value)) {
        optOutUnknown = true;
        unknownScopes.push("SHARED_LIBRARY");
        findings.push({
          id: "FAIL_OPEN_CONFIG",
          severity: "P1",
          sourceScope: "SHARED_LIBRARY",
          detail: `library opt-out file at ${optOutPath} is ${parsed.ok ? "not an array" : parsed.reason}; per public docs the bot may regain every-bot skills`,
          instanceIds: [],
        });
      } else {
        for (const entry of parsed.value) {
          if (typeof entry === "string") {
            optedOut.add(entry);
          }
        }
      }
    }
    // Missing opt-out file => no opt-outs: every-bot skills apply.
  }

  // ---- 4. Resolve snapshot skills into instances. ----
  if (snapshotTrusted) {
    for (const skill of input.snapshot.skills) {
      const scope = KIND_SCOPE[skill.kind];
      const rootId = `snapshot:${skill.kind}`;
      const logicalName =
        skill.kind === "plugin" && skill.pluginId !== undefined
          ? `${skill.pluginId}:${skill.name}`
          : skill.name;

      // Flag-gated kinds: a skill that the flags keep off is DISCOVERED
      // but not ELIGIBLE; it is not silently dropped from the inventory.
      let gatedOff = false;
      if (skill.kind === "library" && !skillsLibrary) {
        gatedOff = true;
      }
      if (skill.kind === "user-claude" && !claudeUserSkills) {
        gatedOff = true;
      }
      if (skill.kind === "library" && optedOut.has(skill.name)) {
        gatedOff = true;
      }

      // FIX-R1 (P1-R1-02): a stat with error discrimination, not
      // `existsSync` — an unreadable directory is unknown either
      // way, and the detail already says "missing or unreadable".
      if (classifyPath(skill.path) !== "present") {
        unknownScopes.push(scope);
        findings.push({
          id: "SOURCE_NOT_ENUMERATED",
          severity: "P1",
          sourceScope: scope,
          detail: `snapshot skill "${skill.name}" (${skill.kind}) points at missing or unreadable directory ${skill.path}`,
          instanceIds: [],
        });
        continue;
      }
      // A snapshot skill path points at ONE skill folder, not at a root
      // of skill folders: read that single folder directly.
      //
      // FIX-R1 (P0-R1-02, same defect class as the Claude SKILL.md
      // case): a skill directory whose SKILL.md cannot be read used
      // to vanish silently — scanSingleSkillDir returned [] and no
      // finding was raised. An unreadable SKILL.md is now
      // SOURCE_NOT_ENUMERATED for the skill's scope. The detail
      // matches the full adapter's per-skill check word for word, so
      // the kernel dedupes the two into one finding. (The guard keeps
      // a scope from being listed twice when several skills in it are
      // unreadable; the canonical form sorts but does not dedupe.)
      const resolved = scanSingleSkillDir(skill.path, skill.name);
      if (resolved.unreadable) {
        if (!unknownScopes.includes(scope)) {
          unknownScopes.push(scope);
        }
        findings.push({
          id: "SOURCE_NOT_ENUMERATED",
          severity: "P1",
          sourceScope: scope,
          detail: `snapshot skill "${skill.name}" (${skill.kind}) points at a directory with no readable SKILL.md; the skill cannot be enumerated`,
          instanceIds: [],
        });
        continue;
      }
      for (const scanned of resolved.scanned) {
        if (!scanned.manifestValid) {
          findings.push({
            id: "INVALID_MANIFEST",
            severity: "P2",
            sourceScope: scope,
            detail: `SKILL.md for "${skill.name}" has invalid frontmatter: ${scanned.manifestErrors.join(", ")}`,
            instanceIds: [ombInstanceId(rootId, scanned)],
          });
          instances.push(
            instanceFromScan(scanned, rootId, scope, logicalName, "INVALID", input.botId),
          );
          continue;
        }
        let status: SkillInstanceV1["status"] = gatedOff ? "DISCOVERED" : "ELIGIBLE";
        if (
          skill.kind === "plugin" &&
          skill.pluginId !== undefined &&
          (input.snapshot.disabledPluginIds ?? []).includes(skill.pluginId)
        ) {
          status = "DISABLED";
        }
        if (skill.kind === "imported" && skill.importState === "closed") {
          status = "DISABLED";
        }
        instances.push(
          instanceFromScan(scanned, rootId, scope, logicalName, status, input.botId),
        );

        // #5449 item 7: a closed imported copy does not unload the
        // original folder. If the original still sits under a loadable
        // root, it stays active.
        if (
          skill.kind === "imported" &&
          skill.importState === "closed" &&
          skill.originalPath !== undefined
        ) {
          const originalUnderRoot = input.snapshot.loadableRoots.some((root) =>
            isPathUnder(skill.originalPath as string, root),
          );
          if (originalUnderRoot) {
            findings.push({
              id: "IMPORT_ORIGINAL_PATH_STILL_ACTIVE",
              severity: "P1",
              sourceScope: "IMPORTED",
              detail: `imported skill "${skill.name}" was closed but its original folder ${skill.originalPath} is still under a loadable root`,
              instanceIds: [ombInstanceId(rootId, scanned)],
            });
            const originalScanned = scanSingleSkillDir(
              skill.originalPath,
              skill.name,
            );
            // FIX-R1 (P0-R1-02): an unreadable original SKILL.md is
            // unknown content for IMPORTED, not a silent absence.
            if (originalScanned.unreadable) {
              if (!unknownScopes.includes("IMPORTED")) {
                unknownScopes.push("IMPORTED");
              }
              findings.push({
                id: "SOURCE_NOT_ENUMERATED",
                severity: "P1",
                sourceScope: "IMPORTED",
                detail: `imported skill "${skill.name}" original folder ${skill.originalPath} has no readable SKILL.md; the original cannot be enumerated`,
                instanceIds: [],
              });
            }
            for (const orig of originalScanned.scanned) {
              instances.push(
                instanceFromScan(
                  orig,
                  "imported-original",
                  "IMPORTED",
                  skill.name,
                  orig.manifestValid ? "ELIGIBLE" : "INVALID",
                  input.botId,
                ),
              );
            }
          }
        }
      }
    }

    // Native name switches are name-based (#5449 items 1-2): a switch
    // hits every instance with that logical name, not just the native one.
    for (const name of input.snapshot.nativeDisabledNames ?? []) {
      const matched = instances.filter(
        (inst) => inst.logicalName === name && inst.status !== "INVALID",
      );
      if (matched.length > 1) {
        findings.push({
          id: "NAME_SELECTOR_BLAST_RADIUS",
          severity: "P1",
          sourceScope: matched[0]?.sourceScope ?? "",
          detail: `per-bot native name switch "${name}" disables ${matched.length} distinct instances`,
          instanceIds: matched.map((inst) => inst.instanceId),
        });
      }
      for (const inst of matched) {
        inst.status = "DISABLED";
      }
    }
  }

  // Same logical name at different paths: distinct instances, P2 note.
  const byName = new Map<string, SkillInstanceV1[]>();
  for (const inst of instances) {
    if (inst.status === "INVALID") {
      continue;
    }
    const group = byName.get(inst.logicalName) ?? [];
    group.push(inst);
    byName.set(inst.logicalName, group);
  }
  for (const [name, group] of [...byName.entries()].sort()) {
    const distinctPaths = new Set(group.map((inst) => inst.canonicalPathHash));
    if (distinctPaths.size > 1) {
      findings.push({
        id: "SAME_NAME_COLLISION",
        severity: "P2",
        sourceScope: group[0]?.sourceScope ?? "",
        detail: `logical name "${name}" resolves to ${distinctPaths.size} distinct instances at different paths`,
        instanceIds: group.map((inst) => inst.instanceId),
      });
    }
  }

  // Duplicate content at different paths: still two instances, plus a note.
  const byContent = new Map<string, SkillInstanceV1[]>();
  for (const inst of instances) {
    const group = byContent.get(inst.contentSha256) ?? [];
    group.push(inst);
    byContent.set(inst.contentSha256, group);
  }
  for (const [hash, group] of [...byContent.entries()].sort()) {
    const distinctPaths = new Set(group.map((inst) => inst.canonicalPathHash));
    if (group.length > 1 && distinctPaths.size > 1) {
      findings.push({
        id: "DUPLICATE_CONTENT",
        severity: "P2",
        sourceScope: group[0]?.sourceScope ?? "",
        detail: `content hash ${hash.slice(0, 12)}… appears at ${distinctPaths.size} distinct paths`,
        instanceIds: group.map((inst) => inst.instanceId),
      });
    }
  }

  // Policy comparison on the effective set.
  //
  // FIX-R1 (alignment with the T006 kernel, ADR-006): the effective
  // set is ELIGIBLE only. A DISCOVERED instance is one the host found
  // but a host flag keeps unloaded, so it cannot leak; the PoC used
  // to count DISCOVERED as effective and report SCOPE_LEAK (FAIL)
  // where the kernel — which strips the PoC's inline SCOPE_LEAK and
  // recomputes — reported PASS. The two layers now agree.
  const effective = instances.filter((inst) => inst.status === "ELIGIBLE");
  const forbidden = new Set(input.policy?.forbiddenScopes ?? []);
  const allowed =
    input.policy?.allowedScopes === undefined
      ? null
      : new Set(input.policy.allowedScopes);
  for (const inst of effective) {
    if (forbidden.has(inst.sourceScope)) {
      findings.push({
        id: "SCOPE_LEAK",
        severity: "P1",
        sourceScope: inst.sourceScope,
        detail: `skill "${inst.logicalName}" from forbidden scope ${inst.sourceScope} is in the effective set`,
        instanceIds: [inst.instanceId],
      });
    } else if (allowed !== null && !allowed.has(inst.sourceScope)) {
      findings.push({
        id: "SCOPE_LEAK",
        severity: "P1",
        sourceScope: inst.sourceScope,
        detail: `skill "${inst.logicalName}" from scope ${inst.sourceScope} is outside the allowed scopes`,
        instanceIds: [inst.instanceId],
      });
    }
  }

  findings.sort((a, b) =>
    a.id === b.id
      ? a.detail.localeCompare(b.detail)
      : a.id.localeCompare(b.id),
  );

  const hasP1 = findings.some((finding) => finding.severity === "P1");
  const status: AuditStatus =
    unknownScopes.length > 0 || optOutUnknown
      ? "INCOMPLETE"
      : hasP1
        ? "FAIL"
        : "PASS";

  return {
    profileId: input.profileId,
    botId: input.botId,
    engine: "openmausbot",
    instances,
    findings,
    coverage: { enumeratedSources, requiredSources, unknownScopes },
    status,
    flags: { claudeUserSkills, skillsLibrary, configSource },
  };
}

/**
 * A snapshot skill path points at ONE skill folder (containing SKILL.md),
 * not at a root of skill folders. Read that single folder.
 *
 * FIX-R1 (P0-R1-02): the result is discriminated. `unreadable` is
 * true when the SKILL.md cannot be read — the file is missing from
 * the directory, or it exists but the caller may not read it. The
 * old behaviour returned an empty list for both cases, which made an
 * unreadable skill vanish without a finding. Callers must report the
 * scope UNKNOWN when `unreadable` is true.
 */
function scanSingleSkillDir(
  skillDir: string,
  folderName: string,
): { scanned: ScannedSkill[]; unreadable: boolean } {
  const skillFile = path.join(skillDir, "SKILL.md");
  let content: string;
  try {
    content = fs.readFileSync(skillFile, "utf8");
  } catch {
    return { scanned: [], unreadable: true };
  }
  let canonicalPath: string;
  try {
    canonicalPath = fs.realpathSync(skillFile);
  } catch {
    return { scanned: [], unreadable: true };
  }
  const frontmatter = parseFrontmatter(content);
  return {
    scanned: [
      {
        folderName,
        relativePath: `${folderName}/SKILL.md`,
        absolutePath: skillFile,
        canonicalPath,
        contentSha256: sha256Hex(content),
        manifestName: frontmatter.name ?? null,
        manifestValid: frontmatter.valid,
        manifestErrors: frontmatter.errors,
        aliases: [],
      },
    ],
    unreadable: false,
  };
}

function isPathUnder(childPath: string, parentPath: string): boolean {
  const relative = path.relative(parentPath, childPath);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/** Resolve a fixture profile whose paths are relative to `fixtureDir`. */
export function resolveOpenMausBotFixture(
  profile: OpenMausBotPocInput,
  fixtureDir: string,
): OpenMausBotPocResult {
  const resolveAbs = (p: string): string =>
    p === "" ? p : path.resolve(fixtureDir, p);
  const resolved: OpenMausBotPocInput = {
    ...profile,
    dataDir: resolveAbs(profile.dataDir),
    snapshot: {
      ...profile.snapshot,
      skills: profile.snapshot.skills.map((skill) => ({
        ...skill,
        path: resolveAbs(skill.path),
        ...(skill.originalPath !== undefined
          ? { originalPath: resolveAbs(skill.originalPath) }
          : {}),
      })),
      loadableRoots: profile.snapshot.loadableRoots.map(resolveAbs),
    },
  };
  return resolveOpenMausBotPoc(resolved);
}
