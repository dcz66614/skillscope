/**
 * Policy schema and comparison tests (P023 T006, S1).
 *
 * Covers src/policy: validatePolicy / normalizePolicy, and
 * comparePolicy — SCOPE_LEAK (forbidden scope and allow-list),
 * DISABLE_MISMATCH (expected-disabled but still loaded), the ELIGIBLE-
 * only effective set (DISCOVERED / DISABLED instances never leak or
 * mismatch), and exact logical-name matching (plugin namespaces are
 * never flattened: `deploy` does not match `acme:deploy`).
 */
import { describe, expect, it } from "vitest";
import {
  comparePolicy,
  effectiveInstances,
  normalizePolicy,
  validatePolicy,
  type PolicyV1,
} from "../../src/policy/index.js";

type MiniInstance = {
  status: "ELIGIBLE" | "DISABLED" | "DISCOVERED" | "INVALID" | "UNKNOWN";
  sourceScope: string;
  logicalName: string;
};

const idOf = (inst: MiniInstance): string =>
  `${inst.sourceScope}:${inst.logicalName}`;

function inst(
  logicalName: string,
  sourceScope: string,
  status: MiniInstance["status"] = "ELIGIBLE",
): MiniInstance {
  return { status, sourceScope, logicalName };
}

describe("validatePolicy / normalizePolicy", () => {
  it("accepts an empty policy and a full policy", () => {
    expect(validatePolicy({})).toEqual([]);
    expect(
      validatePolicy({
        allowedScopes: ["PROJECT", "PERSONAL"],
        forbiddenScopes: ["ENTERPRISE"],
        forbiddenNames: ["deploy"],
      }),
    ).toEqual([]);
  });

  it("rejects a non-object policy", () => {
    expect(validatePolicy(null)).toEqual(["policy must be an object"]);
    expect(validatePolicy("forbid everything")).toEqual([
      "policy must be an object",
    ]);
    expect(validatePolicy(["PROJECT"])).toEqual(["policy must be an object"]);
  });

  it("rejects a list field that is not an array, and empty-string entries", () => {
    expect(validatePolicy({ forbiddenScopes: "ENTERPRISE" })).toEqual([
      "forbiddenScopes must be an array of strings",
    ]);
    expect(validatePolicy({ forbiddenNames: ["deploy", ""] })).toEqual([
      "forbiddenNames must contain only non-empty strings",
    ]);
  });

  it("rejects a scope that is both allowed and forbidden", () => {
    expect(
      validatePolicy({
        allowedScopes: ["PROJECT", "NESTED"],
        forbiddenScopes: ["NESTED"],
      }),
    ).toEqual(["scope \"NESTED\" is both allowed and forbidden"]);
  });

  it("normalises by sorting and deduplicating, and drops empty lists", () => {
    expect(
      normalizePolicy({
        forbiddenScopes: ["PLUGIN", "ENTERPRISE", "PLUGIN"],
        forbiddenNames: ["deploy"],
        allowedScopes: [],
      }),
    ).toEqual({
      forbiddenScopes: ["ENTERPRISE", "PLUGIN"],
      forbiddenNames: ["deploy"],
    });
  });

  it("normalizePolicy throws on an invalid policy", () => {
    expect(() =>
      normalizePolicy({ allowedScopes: ["A"], forbiddenScopes: ["A"] }),
    ).toThrow(/both allowed and forbidden/);
  });
});

describe("effectiveInstances", () => {
  it("keeps ELIGIBLE only", () => {
    const all = [
      inst("a", "PROJECT", "ELIGIBLE"),
      inst("b", "PROJECT", "DISABLED"),
      inst("c", "PROJECT", "DISCOVERED"),
      inst("d", "PROJECT", "INVALID"),
      inst("e", "PROJECT", "UNKNOWN"),
    ];
    expect(effectiveInstances(all).map((i) => i.logicalName)).toEqual(["a"]);
  });
});

describe("comparePolicy — SCOPE_LEAK", () => {
  it("emits one SCOPE_LEAK per ELIGIBLE instance in a forbidden scope", () => {
    const instances = [
      inst("release", "PROJECT"),
      inst("every-docs", "SHARED_LIBRARY"),
      inst("notes", "PERSONAL"),
    ];
    const result = comparePolicy(
      instances,
      { forbiddenScopes: ["SHARED_LIBRARY"] },
      idOf,
    );
    expect(result.findings.map((f) => f.id)).toEqual(["SCOPE_LEAK"]);
    expect(result.findings[0]?.sourceScope).toBe("SHARED_LIBRARY");
    expect(result.findings[0]?.instanceIds).toEqual([
      "SHARED_LIBRARY:every-docs",
    ]);
    expect(result.effectiveCount).toBe(3);
    expect(result.expectedCount).toBe(2);
    expect(result.expectedInstanceIds).toEqual([
      "PERSONAL:notes",
      "PROJECT:release",
    ]);
  });

  it("emits SCOPE_LEAK for scopes outside the allow-list", () => {
    const instances = [inst("release", "PROJECT"), inst("admin", "ENTERPRISE")];
    const result = comparePolicy(
      instances,
      { allowedScopes: ["PROJECT"] },
      idOf,
    );
    expect(result.findings.map((f) => f.id)).toEqual(["SCOPE_LEAK"]);
    expect(result.findings[0]?.sourceScope).toBe("ENTERPRISE");
    expect(result.expectedCount).toBe(1);
  });

  it("a DISCOVERED instance in a forbidden scope does NOT leak (not loadable)", () => {
    const instances = [
      inst("every-docs", "SHARED_LIBRARY", "DISCOVERED"),
      inst("release", "BOT_ASSIGNED"),
    ];
    const result = comparePolicy(
      instances,
      { forbiddenScopes: ["SHARED_LIBRARY"] },
      idOf,
    );
    expect(result.findings).toEqual([]);
    expect(result.effectiveCount).toBe(1);
    expect(result.expectedCount).toBe(1);
  });

  it("a DISABLED instance in a forbidden scope does NOT leak", () => {
    const instances = [
      inst("every-docs", "SHARED_LIBRARY", "DISABLED"),
      inst("release", "BOT_ASSIGNED"),
    ];
    const result = comparePolicy(
      instances,
      { forbiddenScopes: ["SHARED_LIBRARY"] },
      idOf,
    );
    expect(result.findings).toEqual([]);
  });

  it("an empty policy produces no findings and the expected set equals the effective set", () => {
    const instances = [inst("a", "PROJECT"), inst("b", "ENTERPRISE")];
    const result = comparePolicy(instances, {}, idOf);
    expect(result.findings).toEqual([]);
    expect(result.effectiveCount).toBe(2);
    expect(result.expectedCount).toBe(2);
  });
});

describe("comparePolicy — DISABLE_MISMATCH", () => {
  it("emits DISABLE_MISMATCH for an ELIGIBLE instance whose name is forbidden", () => {
    const instances = [inst("deploy", "PROJECT"), inst("release", "PROJECT")];
    const result = comparePolicy(
      instances,
      { forbiddenNames: ["deploy"] },
      idOf,
    );
    expect(result.findings.map((f) => f.id)).toEqual(["DISABLE_MISMATCH"]);
    expect(result.findings[0]?.severity).toBe("P1");
    expect(result.findings[0]?.instanceIds).toEqual(["PROJECT:deploy"]);
    expect(result.expectedCount).toBe(1);
  });

  it("a DISABLED instance with a forbidden name does NOT mismatch (correctly closed)", () => {
    const instances = [
      inst("deploy", "PROJECT", "DISABLED"),
      inst("release", "PROJECT"),
    ];
    const result = comparePolicy(
      instances,
      { forbiddenNames: ["deploy"] },
      idOf,
    );
    expect(result.findings).toEqual([]);
    expect(result.expectedCount).toBe(1);
  });

  it("a DISCOVERED instance with a forbidden name does NOT mismatch (not loaded)", () => {
    const instances = [
      inst("deploy", "SHARED_LIBRARY", "DISCOVERED"),
      inst("release", "PROJECT"),
    ];
    const result = comparePolicy(
      instances,
      { forbiddenNames: ["deploy"] },
      idOf,
    );
    expect(result.findings).toEqual([]);
  });

  it("names are matched exactly: 'deploy' does not match 'acme:deploy'", () => {
    const instances = [
      inst("deploy", "PROJECT"),
      inst("acme:deploy", "PLUGIN"),
    ];
    const bare = comparePolicy(instances, { forbiddenNames: ["deploy"] }, idOf);
    expect(bare.findings.map((f) => f.instanceIds)).toEqual([
      ["PROJECT:deploy"],
    ]);
    const namespaced = comparePolicy(
      instances,
      { forbiddenNames: ["acme:deploy"] },
      idOf,
    );
    expect(namespaced.findings.map((f) => f.instanceIds)).toEqual([
      ["PLUGIN:acme:deploy"],
    ]);
  });

  it("one instance violating both scope and name yields both findings but counts once in the expected set", () => {
    const instances = [inst("deploy", "ENTERPRISE"), inst("release", "PROJECT")];
    const result = comparePolicy(
      instances,
      { forbiddenScopes: ["ENTERPRISE"], forbiddenNames: ["deploy"] },
      idOf,
    );
    expect(result.findings.map((f) => f.id).sort()).toEqual([
      "DISABLE_MISMATCH",
      "SCOPE_LEAK",
    ]);
    expect(result.findings).toHaveLength(2);
    expect(result.effectiveCount).toBe(2);
    expect(result.expectedCount).toBe(1);
  });

  it("comparePolicy throws on an invalid policy", () => {
    expect(() =>
      comparePolicy([inst("a", "PROJECT")], {
        allowedScopes: ["X"],
        forbiddenScopes: ["X"],
      } as PolicyV1, idOf),
    ).toThrow(/both allowed and forbidden/);
  });
});
