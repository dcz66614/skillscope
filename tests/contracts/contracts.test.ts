import { describe, expect, it } from "vitest";
import {
  AUDIT_STATUSES,
  isDistinctInstance,
  isSkillInstanceV1,
  isSourceRootV1,
  validateSkillInstance,
  validateSourceRoot,
  type SkillInstanceV1,
  type SourceRootV1,
} from "../../src/contracts/index.js";

function validInstance(overrides: Partial<SkillInstanceV1> = {}): SkillInstanceV1 {
  return {
    instanceId: "repo:release",
    engine: "codex",
    sourceRootId: "repo",
    sourceScope: "REPO",
    relativePath: "release/SKILL.md",
    canonicalPathHash: "a".repeat(64),
    logicalName: "release",
    folderName: "release",
    contentSha256: "b".repeat(64),
    status: "DISCOVERED",
    evidenceLevel: "STATIC_RULE",
    ...overrides,
  };
}

function validSourceRoot(overrides: Partial<SourceRootV1> = {}): SourceRootV1 {
  return {
    sourceRootId: "repo",
    engine: "codex",
    scope: "REPO",
    path: ".agents/skills",
    required: true,
    evidenceLevel: "STATIC_RULE",
    ...overrides,
  };
}

describe("contracts: SkillInstanceV1", () => {
  it("accepts a well-formed instance", () => {
    expect(validateSkillInstance(validInstance())).toEqual([]);
    expect(isSkillInstanceV1(validInstance())).toBe(true);
  });

  it("treats same logical name at different canonical paths as distinct instances", () => {
    const a = validInstance({ canonicalPathHash: "a".repeat(64) });
    const b = validInstance({
      sourceRootId: "user",
      relativePath: "release/SKILL.md",
      canonicalPathHash: "c".repeat(64),
    });
    expect(a.logicalName).toBe(b.logicalName);
    expect(isSkillInstanceV1(a)).toBe(true);
    expect(isSkillInstanceV1(b)).toBe(true);
    expect(isDistinctInstance(a, b)).toBe(true);
    expect(isDistinctInstance(a, { ...a })).toBe(false);
  });

  it("rejects a missing contentSha256", () => {
    const bad = validInstance();
    delete (bad as Partial<SkillInstanceV1>).contentSha256;
    const errors = validateSkillInstance(bad);
    expect(errors.some((e) => e.includes("contentSha256"))).toBe(true);
    expect(isSkillInstanceV1(bad)).toBe(false);
  });

  it("rejects a non-SHA-256 content hash", () => {
    const errors = validateSkillInstance(validInstance({ contentSha256: "not-a-hash" }));
    expect(errors.some((e) => e.includes("contentSha256"))).toBe(true);
  });

  it("rejects an unknown status value", () => {
    const errors = validateSkillInstance(
      validInstance({ status: "ACTIVE" as SkillInstanceV1["status"] }),
    );
    expect(errors.some((e) => e.includes("status"))).toBe(true);
  });

  it("rejects a non-object", () => {
    expect(validateSkillInstance("release")).toHaveLength(1);
    expect(validateSkillInstance(null)).toHaveLength(1);
  });
});

describe("contracts: SourceRootV1", () => {
  it("accepts a well-formed source root", () => {
    expect(validateSourceRoot(validSourceRoot())).toEqual([]);
    expect(isSourceRootV1(validSourceRoot())).toBe(true);
  });

  it("rejects an unknown engine", () => {
    const errors = validateSourceRoot(
      validSourceRoot({ engine: "cursor" as SourceRootV1["engine"] }),
    );
    expect(errors.some((e) => e.includes("engine"))).toBe(true);
  });

  it("rejects a non-boolean required flag", () => {
    const errors = validateSourceRoot(
      validSourceRoot({ required: "yes" as unknown as boolean }),
    );
    expect(errors.some((e) => e.includes("required"))).toBe(true);
  });
});

describe("contracts: AuditStatus", () => {
  it("defines exactly PASS, FAIL and INCOMPLETE", () => {
    expect([...AUDIT_STATUSES].sort()).toEqual(["FAIL", "INCOMPLETE", "PASS"]);
  });
});
