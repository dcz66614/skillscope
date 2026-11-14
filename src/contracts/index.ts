/**
 * SkillScope core data contracts (frozen by T001, IMPLEMENTATION_PLAN §4).
 *
 * Sources: PROJECT_BOOK.md §4 (rules model) and §6 (data structures),
 * IMPLEMENTATION_PLAN.md §4 (interface contracts).
 *
 * Identity rule (PROJECT_BOOK §4.2): a skill instance is identified by its
 * canonical path + content hash, NEVER by logical name alone. Two files with
 * the same logical name at different canonical paths are two instances.
 */

export type EngineId = "codex" | "claude-code" | "openmausbot";

export type EvidenceLevel = "STATIC_RULE" | "HOST_SNAPSHOT" | "RUNTIME_OBSERVED";

export type SkillStatus =
  | "DISCOVERED"
  | "ELIGIBLE"
  | "DISABLED"
  | "UNKNOWN"
  | "INVALID";

export type AuditStatus = "PASS" | "FAIL" | "INCOMPLETE";

export const ENGINES: readonly EngineId[] = ["codex", "claude-code", "openmausbot"];

export const EVIDENCE_LEVELS: readonly EvidenceLevel[] = [
  "STATIC_RULE",
  "HOST_SNAPSHOT",
  "RUNTIME_OBSERVED",
];

export const SKILL_STATUSES: readonly SkillStatus[] = [
  "DISCOVERED",
  "ELIGIBLE",
  "DISABLED",
  "UNKNOWN",
  "INVALID",
];

export const AUDIT_STATUSES: readonly AuditStatus[] = ["PASS", "FAIL", "INCOMPLETE"];

/** A skill source root: one place a host may discover skills from. */
export interface SourceRootV1 {
  sourceRootId: string;
  engine: EngineId;
  scope: string;
  path: string;
  required: boolean;
  evidenceLevel: EvidenceLevel;
}

/**
 * One concrete SKILL.md file at a specific source path.
 * `instanceId` is derived from source root + canonical path identity, never
 * from `logicalName` alone (see `isDistinctInstance`).
 */
export interface SkillInstanceV1 {
  instanceId: string;
  engine: EngineId;
  botId?: string;
  sourceRootId: string;
  sourceScope: string;
  relativePath: string;
  canonicalPathHash: string;
  logicalName: string;
  folderName: string;
  manifestName?: string;
  contentSha256: string;
  status: SkillStatus;
  evidenceLevel: EvidenceLevel;
}

/** Minimal audit profile shape (PROJECT_BOOK §6.1); policy detail lands in T006. */
export interface ProfileV1 {
  schema: "skillscope.profile/v1";
  profile_id: string;
  engine: EngineId;
  cwd: string;
  repo_root: string;
  home_root: string;
  source_roots: SourceRootV1[];
  policy: {
    allowed_scopes: string[];
    forbidden_names: string[];
  };
}

/** Minimal audit report shape (PROJECT_BOOK §6.3); findings detail lands in T006/T008. */
export interface ReportV1 {
  schema: "skillscope.report/v1";
  profile_id: string;
  status: AuditStatus;
  expected_count: number;
  observed_count: number | null;
  coverage: {
    enumerated_sources: number;
    required_sources: number;
  };
  findings: Array<{
    id: string;
    severity: string;
    source_scope: string;
    status: string;
  }>;
  inventory_sha256: string | null;
  oracle_result_sha256: string | null;
  audit_sha256: string | null;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function checkEnum<T extends string>(
  value: unknown,
  allowed: readonly T[],
  field: string,
  errors: string[],
): void {
  if (typeof value !== "string" || !(allowed as readonly string[]).includes(value)) {
    errors.push(`${field} must be one of ${allowed.join(", ")}`);
  }
}

/**
 * Validate a SourceRootV1-shaped value. Returns a list of problems;
 * an empty list means the value satisfies the contract.
 */
export function validateSourceRoot(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["source root must be an object"];
  }
  const root = value as Record<string, unknown>;
  if (!isNonEmptyString(root["sourceRootId"])) {
    errors.push("sourceRootId must be a non-empty string");
  }
  checkEnum(root["engine"], ENGINES, "engine", errors);
  if (!isNonEmptyString(root["scope"])) {
    errors.push("scope must be a non-empty string");
  }
  if (!isNonEmptyString(root["path"])) {
    errors.push("path must be a non-empty string");
  }
  if (typeof root["required"] !== "boolean") {
    errors.push("required must be a boolean");
  }
  checkEnum(root["evidenceLevel"], EVIDENCE_LEVELS, "evidenceLevel", errors);
  return errors;
}

/**
 * Validate a SkillInstanceV1-shaped value. Returns a list of problems;
 * an empty list means the value satisfies the contract.
 */
export function validateSkillInstance(value: unknown): string[] {
  const errors: string[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return ["skill instance must be an object"];
  }
  const inst = value as Record<string, unknown>;
  if (!isNonEmptyString(inst["instanceId"])) {
    errors.push("instanceId must be a non-empty string");
  }
  checkEnum(inst["engine"], ENGINES, "engine", errors);
  if (inst["botId"] !== undefined && !isNonEmptyString(inst["botId"])) {
    errors.push("botId must be a non-empty string when present");
  }
  if (!isNonEmptyString(inst["sourceRootId"])) {
    errors.push("sourceRootId must be a non-empty string");
  }
  if (!isNonEmptyString(inst["sourceScope"])) {
    errors.push("sourceScope must be a non-empty string");
  }
  if (!isNonEmptyString(inst["relativePath"])) {
    errors.push("relativePath must be a non-empty string");
  }
  if (
    typeof inst["canonicalPathHash"] !== "string" ||
    !SHA256_HEX.test(inst["canonicalPathHash"])
  ) {
    errors.push("canonicalPathHash must be a lowercase 64-char hex SHA-256");
  }
  if (!isNonEmptyString(inst["logicalName"])) {
    errors.push("logicalName must be a non-empty string");
  }
  if (!isNonEmptyString(inst["folderName"])) {
    errors.push("folderName must be a non-empty string");
  }
  if (inst["manifestName"] !== undefined && !isNonEmptyString(inst["manifestName"])) {
    errors.push("manifestName must be a non-empty string when present");
  }
  if (typeof inst["contentSha256"] !== "string" || !SHA256_HEX.test(inst["contentSha256"])) {
    errors.push("contentSha256 must be a lowercase 64-char hex SHA-256");
  }
  checkEnum(inst["status"], SKILL_STATUSES, "status", errors);
  checkEnum(inst["evidenceLevel"], EVIDENCE_LEVELS, "evidenceLevel", errors);
  return errors;
}

export function isSkillInstanceV1(value: unknown): value is SkillInstanceV1 {
  return validateSkillInstance(value).length === 0;
}

export function isSourceRootV1(value: unknown): value is SourceRootV1 {
  return validateSourceRoot(value).length === 0;
}

/**
 * Identity rule: two instances are distinct when their canonical path
 * identity differs, even if their logical names are equal. Same canonical
 * path hash + same source root means the same instance.
 */
export function isDistinctInstance(a: SkillInstanceV1, b: SkillInstanceV1): boolean {
  return a.sourceRootId !== b.sourceRootId || a.canonicalPathHash !== b.canonicalPathHash;
}
