/**
 * Claude Code skill-scope PoC adapter (T003).
 *
 * Rules implemented (PROJECT_BOOK §4.4, Claude Code Skills docs):
 * - Sources: ENTERPRISE (managed settings), PERSONAL (~/.claude/skills),
 *   PROJECT (repo .claude/skills), NESTED (subdir .claude/skills, only when
 *   the session visits that directory), ADD_DIR (--add-dir), PLUGIN
 *   (namespaced logical name `<plugin>:<name>`), ACCOUNT_SYNC (claude.ai
 *   synced skills, only enumerable from a host snapshot).
 * - Project-root and nested skills with the same name COEXIST as distinct
 *   instances; they are not merged and neither shadows the other.
 * - Plugin skills never merge with bare local skills: the namespace is
 *   part of the logical name.
 * - `skillOverrides` is name-based only: an override disables EVERY
 *   instance whose logical name matches, and there is no path selector
 *   (unlike Codex). An override matching more than one instance is a
 *   NAME_SELECTOR_BLAST_RADIUS (P1).
 * - A required source that cannot be enumerated (missing directory, or
 *   ACCOUNT_SYNC without a snapshot) is UNKNOWN: coverage drops and the
 *   result is INCOMPLETE, never PASS. A SKILL.md that exists but cannot
 *   be read is UNKNOWN the same way (FIX-R1, P0-R1-02) — a subdirectory
 *   with no SKILL.md at all (e.g. the `synced/` container directory)
 *   is not a skill and is recorded only. When the caller supplies the
 *   account-synced directory (`accountSyncDir`) and declares no
 *   ACCOUNT_SYNC root, synced skills on disk make ACCOUNT_SYNC UNKNOWN
 *   (FIX-R1, P0-R1-03).
 *
 * Status precedence: INCOMPLETE > FAIL > PASS. P2 findings (same-name
 * collision, duplicate content, invalid manifest) are recorded but do not
 * by themselves flip PASS to FAIL.
 */

import * as path from "node:path";
import {
  type AuditStatus,
  type SkillInstanceV1,
  type SkillStatus,
} from "../../contracts/index.js";
import { isContentUnknownSkip } from "../../fsutil/index.js";
import { scanSkillRoot, sha256Hex, type ScannedSkill } from "../shared/skill-scan.js";

export type ClaudeScope =
  | "ENTERPRISE"
  | "PERSONAL"
  | "PROJECT"
  | "NESTED"
  | "ADD_DIR"
  | "PLUGIN"
  | "ACCOUNT_SYNC";

export interface ClaudeSourceRootInput {
  sourceRootId: string;
  scope: ClaudeScope;
  /** Absolute directory path; "" for ACCOUNT_SYNC without a snapshot. */
  path: string;
  required: boolean;
  /** NESTED only: the session actually visited this subdirectory. */
  visited?: boolean;
  /** PLUGIN only: the plugin that owns this root. */
  pluginName?: string;
  /** ACCOUNT_SYNC only: host snapshot of synced skills. */
  snapshotSkills?: Array<{ name: string; description?: string }>;
}

export interface ClaudePocInput {
  profileId: string;
  cwd: string;
  sourceRoots: ClaudeSourceRootInput[];
  /** Name-based disables: key is a bare name or a namespaced `plugin:name`. */
  skillOverrides?: Record<string, "off">;
  policy?: {
    allowedScopes?: string[];
    forbiddenScopes?: string[];
  };
  /**
   * FIX-R1 (P0-R1-03): absolute path of the account-synced skills
   * directory (`~/.claude/skills/synced`). When given and no
   * ACCOUNT_SYNC source root is declared, the PoC checks whether
   * synced skills exist on disk: if they do (or the directory cannot
   * be read), ACCOUNT_SYNC is UNKNOWN — a synced skill on disk is
   * never silently absent from the audit. When an ACCOUNT_SYNC root
   * IS declared, the declared root (and its snapshot) is
   * authoritative and this directory is not consulted.
   */
  accountSyncDir?: string;
}

export interface ClaudePocFinding {
  id: string;
  severity: "P1" | "P2";
  sourceScope: string;
  detail: string;
  instanceIds: string[];
}

export interface ClaudePocResult {
  profileId: string;
  engine: "claude-code";
  instances: SkillInstanceV1[];
  findings: ClaudePocFinding[];
  coverage: {
    enumeratedSources: number;
    requiredSources: number;
    unknownScopes: string[];
  };
  status: AuditStatus;
}

function instanceIdFor(rootId: string, relativePath: string): string {
  return `${rootId}:${relativePath}`;
}

function instanceFromScan(
  scanned: ScannedSkill,
  root: ClaudeSourceRootInput,
  logicalName: string,
  status: SkillStatus,
): SkillInstanceV1 {
  return {
    instanceId: instanceIdFor(root.sourceRootId, scanned.relativePath),
    engine: "claude-code",
    sourceRootId: root.sourceRootId,
    sourceScope: root.scope,
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

export function resolveClaudePoc(input: ClaudePocInput): ClaudePocResult {
  const instances: SkillInstanceV1[] = [];
  const findings: ClaudePocFinding[] = [];
  const unknownScopes: string[] = [];
  let enumeratedSources = 0;
  let requiredSources = 0;

  for (const root of input.sourceRoots) {
    if (root.required) {
      requiredSources += 1;
    }
    if (root.scope === "NESTED" && root.visited === false) {
      // Session never entered this subdirectory: the nested skills are
      // not loaded, and this is a known absence, not an unknown source.
      if (root.required) {
        enumeratedSources += 1;
      }
      continue;
    }
    if (root.scope === "ACCOUNT_SYNC") {
      if (root.snapshotSkills === undefined) {
        unknownScopes.push(root.scope);
        findings.push({
          id: "SOURCE_NOT_ENUMERATED",
          severity: "P1",
          sourceScope: root.scope,
          detail: `account-sync source ${root.sourceRootId} has no host snapshot; synced skills cannot be enumerated`,
          instanceIds: [],
        });
        continue;
      }
      enumeratedSources += 1;
      for (const snap of root.snapshotSkills) {
        instances.push({
          instanceId: instanceIdFor(root.sourceRootId, `snapshot/${snap.name}`),
          engine: "claude-code",
          sourceRootId: root.sourceRootId,
          sourceScope: "ACCOUNT_SYNC",
          relativePath: `snapshot/${snap.name}/SKILL.md`,
          canonicalPathHash: sha256Hex(`account-sync:${snap.name}`),
          logicalName: snap.name,
          folderName: snap.name,
          ...(snap.description !== undefined ? { manifestName: snap.name } : {}),
          // No file on disk: hash of the snapshot record, not a file hash.
          contentSha256: sha256Hex(`account-sync-record:${snap.name}`),
          status: "ELIGIBLE",
          evidenceLevel: "HOST_SNAPSHOT",
        });
      }
      continue;
    }

    const { skills, skipped } = scanSkillRoot(root.path);
    if (skipped.some((entry) => entry.reason === "ROOT_MISSING_OR_UNREADABLE")) {
      if (root.required) {
        unknownScopes.push(root.scope);
        findings.push({
          id: "SOURCE_NOT_ENUMERATED",
          severity: "P1",
          sourceScope: root.scope,
          detail: `required source root ${root.sourceRootId} (${root.path}) is missing or unreadable`,
          instanceIds: [],
        });
      }
      continue;
    }
    // FIX-R1 (P0-R1-02): a SKILL.md that exists but cannot be read —
    // or a subdirectory that cannot be listed — means this root was
    // not fully enumerated. The scope is UNKNOWN and the root does
    // not count as enumerated, whether or not the root is required:
    // a present-but-unreadable skill may still load, so "optional"
    // does not excuse it. Skills that could be read are still
    // reported; only completeness is withheld. A subdirectory with
    // no SKILL.md at all (ENOENT — e.g. the `synced/` container
    // directory) is not a skill and does not trigger this.
    const unverifiable = skipped.filter((entry) =>
      isContentUnknownSkip(entry.reason, entry.code),
    );
    if (unverifiable.length > 0) {
      unknownScopes.push(root.scope);
      findings.push({
        id: "SOURCE_NOT_ENUMERATED",
        severity: "P1",
        sourceScope: root.scope,
        detail:
          `required source root ${root.sourceRootId} (${root.path}) could not be fully enumerated: ` +
          `${unverifiable.length} ${unverifiable.length === 1 ? "entry" : "entries"} unreadable ` +
          `(${unverifiable.map((entry) => entry.path).join(", ")}); content may be present but is unverified`,
        instanceIds: [],
      });
    } else {
      enumeratedSources += 1;
    }
    for (const scanned of skills) {
      const baseName = scanned.manifestName ?? scanned.folderName;
      const logicalName =
        root.scope === "PLUGIN" && root.pluginName !== undefined
          ? `${root.pluginName}:${baseName}`
          : baseName;
      if (!scanned.manifestValid) {
        findings.push({
          id: "INVALID_MANIFEST",
          severity: "P2",
          sourceScope: root.scope,
          detail: `SKILL.md at ${scanned.relativePath} has invalid frontmatter: ${scanned.manifestErrors.join(", ")}`,
          instanceIds: [instanceIdFor(root.sourceRootId, scanned.relativePath)],
        });
        instances.push(instanceFromScan(scanned, root, logicalName, "INVALID"));
        continue;
      }
      instances.push(instanceFromScan(scanned, root, logicalName, "ELIGIBLE"));
    }
  }

  // FIX-R1 (P0-R1-03): undeclared account-synced skills on disk.
  // When the caller supplies the synced directory but declares no
  // ACCOUNT_SYNC root, skills sitting under it are invisible to the
  // audit above. If the directory holds skills — or cannot be read,
  // so it cannot be proven empty — the scope is UNKNOWN: without a
  // snapshot there is nothing to enumerate them from. A missing
  // synced directory is a known absence. The derived source joins
  // the coverage denominator (requiredSources): an undeclared
  // standard source must not silently leave it (P1-R1-03). When an
  // ACCOUNT_SYNC root IS declared, the declared root (and its
  // snapshot) is authoritative and the directory is not consulted.
  if (
    input.accountSyncDir !== undefined &&
    !input.sourceRoots.some((root) => root.scope === "ACCOUNT_SYNC")
  ) {
    const synced = scanSkillRoot(input.accountSyncDir);
    const rootSkip = synced.skipped.find(
      (entry) => entry.reason === "ROOT_MISSING_OR_UNREADABLE",
    );
    const syncedDirMissing =
      rootSkip !== undefined &&
      (rootSkip.code === "ENOENT" || rootSkip.code === "ENOTDIR");
    const hasUnverifiable = synced.skipped.some((entry) =>
      isContentUnknownSkip(entry.reason, entry.code),
    );
    if (
      !syncedDirMissing &&
      (synced.skills.length > 0 || hasUnverifiable || rootSkip !== undefined)
    ) {
      requiredSources += 1;
      unknownScopes.push("ACCOUNT_SYNC");
      findings.push({
        id: "SOURCE_NOT_ENUMERATED",
        severity: "P1",
        sourceScope: "ACCOUNT_SYNC",
        detail:
          rootSkip !== undefined
            ? `account-synced skills directory ${input.accountSyncDir} cannot be read; synced skills cannot be enumerated without a host snapshot`
            : `account-synced skills exist on disk under ${input.accountSyncDir} but no ACCOUNT_SYNC source root is declared; synced skills cannot be enumerated without a host snapshot`,
        instanceIds: [],
      });
    }
  }

  // Same logical name at different paths: distinct instances (coexistence
  // is official Claude behaviour), reported as a P2 collision note.
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

  // Name-based skillOverrides: no path selector. Every matching instance
  // is disabled; matching more than one is a blast radius (P1).
  const overrides = input.skillOverrides ?? {};
  for (const name of Object.keys(overrides).sort()) {
    const matched = instances.filter(
      (inst) => inst.logicalName === name && inst.status !== "INVALID",
    );
    if (matched.length > 1) {
      findings.push({
        id: "NAME_SELECTOR_BLAST_RADIUS",
        severity: "P1",
        sourceScope: matched[0]?.sourceScope ?? "",
        detail: `name-based override "${name}" disables ${matched.length} distinct instances`,
        instanceIds: matched.map((inst) => inst.instanceId),
      });
    }
    for (const inst of matched) {
      inst.status = "DISABLED";
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

  // Deterministic finding order for stable hashes.
  findings.sort((a, b) =>
    a.id === b.id
      ? a.detail.localeCompare(b.detail)
      : a.id.localeCompare(b.id),
  );

  const hasP1 = findings.some((finding) => finding.severity === "P1");
  const status: AuditStatus =
    unknownScopes.length > 0 ? "INCOMPLETE" : hasP1 ? "FAIL" : "PASS";

  return {
    profileId: input.profileId,
    engine: "claude-code",
    instances,
    findings,
    coverage: { enumeratedSources, requiredSources, unknownScopes },
    status,
  };
}

/** Resolve a fixture profile whose paths are relative to `fixtureDir`. */
export function resolveClaudeFixture(
  profile: ClaudePocInput,
  fixtureDir: string,
): ClaudePocResult {
  const resolved: ClaudePocInput = {
    ...profile,
    sourceRoots: profile.sourceRoots.map((root) => ({
      ...root,
      path:
        root.scope === "ACCOUNT_SYNC" || root.path === ""
          ? root.path
          : path.resolve(fixtureDir, root.path),
    })),
    // FIX-R1 (P0-R1-03): the account-synced directory resolves the
    // same way as the source roots.
    ...(profile.accountSyncDir !== undefined
      ? {
          accountSyncDir: path.isAbsolute(profile.accountSyncDir)
            ? profile.accountSyncDir
            : path.resolve(fixtureDir, profile.accountSyncDir),
        }
      : {}),
  };
  return resolveClaudePoc(resolved);
}
