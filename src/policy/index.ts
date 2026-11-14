/**
 * User policy schema and expected-set comparison (P023 T006, S1).
 *
 * A policy states what the user expects the bot to be able to load:
 *
 *   allowedScopes   — when present, an ELIGIBLE instance whose scope is
 *                     not listed here leaks (allow-list semantics).
 *   forbiddenScopes — an ELIGIBLE instance whose scope is listed here
 *                     leaks (deny-list semantics).
 *   forbiddenNames  — an ELIGIBLE instance whose logical name is listed
 *                     here is loaded although the user expects it closed.
 *
 * Comparison runs over the EFFECTIVE set only — instances whose status
 * is ELIGIBLE (loadable by the host). Instances that are DISABLED,
 * INVALID or UNKNOWN cannot leak, and DISCOVERED instances cannot leak
 * either: DISCOVERED means the host found the skill but a host flag
 * keeps it unloaded (OpenMausBot `skillsLibrary` / `claudeUserSkills`
 * off), so it is not part of what the bot can load. Reporting a leak
 * for a skill the bot cannot load would be a false positive — the exact
 * failure class SkillScope exists to eliminate. This differs from the
 * inline policy checks inside the Claude / OpenMausBot PoCs, which count
 * DISCOVERED as effective; the S0 fixtures do not decide the question
 * (no fixture puts a DISCOVERED instance in a forbidden scope — o09 has
 * no policy at all), so the kernel defines it here and documents the
 * divergence in 03_evidence/T006/RULE_ENGINE_REPORT.json. The resolver
 * (src/resolver) strips the PoCs' inline SCOPE_LEAK findings and lets
 * this module be the single source of policy truth.
 *
 * Name matching is by exact logical name, namespaces included: a
 * forbidden name `deploy` does NOT match `acme:deploy`, because a
 * plugin namespace is part of the logical name (PROJECT_BOOK §4.4:
 * plugin namespaces are never flattened). A name selector must never be
 * treated as a path selector, so matching never consults paths.
 *
 * Findings produced here (PROJECT_BOOK §5.2):
 *   SCOPE_LEAK (P1)        — one per ELIGIBLE instance in a forbidden
 *                            scope, or outside the allow-list.
 *   DISABLE_MISMATCH (P1)  — one per ELIGIBLE instance whose logical
 *                            name is forbidden.
 *
 * The module is pure: no file access, no clock, no network. All outputs
 * are deterministic for the same inputs.
 */

import type { SkillInstanceV1 } from "../contracts/index.js";
import {
  dedupeFindings,
  normalizeFinding,
  type FindingV1,
} from "../findings/index.js";

/** The user policy, as carried by ProfileV1.policy (PROJECT_BOOK §6.1). */
export interface PolicyV1 {
  allowedScopes?: string[];
  forbiddenScopes?: string[];
  forbiddenNames?: string[];
}

export interface PolicyComparison {
  /** Normalised policy that was applied. */
  policy: PolicyV1;
  /** ELIGIBLE instances examined. */
  effectiveCount: number;
  /** ELIGIBLE instances that survive the policy (the expected set). */
  expectedCount: number;
  /** Canonical keys "<sourceRootId>:<relativePath>" of the expected set. */
  expectedInstanceIds: string[];
  /** Policy findings (SCOPE_LEAK / DISABLE_MISMATCH), sorted. */
  findings: FindingV1[];
}

/** Instances the host can actually load. */
export function effectiveInstances<T extends Pick<SkillInstanceV1, "status">>(
  instances: readonly T[],
): T[] {
  return instances.filter((inst) => inst.status === "ELIGIBLE");
}

function sortedUniqueStrings(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/**
 * Validate a policy value. Returns a list of error strings; empty means
 * valid. Errors: not a plain object; a list field that is not an array;
 * an empty-string entry; a scope that is both allowed and forbidden
 * (contradictory policy). Duplicate entries are not an error — they are
 * removed by normalisation.
 */
export function validatePolicy(policy: unknown): string[] {
  const errors: string[] = [];
  if (
    typeof policy !== "object" ||
    policy === null ||
    Array.isArray(policy)
  ) {
    return ["policy must be an object"];
  }
  const record = policy as Record<string, unknown>;
  for (const field of ["allowedScopes", "forbiddenScopes", "forbiddenNames"] as const) {
    const value = record[field];
    if (value === undefined) {
      continue;
    }
    if (!Array.isArray(value)) {
      errors.push(`${field} must be an array of strings`);
      continue;
    }
    for (const entry of value) {
      if (typeof entry !== "string" || entry.length === 0) {
        errors.push(`${field} must contain only non-empty strings`);
        break;
      }
    }
  }
  const allowed = Array.isArray(record["allowedScopes"])
    ? (record["allowedScopes"] as unknown[])
    : [];
  const forbidden = Array.isArray(record["forbiddenScopes"])
    ? (record["forbiddenScopes"] as unknown[])
    : [];
  for (const scope of allowed) {
    if (typeof scope === "string" && forbidden.includes(scope)) {
      errors.push(`scope ${JSON.stringify(scope)} is both allowed and forbidden`);
    }
  }
  return errors;
}

/**
 * Normalise a policy: sort and deduplicate each list, drop empty lists.
 * Throws on an invalid policy (see validatePolicy).
 */
export function normalizePolicy(policy: PolicyV1): PolicyV1 {
  const errors = validatePolicy(policy);
  if (errors.length > 0) {
    throw new Error(`invalid policy: ${errors.join("; ")}`);
  }
  const out: PolicyV1 = {};
  for (const field of ["allowedScopes", "forbiddenScopes", "forbiddenNames"] as const) {
    const value = policy[field];
    if (value !== undefined && value.length > 0) {
      out[field] = sortedUniqueStrings(value);
    }
  }
  return out;
}

/**
 * Compare the effective set (ELIGIBLE instances) against the policy and
 * return the policy findings plus the expected set (effective minus
 * violating instances). `instanceIdOf` maps an instance to the canonical
 * key the resolver uses in finding references; callers pass the
 * resolver's key function so findings reference the same ids the audit
 * result carries.
 */
export function comparePolicy<T extends Pick<
  SkillInstanceV1,
  "status" | "sourceScope" | "logicalName"
>>(
  instances: readonly T[],
  policy: PolicyV1,
  instanceIdOf: (instance: T) => string,
): PolicyComparison {
  const normalized = normalizePolicy(policy);
  const effective = effectiveInstances(instances);
  const allowed = normalized.allowedScopes;
  const forbiddenScopes = new Set(normalized.forbiddenScopes ?? []);
  const forbiddenNames = new Set(normalized.forbiddenNames ?? []);
  const findings: FindingV1[] = [];
  const violating = new Set<string>();

  for (const inst of effective) {
    const id = instanceIdOf(inst);
    if (forbiddenScopes.has(inst.sourceScope)) {
      findings.push(
        normalizeFinding({
          id: "SCOPE_LEAK",
          sourceScope: inst.sourceScope,
          detail:
            `scope ${inst.sourceScope} is forbidden by policy but skill ` +
            `'${inst.logicalName}' (${id}) is ELIGIBLE`,
          instanceIds: [id],
        }),
      );
      violating.add(id);
    } else if (allowed !== undefined && !allowed.includes(inst.sourceScope)) {
      findings.push(
        normalizeFinding({
          id: "SCOPE_LEAK",
          sourceScope: inst.sourceScope,
          detail:
            `scope ${inst.sourceScope} is not in the policy allow-list but skill ` +
            `'${inst.logicalName}' (${id}) is ELIGIBLE`,
          instanceIds: [id],
        }),
      );
      violating.add(id);
    }
    if (forbiddenNames.has(inst.logicalName)) {
      findings.push(
        normalizeFinding({
          id: "DISABLE_MISMATCH",
          sourceScope: inst.sourceScope,
          detail:
            `skill '${inst.logicalName}' (${id}) is expected disabled by policy ` +
            `but is ELIGIBLE`,
          instanceIds: [id],
        }),
      );
      violating.add(id);
    }
  }

  const expectedInstanceIds = effective
    .map((inst) => instanceIdOf(inst))
    .filter((id) => !violating.has(id))
    .sort();

  return {
    policy: normalized,
    effectiveCount: effective.length,
    expectedCount: expectedInstanceIds.length,
    expectedInstanceIds,
    findings: dedupeFindings(findings),
  };
}
