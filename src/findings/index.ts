/**
 * Finding taxonomy and status derivation (P023 T006, S1).
 *
 * This module is the single source of truth for SkillScope finding types
 * (PROJECT_BOOK §5.2). Every finding the system can emit — from the three
 * host PoC adapters, from the policy comparison in src/policy, and from
 * the discovery-skip conversion in src/resolver — is normalised into the
 * one `FindingV1` shape here, with its severity taken from the catalog
 * below (never from the caller), its instance references sorted and
 * deduplicated, and its `status` defaulting to CONFIRMED unless the
 * finding reports an unenumerated source (then UNKNOWN: the finding
 * asserts that something could not be verified, so the audit cannot
 * claim completeness).
 *
 * Severity / status vocabulary (PROJECT_BOOK §5.2):
 *   P1  — a blocking finding: the audit cannot PASS while one stands.
 *   P2  — recorded only; it never flips PASS to FAIL.
 *   CONFIRMED — the defect was observed in the enumerated data.
 *   UNKNOWN   — the finding reports something that could not be
 *               enumerated or verified (e.g. SOURCE_NOT_ENUMERATED,
 *               SYMLINK_OUTSIDE_ROOT whose target was never read).
 *
 * Status derivation (PROJECT_BOOK §4.1, frozen precedence):
 *   INCOMPLETE > FAIL > PASS
 *   - INCOMPLETE when any required source is unenumerated
 *     (`unknownScopes` non-empty) or any finding has status UNKNOWN:
 *     the effective set cannot be proven complete, so neither PASS nor
 *     FAIL would be honest.
 *   - FAIL when any CONFIRMED P1 finding stands and nothing is unknown.
 *   - PASS otherwise (P2 findings may still be present).
 *
 * The module is pure: no file access, no clock, no network. All outputs
 * are deterministic for the same inputs.
 */

import type { AuditStatus } from "../contracts/index.js";

export type FindingSeverity = "P1" | "P2";
export type FindingStatus = "CONFIRMED" | "UNKNOWN";

export type FindingId =
  | "SCOPE_LEAK"
  | "DISABLE_MISMATCH"
  | "NAME_SELECTOR_BLAST_RADIUS"
  | "SAME_NAME_COLLISION"
  | "FAIL_OPEN_CONFIG"
  | "SOURCE_NOT_ENUMERATED"
  | "IMPORT_ORIGINAL_PATH_STILL_ACTIVE"
  | "SYMLINK_ALIAS"
  | "SYMLINK_OUTSIDE_ROOT"
  | "INVALID_MANIFEST"
  | "DUPLICATE_CONTENT";

/** The frozen §5.2 taxonomy: id → severity + one-line meaning. */
export const FINDING_CATALOG: Readonly<Record<FindingId, {
  severity: FindingSeverity;
  meaning: string;
}>> = {
  SCOPE_LEAK: {
    severity: "P1",
    meaning: "An ELIGIBLE skill lives in a scope the policy forbids (or outside the allow-list).",
  },
  DISABLE_MISMATCH: {
    severity: "P1",
    meaning: "A skill the policy expects disabled is still ELIGIBLE (loaded).",
  },
  NAME_SELECTOR_BLAST_RADIUS: {
    severity: "P1",
    meaning: "A name-based disable/enable selector matched more than one distinct skill instance.",
  },
  SAME_NAME_COLLISION: {
    severity: "P2",
    meaning: "Two or more distinct instances share one logical name.",
  },
  FAIL_OPEN_CONFIG: {
    severity: "P1",
    meaning: "A host config is unreadable or invalid, so the host fails open (defaults apply).",
  },
  SOURCE_NOT_ENUMERATED: {
    severity: "P1",
    meaning: "A required skill source could not be enumerated; its content is unknown.",
  },
  IMPORT_ORIGINAL_PATH_STILL_ACTIVE: {
    severity: "P1",
    meaning: "An imported skill's original path is still active alongside the import.",
  },
  SYMLINK_ALIAS: {
    severity: "P2",
    meaning: "A symlink alias was not merged into the instance it points at.",
  },
  SYMLINK_OUTSIDE_ROOT: {
    severity: "P1",
    meaning: "A symlink resolves outside the authorised scan root; its target was never read.",
  },
  INVALID_MANIFEST: {
    severity: "P2",
    meaning: "A SKILL.md frontmatter does not satisfy the Agent Skills specification.",
  },
  DUPLICATE_CONTENT: {
    severity: "P2",
    meaning: "Two or more distinct instances carry byte-identical SKILL.md content.",
  },
};

export const FINDING_IDS: readonly FindingId[] = Object.keys(
  FINDING_CATALOG,
) as FindingId[];

export interface FindingV1 {
  id: FindingId;
  severity: FindingSeverity;
  sourceScope: string;
  status: FindingStatus;
  detail: string;
  /** Canonical instance keys "<sourceRootId>:<relativePath>", sorted, deduplicated. */
  instanceIds: string[];
  /** Present only when the producer reports an affected-instance count (Codex blast radius). */
  affectedCount?: number;
}

/**
 * A finding as produced by a PoC adapter or by the policy comparison:
 * `severity` is accepted but ignored (the catalog is authoritative),
 * `status` and `instanceIds` are optional (the Claude / OpenMausBot PoCs
 * carry no status field; the Codex PoC carries no instanceIds).
 */
export interface FindingInput {
  id: string;
  severity?: FindingSeverity;
  sourceScope: string;
  status?: FindingStatus;
  detail: string;
  instanceIds?: readonly string[];
  affectedCount?: number;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Normalise one finding into FindingV1. Throws on an unknown finding id
 * (the taxonomy is frozen; an unknown id is a producer bug, not data)
 * and on a non-string / empty detail. Severity always comes from the
 * catalog. When `status` is absent it is derived: SOURCE_NOT_ENUMERATED
 * is UNKNOWN (it reports something unverified), everything else is
 * CONFIRMED — the same rule the S0 canonicaliser uses
 * (scripts/s0-canonical.mjs).
 */
export function normalizeFinding(input: FindingInput): FindingV1 {
  const entry = (FINDING_CATALOG as Record<string, { severity: FindingSeverity }>)[input.id];
  if (entry === undefined) {
    throw new Error(`unknown finding id: ${JSON.stringify(input.id)}`);
  }
  if (typeof input.detail !== "string" || input.detail.length === 0) {
    throw new Error(`finding ${input.id} requires a non-empty detail string`);
  }
  if (
    input.status !== undefined &&
    input.status !== "CONFIRMED" &&
    input.status !== "UNKNOWN"
  ) {
    throw new Error(`finding ${input.id} has invalid status: ${JSON.stringify(input.status)}`);
  }
  const out: FindingV1 = {
    id: input.id as FindingId,
    severity: entry.severity,
    sourceScope: input.sourceScope,
    status:
      input.status ??
      (input.id === "SOURCE_NOT_ENUMERATED" ? "UNKNOWN" : "CONFIRMED"),
    detail: input.detail,
    instanceIds: sortedUnique(input.instanceIds ?? []),
  };
  if (input.affectedCount !== undefined) {
    out.affectedCount = input.affectedCount;
  }
  return out;
}

/** Comparison key for deterministic finding order. */
function findingKey(f: FindingV1): string {
  return [
    f.id,
    f.sourceScope,
    f.detail,
    f.instanceIds.join(","),
  ].join("\0");
}

export function compareFindings(a: FindingV1, b: FindingV1): number {
  const ka = findingKey(a);
  const kb = findingKey(b);
  return ka < kb ? -1 : ka > kb ? 1 : 0;
}

/** Sort findings deterministically: (id, sourceScope, detail, instanceIds). */
export function sortFindings(findings: readonly FindingV1[]): FindingV1[] {
  return [...findings].sort(compareFindings);
}

/**
 * Collapse findings that are identical on (id, sourceScope, status,
 * detail, instanceIds, affectedCount). Two findings that differ only in
 * wording or in the instances they name are NOT the same finding and are
 * kept apart. The first occurrence wins; output is sorted.
 */
export function dedupeFindings(findings: readonly FindingV1[]): FindingV1[] {
  const seen = new Set<string>();
  const out: FindingV1[] = [];
  for (const f of findings) {
    const key = [
      f.id,
      f.sourceScope,
      f.status,
      f.detail,
      f.instanceIds.join(","),
      f.affectedCount === undefined ? "" : String(f.affectedCount),
    ].join("\0");
    if (!seen.has(key)) {
      seen.add(key);
      out.push(f);
    }
  }
  return sortFindings(out);
}

/**
 * Derive the audit status from normalised findings and the list of
 * unenumerated scopes. Precedence is INCOMPLETE > FAIL > PASS
 * (PROJECT_BOOK §4.1): an unknown source — or any finding whose status
 * is UNKNOWN — makes the audit INCOMPLETE even when a P1 finding also
 * stands, because the effective set cannot be proven complete.
 */
export function deriveAuditStatus(
  findings: readonly FindingV1[],
  unknownScopes: readonly string[],
): AuditStatus {
  if (unknownScopes.length > 0) {
    return "INCOMPLETE";
  }
  if (findings.some((f) => f.status === "UNKNOWN")) {
    return "INCOMPLETE";
  }
  if (findings.some((f) => f.severity === "P1")) {
    return "FAIL";
  }
  return "PASS";
}

/** True when the finding blocks a PASS verdict (P1, CONFIRMED). */
export function isBlockingFinding(finding: FindingV1): boolean {
  return finding.severity === "P1" && finding.status === "CONFIRMED";
}
