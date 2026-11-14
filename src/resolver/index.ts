/**
 * Unified audit resolver (P023 T006, S1).
 *
 * The resolver is the reusable rule / policy / finding kernel that sits
 * ON TOP of the three host PoC adapters (src/adapters/codex,
 * src/adapters/claude, src/adapters/openmausbot). It does not replace
 * them and it does not feed the S0 gate — the gate calls the PoCs
 * directly and compares them against the independent Python Oracle, so
 * nothing here can move the frozen S0 gate hash. The kernel's job is to
 * turn the three adapters' heterogeneous results into one auditable
 * contract (`AuditResult`) that T009 (CLI) and T013 (review) can consume
 * without knowing host internals:
 *
 *   1. Instance normalisation. Each PoC instance becomes a
 *      `NormalizedInstance` whose `instanceId` is the canonical audit
 *      key "<sourceRootId>:<relativePath>" — the same identity the S0
 *      canonical form uses for finding references
 *      (scripts/s0-canonical.mjs). The Codex PoC's machine-local SHA
 *      instanceIds (hashes of absolute paths) and the OpenMausBot
 *      PoC's snapshot-entry ids ("<rootId>:<sha256 of canonical path>")
 *      are both replaced by this key, so kernel output is portable
 *      across machines; the Claude PoC already emits canonical keys
 *      and its mapping is the identity. (The kernel builds a
 *      native → canonical id map per audit and translates finding
 *      references through it, throwing on an ambiguous or unknown id —
 *      the same guard the S0 canonicaliser applies.) This is the
 *      audit-layer (access-path) identity; the physical-file identity
 *      — one instance per real file — stays with the T005
 *      IdentityRegistry, whose input contract is absolute canonical
 *      paths. The kernel deliberately does not fabricate absolute
 *      paths to feed the registry: PoC results do not carry them
 *      uniformly (Codex exposes a layout-relative canonical path;
 *      Claude / OpenMausBot expose a canonical-path hash). Aliases
 *      recorded by the PoCs are preserved verbatim on the normalised
 *      instance (Codex aliases are preserved; Claude / OpenMausBot
 *      PoCs do not track aliases and record none).
 *
 *   2. Finding normalisation. PoC findings are normalised through
 *      src/findings (severity from the frozen §5.2 catalog, instance
 *      references sorted and deduplicated, deterministic order).
 *      Exception: the PoCs' inline SCOPE_LEAK findings are STRIPPED and
 *      recomputed by src/policy, so the kernel — not three inline
 *      copies — is the single source of policy truth. This also
 *      supersedes the PoCs' inline choice to count DISCOVERED instances
 *      as effective (see src/policy: the kernel's effective set is
 *      ELIGIBLE only).
 *
 *   3. Policy comparison. When a policy is supplied it is validated and
 *      applied uniformly across hosts by src/policy — including for
 *      Codex, whose PoC carries no policy input at all. DISABLE_MISMATCH
 *      (expected-disabled but still ELIGIBLE) is produced only here; no
 *      PoC emits it.
 *
 *   4. Discovery-skip findings. When the caller also supplies T005
 *      discovery results for the scanned roots, skipped entries that
 *      mean unverifiable content become findings: SYMLINK_OUTSIDE_ROOT
 *      (P1, status UNKNOWN — the target was never read, so the audit
 *      is INCOMPLETE, never PASS), and — FIX-R1, P0-R1-02 — any skip
 *      that means content exists but could not be read
 *      (SKILL_MD_UNREADABLE / DIR_UNREADABLE with a real errno other
 *      than ENOENT, SKILL_MD_TOO_LARGE), converted to
 *      SOURCE_NOT_ENUMERATED (P1, UNKNOWN). A symlink loop or a
 *      dangling link produces no finding: a loop contributes no skill
 *      content and the rest of the tree was still enumerated; a
 *      dangling link is not a skill at all. A subdirectory with no
 *      SKILL.md (ENOENT) and a directory literally named SKILL.md
 *      are recorded only. Depth / entry limits and path traversal
 *      are operator bounds / safe drops, not unknown content, and
 *      stay recorded in the discovery output. A missing or unreadable
 *      scan ROOT is not converted here: the PoC / adapter already
 *      reports it through coverage, and converting it again would
 *      double-report the same source.
 *
 *   5. Status derivation. One rule for all hosts, src/findings:
 *      INCOMPLETE > FAIL > PASS (PROJECT_BOOK §4.1). An unreadable
 *      Codex config with no other unenumerated source is reported as
 *      unknown scope "CONFIG", so the fail-closed rule still applies
 *      (inert on the S0 fixtures, where the unreadable-config case
 *      already lists PLUGIN/SYSTEM as unknown).
 *
 * Hard rules enforced here (PROJECT_BOOK §4.2):
 *   - An unknown source is never treated as an empty set: it lands in
 *     `coverage.unknownScopes` and forces INCOMPLETE.
 *   - A name selector is never used as a path selector: policy name
 *     matching consults logicalName only.
 *   - Claude plugin namespaces are never flattened: logical names are
 *     matched exactly, namespace included.
 *   - An unreadable OpenMausBot config is never treated as
 *     default-off: the PoC reports it as FAIL_OPEN_CONFIG with the
 *     affected scope unknown, and the kernel preserves that.
 *
 * The module is pure apart from reading nothing at all: it takes PoC
 * results as values and returns an AuditResult. No file access, no
 * clock, no network.
 */

import type {
  CodexPocResult,
  CodexPocSkill,
} from "../adapters/codex/codex-poc.js";
import type {
  ClaudePocResult,
} from "../adapters/claude/claude-poc.js";
import type {
  OpenMausBotPocResult,
} from "../adapters/openmausbot/openmausbot-poc.js";
import type {
  AuditStatus,
  EngineId,
  EvidenceLevel,
  SkillInstanceV1,
  SkillStatus,
} from "../contracts/index.js";
import type { SkippedEntry } from "../discovery/discovery.js";
import {
  deriveAuditStatus,
  dedupeFindings,
  normalizeFinding,
  type FindingInput,
  type FindingV1,
} from "../findings/index.js";
import { isContentUnknownSkip } from "../fsutil/index.js";
import {
  comparePolicy,
  effectiveInstances,
  type PolicyV1,
} from "../policy/index.js";

export const AUDIT_RESULT_SCHEMA = "skillscope.audit-result/v1";

/** One skill instance in the unified audit contract. */
export interface NormalizedInstance {
  /** Canonical audit key "<sourceRootId>:<relativePath>". */
  instanceId: string;
  sourceRootId: string;
  sourceScope: string;
  relativePath: string;
  logicalName: string;
  folderName: string;
  manifestName?: string;
  contentSha256: string;
  status: SkillStatus;
  evidenceLevel: EvidenceLevel;
  /** Other source-root-relative paths resolving to the same SKILL.md. */
  aliases: string[];
}

export interface AuditResult {
  schema: typeof AUDIT_RESULT_SCHEMA;
  profileId: string;
  engine: EngineId;
  botId?: string;
  status: AuditStatus;
  instances: NormalizedInstance[];
  findings: FindingV1[];
  coverage: {
    enumeratedSources: number;
    requiredSources: number;
    unknownScopes: string[];
  };
  policy: {
    applied: boolean;
    normalized: PolicyV1 | null;
    effectiveCount: number;
    expectedCount: number;
    violationCount: number;
  };
}

/** T005 discovery output for one scanned root, as handed to the kernel. */
export interface DiscoveryInput {
  sourceScope: string;
  skipped: readonly SkippedEntry[];
}

/** The canonical audit key for an instance. */
export function canonicalInstanceId(
  instance: Pick<NormalizedInstance, "sourceRootId" | "relativePath">,
): string {
  return `${instance.sourceRootId}:${instance.relativePath}`;
}

function compareInstances(
  a: NormalizedInstance,
  b: NormalizedInstance,
): number {
  return a.sourceRootId < b.sourceRootId
    ? -1
    : a.sourceRootId > b.sourceRootId
      ? 1
      : a.relativePath < b.relativePath
        ? -1
        : a.relativePath > b.relativePath
          ? 1
          : a.logicalName < b.logicalName
            ? -1
            : a.logicalName > b.logicalName
              ? 1
              : 0;
}

function normalizeSkillInstanceV1(
  inst: SkillInstanceV1,
): NormalizedInstance {
  const out: NormalizedInstance = {
    instanceId: `${inst.sourceRootId}:${inst.relativePath}`,
    sourceRootId: inst.sourceRootId,
    sourceScope: inst.sourceScope,
    relativePath: inst.relativePath,
    logicalName: inst.logicalName,
    folderName: inst.folderName,
    contentSha256: inst.contentSha256,
    status: inst.status,
    evidenceLevel: inst.evidenceLevel,
    // The Claude / OpenMausBot PoCs do not track aliases (only the Codex
    // PoC does, via CodexPocSkill.aliases); canonical output records [].
    aliases: [],
  };
  if (inst.manifestName !== undefined) {
    out.manifestName = inst.manifestName;
  }
  return out;
}

function normalizeCodexSkill(skill: CodexPocSkill): NormalizedInstance {
  const out: NormalizedInstance = {
    instanceId: `${skill.sourceRootId}:${skill.relativePath}`,
    sourceRootId: skill.sourceRootId,
    sourceScope: skill.sourceScope,
    relativePath: skill.relativePath,
    logicalName: skill.logicalName,
    folderName: skill.folderName,
    contentSha256: skill.contentSha256,
    status: skill.status,
    evidenceLevel: skill.evidenceLevel,
    aliases: [...skill.aliases],
  };
  if (skill.manifestName !== undefined) {
    out.manifestName = skill.manifestName;
  }
  return out;
}

/**
 * Convert T005 discovery skips for one root into findings. Only
 * SYMLINK_OUTSIDE_ROOT and skips that mean unverifiable content
 * become findings (P1, UNKNOWN: the content was never read, so the
 * effective set cannot be proven complete and the audit is
 * INCOMPLETE, never PASS). Loops, dangling links, depth/entry
 * limits, path traversal, a missing SKILL.md (ENOENT) and a
 * directory literally named SKILL.md stay recorded in the discovery
 * output and produce no finding here — they describe traversal
 * bounds or non-skills, not unverified skill content. A missing or
 * unreadable scan root is not converted here either: the PoC /
 * adapter already reports it through coverage.
 */
export function discoveryFindings(
  discovery: DiscoveryInput,
): FindingV1[] {
  const findings: FindingV1[] = [];
  for (const entry of discovery.skipped) {
    if (entry.reason === "SYMLINK_OUTSIDE_ROOT") {
      findings.push(
        normalizeFinding({
          id: "SYMLINK_OUTSIDE_ROOT",
          sourceScope: discovery.sourceScope,
          status: "UNKNOWN",
          detail:
            `symlink '${entry.path}' resolves outside the scan root; ` +
            `its target content was never enumerated`,
          instanceIds: [],
        }),
      );
      continue;
    }
    // FIX-R1 (P0-R1-02): unreadable content is UNKNOWN, never
    // silently absent. The SOURCE_NOT_ENUMERATED id normalises to
    // status UNKNOWN, which forces INCOMPLETE in deriveAuditStatus.
    if (isContentUnknownSkip(entry.reason, entry.code)) {
      findings.push(
        normalizeFinding({
          id: "SOURCE_NOT_ENUMERATED",
          sourceScope: discovery.sourceScope,
          detail:
            `skipped entry '${entry.path}' (${entry.reason}) could not be enumerated; ` +
            `its content is unknown`,
          instanceIds: [],
        }),
      );
    }
  }
  return dedupeFindings(findings);
}

interface KernelArgs {
  profileId: string;
  engine: EngineId;
  botId?: string;
  instances: NormalizedInstance[];
  /** PoC findings; SCOPE_LEAK entries are stripped and recomputed. */
  pocFindings: readonly FindingInput[];
  /**
   * Native PoC instanceId → canonical audit key. The Claude PoC already
   * emits canonical keys (identity map); the OpenMausBot PoC emits
   * snapshot-entry ids, translated here. Codex findings carry no
   * instanceIds, so no map is needed there.
   */
  instanceIdMap?: ReadonlyMap<string, string>;
  enumeratedSources: number;
  requiredSources: number;
  unknownScopes: readonly string[];
  policy?: PolicyV1;
  discovery?: readonly DiscoveryInput[];
}

/**
 * Build the native → canonical instance-id map. Throws when two native
 * ids collapse onto one canonical key (ambiguous identity — the same
 * guard the S0 canonicaliser applies).
 */
export function buildInstanceIdMap(
  native: readonly SkillInstanceV1[],
  normalized: readonly NormalizedInstance[],
): Map<string, string> {
  const map = new Map<string, string>();
  for (let i = 0; i < native.length; i += 1) {
    const nativeId = (native[i] as SkillInstanceV1).instanceId;
    const canonical = (normalized[i] as NormalizedInstance).instanceId;
    const prev = map.get(nativeId);
    if (prev !== undefined && prev !== canonical) {
      throw new Error(
        `ambiguous canonical key for instance ${JSON.stringify(nativeId)}`,
      );
    }
    map.set(nativeId, canonical);
  }
  const seenCanonical = new Set<string>();
  for (const canonical of map.values()) {
    if (seenCanonical.has(canonical)) {
      throw new Error(
        `ambiguous canonical key ${JSON.stringify(canonical)}: two native instances map to it`,
      );
    }
    seenCanonical.add(canonical);
  }
  return map;
}

function runKernel(args: KernelArgs): AuditResult {
  const instances = [...args.instances].sort(compareInstances);
  const knownIds = new Set(instances.map((inst) => inst.instanceId));

  const findings: FindingV1[] = [];
  for (const raw of args.pocFindings) {
    // Policy findings are recomputed uniformly by src/policy below;
    // the PoCs' inline SCOPE_LEAK findings are not carried forward.
    if (raw.id === "SCOPE_LEAK") {
      continue;
    }
    // Translate native finding references (OpenMausBot snapshot-entry
    // ids) into canonical audit keys before normalising.
    let input: FindingInput = raw;
    if (args.instanceIdMap !== undefined && raw.instanceIds !== undefined) {
      input = {
        ...raw,
        instanceIds: raw.instanceIds.map((id) => {
          const mapped = args.instanceIdMap?.get(id);
          if (mapped === undefined) {
            throw new Error(
              `finding ${raw.id} references unknown instance ${JSON.stringify(id)}`,
            );
          }
          return mapped;
        }),
      };
    }
    const finding = normalizeFinding(input);
    for (const id of finding.instanceIds) {
      if (!knownIds.has(id)) {
        throw new Error(
          `finding ${finding.id} references unknown instance ${JSON.stringify(id)}`,
        );
      }
    }
    findings.push(finding);
  }

  let policySummary: AuditResult["policy"];
  if (args.policy === undefined) {
    const effective = effectiveInstances(instances);
    policySummary = {
      applied: false,
      normalized: null,
      effectiveCount: effective.length,
      expectedCount: effective.length,
      violationCount: 0,
    };
  } else {
    const comparison = comparePolicy(
      instances,
      args.policy,
      (inst) => canonicalInstanceId(inst),
    );
    findings.push(...comparison.findings);
    policySummary = {
      applied: true,
      normalized: comparison.policy,
      effectiveCount: comparison.effectiveCount,
      expectedCount: comparison.expectedCount,
      violationCount: comparison.findings.length,
    };
  }

  for (const input of args.discovery ?? []) {
    findings.push(...discoveryFindings(input));
  }

  const normalizedFindings = dedupeFindings(findings);
  const unknownScopes = [...args.unknownScopes].sort();
  const status = deriveAuditStatus(normalizedFindings, unknownScopes);

  const result: AuditResult = {
    schema: AUDIT_RESULT_SCHEMA,
    profileId: args.profileId,
    engine: args.engine,
    status,
    instances,
    findings: normalizedFindings,
    coverage: {
      enumeratedSources: args.enumeratedSources,
      requiredSources: args.requiredSources,
      unknownScopes,
    },
    policy: policySummary,
  };
  if (args.botId !== undefined) {
    result.botId = args.botId;
  }
  return result;
}

/**
 * Resolve a Codex PoC result into the unified audit contract. Codex
 * carries no policy input in the PoC, so a policy may be supplied here
 * and is applied uniformly with the other hosts. An unreadable config
 * with no other unenumerated source is reported as unknown scope
 * "CONFIG" (fail-closed; inert on the S0 fixtures).
 */
export function resolveCodexAudit(
  native: CodexPocResult,
  policy?: PolicyV1,
  discovery?: readonly DiscoveryInput[],
): AuditResult {
  const unknownScopes: string[] = [...native.unknownSources];
  if (!native.configReadable && unknownScopes.length === 0) {
    unknownScopes.push("CONFIG");
  }
  return runKernel({
    profileId: native.caseId,
    engine: "codex",
    instances: native.skills.map(normalizeCodexSkill),
    // CodexPocFinding.detail is optional in the PoC type, but every
    // finding the PoC emits carries one; a finding without a detail is
    // a producer bug and must fail loudly, not silently lose its text.
    pocFindings: native.findings.map((finding) => {
      if (finding.detail === undefined) {
        throw new Error(
          `Codex finding ${finding.id} in ${native.caseId} has no detail`,
        );
      }
      return { ...finding, detail: finding.detail };
    }),
    enumeratedSources: native.coverage.enumeratedSources,
    requiredSources: native.coverage.requiredSources,
    unknownScopes,
    policy,
    discovery,
  });
}

/** Resolve a Claude Code PoC result into the unified audit contract. */
export function resolveClaudeAudit(
  native: ClaudePocResult,
  policy?: PolicyV1,
  discovery?: readonly DiscoveryInput[],
): AuditResult {
  const instances = native.instances.map(normalizeSkillInstanceV1);
  return runKernel({
    profileId: native.profileId,
    engine: "claude-code",
    instances,
    pocFindings: native.findings,
    instanceIdMap: buildInstanceIdMap(native.instances, instances),
    enumeratedSources: native.coverage.enumeratedSources,
    requiredSources: native.coverage.requiredSources,
    unknownScopes: native.coverage.unknownScopes,
    policy,
    discovery,
  });
}

/** Resolve an OpenMausBot PoC result into the unified audit contract. */
export function resolveOpenMausBotAudit(
  native: OpenMausBotPocResult,
  policy?: PolicyV1,
  discovery?: readonly DiscoveryInput[],
): AuditResult {
  const instances = native.instances.map(normalizeSkillInstanceV1);
  return runKernel({
    profileId: native.profileId,
    engine: "openmausbot",
    botId: native.botId,
    instances,
    pocFindings: native.findings,
    instanceIdMap: buildInstanceIdMap(native.instances, instances),
    enumeratedSources: native.coverage.enumeratedSources,
    requiredSources: native.coverage.requiredSources,
    unknownScopes: native.coverage.unknownScopes,
    policy,
    discovery,
  });
}
