/**
 * Property tests for the frozen kernel (T011).
 *
 * Every case stream is replayed from the frozen S0 seed
 * (P023-SKILLSCOPE-S0-2026-11-13) unless --seed overrides it
 * (scripts/property-test.mjs; the seed is carried in the
 * SKILLSCOPE_PROPERTY_SEED environment variable): the PRNG in ./seed.ts
 * is deterministic,
 * so the same seed always generates the same cases and the same verdicts.
 * No Date, no Math.random, no environment input anywhere in this file.
 *
 * What these tests pin (each is a stated rule from PROJECT_BOOK §4):
 *  P1  canonical JSON is key-order independent, NFC-normalised, -0 == 0.
 *  P2  compareCodePoints is a total order on code points (not UTF-16 units).
 *  P3  the identity registry matches an independent brute-force model.
 *  P4  policy comparison is monotone in the forbidden sets and exact on
 *      names (ADR-005/ADR-006: effective set = ELIGIBLE only; a name
 *      matches only its exact logical name, namespace included).
 *  P5  the findings algebra is idempotent and sorted; the status
 *      precedence INCOMPLETE > FAIL > PASS matches the §4.1 transcription.
 *  P6  the resolver is deterministic: same input, same canonical bytes.
 *  P7  unknown sources / UNKNOWN findings force INCOMPLETE; a lone P1
 *      CONFIRMED finding forces FAIL, never INCOMPLETE.
 *  P8  the effective set is exactly the ELIGIBLE instances (ADR-006).
 *  P9  the whole case stream replays byte-identically from the seed.
 *  P10 policy normalisation is idempotent, sorted and deduplicated, and
 *      invalid policies are rejected (not silently repaired).
 */

import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { canonicalizeJson, canonicalSha256, compareCodePoints } from "../../src/canonical/index.js";
import { FINDING_CATALOG, dedupeFindings, deriveAuditStatus, normalizeFinding, sortFindings } from "../../src/findings/index.js";
import type { FindingV1 } from "../../src/findings/index.js";
import { IdentityRegistry, computeInstanceId, identityKey } from "../../src/identity/identity.js";
import type { RegistryInput } from "../../src/identity/identity.js";
import { comparePolicy, effectiveInstances, normalizePolicy, validatePolicy } from "../../src/policy/index.js";
import type { PolicyV1 } from "../../src/policy/index.js";
import { resolveCodexAudit } from "../../src/resolver/index.js";
import type { CodexPocResult, CodexPocSkill } from "../../src/adapters/codex/codex-poc.js";
import { PROPERTY_SEED, Rng, randomJson, randomString } from "./seed.js";

const CASES = 150;

function sha256(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

// ---------------------------------------------------------------- P1: canonical

describe("P1 canonical JSON", () => {
  it("is deterministic, key-order independent, NFC-normalised and -0-insensitive", () => {
    const rng = new Rng(PROPERTY_SEED);
    for (let i = 0; i < CASES; i++) {
      const value = randomJson(rng);
      const a = canonicalizeJson(value);
      const b = canonicalizeJson(value);
      expect(a).toBe(b);
      // Re-serialising the parsed form is stable.
      expect(canonicalizeJson(JSON.parse(a))).toBe(a);
      // Key order must not matter: rebuild objects with shuffled keys.
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        const keys = Object.keys(value);
        const shuffled: Record<string, unknown> = {};
        for (const k of rng.shuffled(keys)) shuffled[k] = (value as Record<string, unknown>)[k];
        expect(canonicalizeJson(shuffled)).toBe(a);
      }
      // Hash is stable too.
      expect(canonicalSha256(value)).toBe(canonicalSha256(value));
    }
    // NFC: decomposed and precomposed forms hash identically.
    expect(canonicalSha256("e\u0301")).toBe(canonicalSha256("\u00e9"));
    expect(canonicalizeJson({ k: "e\u0301" })).toBe(canonicalizeJson({ k: "\u00e9" }));
    // -0 serialises as 0.
    expect(canonicalizeJson(-0)).toBe("0");
    expect(canonicalSha256(-0)).toBe(canonicalSha256(0));
  });
});

// ------------------------------------------------------- P2: code-point order

describe("P2 compareCodePoints", () => {
  it("is a total order on code points, not UTF-16 code units", () => {
    const rng = new Rng(PROPERTY_SEED);
    const strings: string[] = [];
    for (let i = 0; i < 60; i++) strings.push(randomString(rng));
    // Antisymmetry + reflexivity.
    for (const a of strings) {
      expect(compareCodePoints(a, a)).toBe(0);
      for (const b of strings) {
        const ab = compareCodePoints(a, b);
        const ba = compareCodePoints(b, a);
        // Math.sign(0) is +0 and -Math.sign(0) is -0, which toBe (Object.is)
        // treats as different; compare with ===, which treats them as equal.
        expect(Math.sign(ab) === -Math.sign(ba)).toBe(true);
        expect(ab === 0).toBe(a === b);
      }
    }
    // Transitivity on random triples.
    for (let i = 0; i < 200; i++) {
      const [a, b, c] = [rng.pick(strings), rng.pick(strings), rng.pick(strings)];
      if (compareCodePoints(a, b) <= 0 && compareCodePoints(b, c) <= 0) {
        expect(compareCodePoints(a, c)).toBeLessThanOrEqual(0);
      }
    }
    // Agrees with the code-point sequence, not the UTF-16 sequence:
    // U+10000 (lead surrogate D800) sorts AFTER U+FFFF in code points,
    // but BEFORE it in UTF-16 code units.
    expect(compareCodePoints("\u{10000}", "\uFFFF")).toBeGreaterThan(0);
    expect("\u{10000}" < "\uFFFF").toBe(true); // UTF-16 order disagrees
    // Sorting by compareCodePoints equals sorting by code-point arrays.
    const sorted = [...strings].sort(compareCodePoints);
    const byPoints = [...strings].sort((x, y) => {
      const px = [...x];
      const py = [...y];
      for (let i = 0; i < Math.min(px.length, py.length); i++) {
        const d = px[i]!.codePointAt(0)! - py[i]!.codePointAt(0)!;
        if (d !== 0) return d;
      }
      return px.length - py.length;
    });
    expect(sorted).toEqual(byPoints);
  });
});

// ------------------------------------------------------- P3: identity registry

const REG_SCOPES = ["REPO", "USER", "ADMIN", "PLUGIN"];
const REG_NAMES = ["deploy", "notes", "acme:deploy", "helper", "docs"];
const REG_CONTENTS = ["aaa", "bbb", "ccc"];

function randomRegistryInput(rng: Rng, i: number): RegistryInput {
  const root = rng.pick(["repo", "user", "plugin"]);
  const name = rng.pick(REG_NAMES);
  return {
    engine: "codex",
    sourceRootId: root,
    sourceScope: rng.pick(REG_SCOPES),
    relativePath: `${name.replace(":", "-")}-${i % 3}/SKILL.md`,
    canonicalPath: `/x/${root}/${name.replace(":", "-")}-${i % 2}/SKILL.md`,
    logicalName: name,
    folderName: name,
    contentSha256: sha256(rng.pick(REG_CONTENTS)),
    status: "ELIGIBLE",
    evidenceLevel: "STATIC_RULE",
  };
}

describe("P3 identity registry vs brute-force model", () => {
  it("size, collisions, duplicate groups, alias merge and sort order all match the model", () => {
    const rng = new Rng(PROPERTY_SEED);
    for (let round = 0; round < 80; round++) {
      const n = rng.int(0, 12);
      const inputs: RegistryInput[] = [];
      for (let i = 0; i < n; i++) inputs.push(randomRegistryInput(rng, i));
      // Feed in sorted traversal order so the primary path is deterministic.
      const sorted = [...inputs].sort((a, b) =>
        a.sourceRootId.localeCompare(b.sourceRootId) ||
        a.canonicalPath.localeCompare(b.canonicalPath) ||
        a.relativePath.localeCompare(b.relativePath));
      const registry = new IdentityRegistry();
      for (const input of sorted) registry.register(input);

      // Model: distinct identity keys.
      const keys = new Set(sorted.map((i) => identityKey(i.sourceRootId, i.canonicalPath)));
      expect(registry.size).toBe(keys.size);

      const instances = registry.instances();
      expect(instances).toHaveLength(keys.size);
      // Sorted by (sourceRootId, relativePath, logicalName).
      const sortedInstances = [...instances].sort((a, b) =>
        (a.sourceRootId < b.sourceRootId ? -1 : a.sourceRootId > b.sourceRootId ? 1 : 0) ||
        (a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0) ||
        (a.logicalName < b.logicalName ? -1 : a.logicalName > b.logicalName ? 1 : 0));
      expect(instances).toEqual(sortedInstances);

      // Alias merge: for each key, primary is the first relativePath in
      // traversal order and aliases are the remaining paths, sorted.
      // (Registered instances carry only the canonical-path hash, so the
      // key is recovered through computeInstanceId, the same function the
      // registry uses.)
      const byKey = new Map<string, string[]>();
      const keyById = new Map<string, string>();
      for (const input of sorted) {
        const k = identityKey(input.sourceRootId, input.canonicalPath);
        keyById.set(computeInstanceId(input.engine, input.sourceRootId, input.canonicalPath), k);
        const paths = byKey.get(k) ?? [];
        if (!paths.includes(input.relativePath)) paths.push(input.relativePath);
        byKey.set(k, paths);
      }
      for (const inst of instances) {
        const paths = byKey.get(keyById.get(inst.instanceId)!)!;
        expect(inst.relativePath).toBe(paths[0]);
        expect(inst.aliases).toEqual(paths.slice(1).sort());
      }

      // Same-name collisions: brute force over registered instances.
      const byName = new Map<string, string[]>();
      for (const inst of instances) {
        byName.set(inst.logicalName, [...(byName.get(inst.logicalName) ?? []), inst.instanceId]);
      }
      const expectedCollisions = [...byName.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([logicalName, instanceIds]) => ({ logicalName, instanceIds: [...instanceIds].sort() }))
        .sort((a, b) => (a.logicalName < b.logicalName ? -1 : 1));
      expect(registry.sameNameCollisions()).toEqual(expectedCollisions);

      // Duplicate content groups: brute force over registered instances.
      const byContent = new Map<string, string[]>();
      for (const inst of instances) {
        byContent.set(inst.contentSha256, [...(byContent.get(inst.contentSha256) ?? []), inst.instanceId]);
      }
      const expectedDupes = [...byContent.entries()]
        .filter(([, ids]) => ids.length > 1)
        .map(([contentSha256, instanceIds]) => ({ contentSha256, instanceIds: [...instanceIds].sort() }))
        .sort((a, b) => (a.contentSha256 < b.contentSha256 ? -1 : 1));
      expect(registry.duplicateContentGroups()).toEqual(expectedDupes);
    }
  });
});

// ------------------------------------------------------------------ P4: policy

const POLICY_SCOPES = ["REPO", "USER", "ADMIN", "SYSTEM", "PLUGIN", "ENTERPRISE"];
const POLICY_NAMES = ["deploy", "notes", "acme:deploy", "acme", "helper", "release"];
const POLICY_STATUSES = ["ELIGIBLE", "DISABLED", "DISCOVERED", "INVALID", "UNKNOWN"] as const;

type TestInstance = { status: (typeof POLICY_STATUSES)[number]; sourceScope: string; logicalName: string; id: string };

function randomTestInstances(rng: Rng): TestInstance[] {
  const n = rng.int(0, 8);
  return Array.from({ length: n }, (_, i) => ({
    status: rng.pick(POLICY_STATUSES),
    sourceScope: rng.pick(POLICY_SCOPES),
    logicalName: rng.pick(POLICY_NAMES),
    id: `inst-${i}`,
  }));
}

function randomPolicy(rng: Rng): PolicyV1 {
  const forbiddenScopes = rng.subset(POLICY_SCOPES);
  const allowedScopes = rng.bool(0.4)
    ? rng.subset(POLICY_SCOPES.filter((s) => !forbiddenScopes.includes(s)))
    : undefined;
  return {
    ...(allowedScopes !== undefined ? { allowedScopes } : {}),
    ...(forbiddenScopes.length > 0 ? { forbiddenScopes } : {}),
    ...(rng.bool(0.7) ? { forbiddenNames: rng.subset(POLICY_NAMES) } : {}),
  };
}

describe("P4 policy comparison", () => {
  it("is monotone in the forbidden sets, exact on names, and only ever touches ELIGIBLE instances", () => {
    const rng = new Rng(PROPERTY_SEED);
    for (let i = 0; i < CASES; i++) {
      const instances = randomTestInstances(rng);
      const policy = randomPolicy(rng);
      const base = comparePolicy(instances, policy, (inst) => inst.id);
      const byId = new Map(instances.map((inst) => [inst.id, inst]));

      // Every finding names exactly one ELIGIBLE instance.
      for (const f of base.findings) {
        expect(f.instanceIds).toHaveLength(1);
        const target = byId.get(f.instanceIds[0]!)!;
        expect(target.status).toBe("ELIGIBLE");
      }
      // At most one SCOPE_LEAK per instance (the allow-list branch is an
      // else-if, never a second finding for the same instance).
      const leakCounts = new Map<string, number>();
      for (const f of base.findings) {
        if (f.id === "SCOPE_LEAK") {
          leakCounts.set(f.instanceIds[0]!, (leakCounts.get(f.instanceIds[0]!) ?? 0) + 1);
        }
      }
      for (const count of leakCounts.values()) expect(count).toBe(1);
      // DISABLE_MISMATCH only on an exact logical-name match.
      const forbiddenNames = new Set(policy.forbiddenNames ?? []);
      for (const f of base.findings) {
        if (f.id === "DISABLE_MISMATCH") {
          expect(forbiddenNames.has(byId.get(f.instanceIds[0]!)!.logicalName)).toBe(true);
        }
      }
      // Count consistency: violationCount is the finding count (resolver
      // convention), expected = effective minus distinct violating ids.
      const violatingIds = new Set(base.findings.flatMap((f) => f.instanceIds));
      expect(base.expectedCount).toBe(base.effectiveCount - violatingIds.size);
      expect(base.effectiveCount).toBe(instances.filter((x) => x.status === "ELIGIBLE").length);

      // Monotonicity: forbidding one more scope never removes a finding.
      // (The widened scope is chosen outside both lists, so the widened
      // policy stays valid — a scope cannot be both allowed and forbidden —
      // and the allow-list is untouched. If every scope is already covered,
      // the check is skipped for this iteration.)
      const freeScopes = POLICY_SCOPES.filter(
        (s) => !(policy.allowedScopes ?? []).includes(s) && !(policy.forbiddenScopes ?? []).includes(s),
      );
      if (freeScopes.length > 0) {
        const extraScope = rng.pick(freeScopes);
        const wider = comparePolicy(
          instances,
          { ...policy, forbiddenScopes: [...(policy.forbiddenScopes ?? []), extraScope] },
          (inst) => inst.id,
        );
        expect(wider.findings.length).toBeGreaterThanOrEqual(base.findings.length);
      }
      // Monotonicity: forbidding one more name never removes a finding.
      const extraName = rng.pick(POLICY_NAMES);
      const widerNames = comparePolicy(
        instances,
        { ...policy, forbiddenNames: [...(policy.forbiddenNames ?? []), extraName] },
        (inst) => inst.id,
      );
      expect(widerNames.findings.length).toBeGreaterThanOrEqual(base.findings.length);
      // An empty policy produces no findings and keeps the whole effective set.
      const empty = comparePolicy(instances, {}, (inst) => inst.id);
      expect(empty.findings).toEqual([]);
      expect(empty.expectedCount).toBe(empty.effectiveCount);
    }
  });
});

// ------------------------------------------------------------ P5: findings algebra

const FINDING_IDS = Object.keys(FINDING_CATALOG) as (keyof typeof FINDING_CATALOG)[];

interface RandomFindingInput {
  id: string;
  sourceScope: string;
  status?: "CONFIRMED" | "UNKNOWN";
  detail: string;
  instanceIds?: string[];
  affectedCount?: number;
  severity?: "P1" | "P2";
}

function randomFindingInput(rng: Rng, idPool: readonly string[]): RandomFindingInput {
  const id = rng.pick(idPool);
  const input: RandomFindingInput = {
    id,
    sourceScope: rng.pick(POLICY_SCOPES),
    detail: `detail-${rng.int(0, 3)}-${randomString(rng)}`,
  };
  if (rng.bool(0.5)) input.status = rng.pick(["CONFIRMED", "UNKNOWN"]);
  if (rng.bool(0.5)) input.instanceIds = rng.subset(["a:x/SKILL.md", "b:y/SKILL.md"]);
  if (id === "NAME_SELECTOR_BLAST_RADIUS") input.affectedCount = rng.int(1, 5);
  // Half the time, feed the WRONG severity: the catalog must win.
  if (rng.bool(0.5)) {
    input.severity = FINDING_CATALOG[id as keyof typeof FINDING_CATALOG].severity === "P1" ? "P2" : "P1";
  }
  return input;
}

/** Independent transcription of PROJECT_BOOK §4.1 precedence. */
function referenceStatus(findings: readonly FindingV1[], unknownScopes: readonly string[]): string {
  if (unknownScopes.length > 0) return "INCOMPLETE";
  if (findings.some((f) => f.status === "UNKNOWN")) return "INCOMPLETE";
  if (findings.some((f) => f.severity === "P1")) return "FAIL";
  return "PASS";
}

describe("P5 findings algebra", () => {
  it("normalisation is idempotent, dedupe is idempotent and sorted, and status precedence matches §4.1", () => {
    const rng = new Rng(PROPERTY_SEED);
    for (let i = 0; i < CASES; i++) {
      const n = rng.int(0, 6);
      const raw = Array.from({ length: n }, () => randomFindingInput(rng, FINDING_IDS));
      const normalized = raw.map((f) => normalizeFinding(f));
      // Idempotence: normalising a normalised finding changes nothing.
      for (const f of normalized) {
        expect(normalizeFinding(f)).toEqual(f);
      }
      // Severity always comes from the catalog, never from the producer.
      for (let j = 0; j < raw.length; j++) {
        expect(normalized[j]!.severity).toBe(FINDING_CATALOG[raw[j]!.id as keyof typeof FINDING_CATALOG].severity);
      }
      // Dedupe is idempotent and sorted by compareFindings.
      const deduped = dedupeFindings(normalized);
      expect(dedupeFindings(deduped)).toEqual(deduped);
      const sorted = sortFindings(normalized);
      for (let j = 1; j < sorted.length; j++) {
        expect(sortFindings([sorted[j - 1]!, sorted[j]!])[0]).toEqual(sorted[j - 1]);
      }
      expect(new Set(deduped.map((f) => JSON.stringify(f))).size).toBe(deduped.length);
      // Status precedence matches the independent transcription.
      const unknownScopes = rng.bool(0.3) ? [rng.pick(POLICY_SCOPES)] : [];
      expect(deriveAuditStatus(normalized, unknownScopes)).toBe(referenceStatus(normalized, unknownScopes));
    }
    // SOURCE_NOT_ENUMERATED without an explicit status is UNKNOWN.
    expect(normalizeFinding({ id: "SOURCE_NOT_ENUMERATED", sourceScope: "USER", detail: "x" }).status).toBe("UNKNOWN");
    // Any other finding without an explicit status is CONFIRMED.
    expect(normalizeFinding({ id: "SAME_NAME_COLLISION", sourceScope: "GLOBAL", detail: "x" }).status).toBe("CONFIRMED");
    // Unknown ids and empty details throw instead of being silently kept.
    expect(() => normalizeFinding({ id: "NOT_A_FINDING", sourceScope: "GLOBAL", detail: "x" })).toThrow();
    expect(() => normalizeFinding({ id: "SAME_NAME_COLLISION", sourceScope: "GLOBAL", detail: "" })).toThrow();
  });
});

// ------------------------------------------- P6/P7: resolver determinism + unknowns

const CODEX_SCOPES = ["REPO", "USER", "ADMIN", "SYSTEM", "PLUGIN"] as const;
const RANDOM_FINDING_IDS = [
  "SOURCE_NOT_ENUMERATED",
  "NAME_SELECTOR_BLAST_RADIUS",
  "SAME_NAME_COLLISION",
  "FAIL_OPEN_CONFIG",
  "SYMLINK_OUTSIDE_ROOT",
  "DUPLICATE_CONTENT",
  "INVALID_MANIFEST",
  "SYMLINK_ALIAS",
] as const;

function randomCodexResult(rng: Rng, caseId: string): CodexPocResult {
  const n = rng.int(0, 4);
  const skills: CodexPocSkill[] = Array.from({ length: n }, (_, i) => {
    const name = rng.pick(POLICY_NAMES);
    const scope = rng.pick(CODEX_SCOPES);
    return {
      instanceId: `native-${caseId}-${i}`,
      sourceRootId: scope.toLowerCase(),
      sourceScope: scope,
      relativePath: `${name.replace(":", "-")}-${i}/SKILL.md`,
      canonicalPath: `layout/${scope.toLowerCase()}/${name.replace(":", "-")}-${i}/SKILL.md`,
      logicalName: name,
      folderName: name,
      contentSha256: sha256(`content-${rng.pick(REG_CONTENTS)}`),
      canonicalPathHash: sha256(`path-${caseId}-${i}`),
      // Codex PoC statuses: ELIGIBLE | DISABLED | UNKNOWN (no DISCOVERED).
      status: rng.pick(["ELIGIBLE", "DISABLED", "UNKNOWN"] as const),
      aliases: [],
      evidenceLevel: "STATIC_RULE",
    };
  });
  const findings = Array.from({ length: rng.int(0, 3) }, () => {
    const id = rng.pick(RANDOM_FINDING_IDS);
    return {
      id,
      severity: FINDING_CATALOG[id].severity,
      sourceScope: rng.pick(CODEX_SCOPES),
      status: rng.pick(["CONFIRMED", "UNKNOWN"]) as "CONFIRMED" | "UNKNOWN",
      detail: `random ${id} ${rng.int(0, 99)}`,
      ...(id === "NAME_SELECTOR_BLAST_RADIUS" ? { affectedCount: rng.int(2, 4) } : {}),
    };
  });
  const enumerated = rng.int(0, 5);
  return {
    schema: "skillscope.codex-poc-result/v1",
    caseId,
    status: "PASS",
    skills,
    findings,
    coverage: { enumeratedSources: enumerated, requiredSources: enumerated + rng.int(0, 1) },
    unknownSources: rng.bool(0.3) ? [rng.pick(CODEX_SCOPES)] : [],
    configReadable: rng.bool(0.8),
  };
}

describe("P6 resolver determinism", () => {
  it("the same input always produces the same canonical bytes, with or without a policy", () => {
    const rng = new Rng(PROPERTY_SEED);
    for (let i = 0; i < 60; i++) {
      const poc = randomCodexResult(rng, `prop-${i}`);
      const policy = rng.bool(0.5) ? randomPolicy(rng) : undefined;
      const first = resolveCodexAudit(poc, policy);
      const second = resolveCodexAudit(poc, policy);
      expect(canonicalizeJson(second)).toBe(canonicalizeJson(first));
      // Policy comparison is part of the deterministic output.
      if (policy !== undefined) {
        expect(second.policy.applied).toBe(true);
        expect(second.policy.violationCount).toBe(second.findings.filter((f) => f.id === "SCOPE_LEAK" || f.id === "DISABLE_MISMATCH").length);
      } else {
        expect(second.policy.applied).toBe(false);
      }
    }
  });
});

describe("P7 unknown propagation", () => {
  it("unknown sources and UNKNOWN findings force INCOMPLETE; a lone P1 CONFIRMED finding forces FAIL", () => {
    const rng = new Rng(PROPERTY_SEED);
    for (let i = 0; i < 60; i++) {
      const base: CodexPocResult = {
        schema: "skillscope.codex-poc-result/v1",
        caseId: `prop-unknown-${i}`,
        status: "PASS",
        skills: [
          {
            instanceId: "native-1",
            sourceRootId: "repo",
            sourceScope: "REPO",
            relativePath: "notes/SKILL.md",
            canonicalPath: "layout/repo/notes/SKILL.md",
            logicalName: "notes",
            folderName: "notes",
            contentSha256: sha256("notes-content"),
            canonicalPathHash: sha256("notes-path"),
            status: "ELIGIBLE",
            aliases: [],
            evidenceLevel: "STATIC_RULE",
          },
        ],
        findings: [],
        coverage: { enumeratedSources: 5, requiredSources: 5 },
        unknownSources: [],
        configReadable: true,
      };
      expect(resolveCodexAudit(base).status).toBe("PASS");
      // One unknown source -> INCOMPLETE.
      expect(resolveCodexAudit({ ...base, unknownSources: [rng.pick(CODEX_SCOPES)] }).status).toBe("INCOMPLETE");
      // One UNKNOWN finding -> INCOMPLETE, even with a P1 CONFIRMED finding present.
      expect(
        resolveCodexAudit({
          ...base,
          findings: [
            { id: "SOURCE_NOT_ENUMERATED", severity: "P1", sourceScope: "USER", status: "UNKNOWN", detail: "user source not enumerated" },
            { id: "FAIL_OPEN_CONFIG", severity: "P1", sourceScope: "GLOBAL", status: "CONFIRMED", detail: "config unreadable" },
          ],
        }).status,
      ).toBe("INCOMPLETE");
      // A lone P1 CONFIRMED finding -> FAIL, never INCOMPLETE.
      expect(
        resolveCodexAudit({
          ...base,
          findings: [{ id: "FAIL_OPEN_CONFIG", severity: "P1", sourceScope: "GLOBAL", status: "CONFIRMED", detail: "config unreadable" }],
        }).status,
      ).toBe("FAIL");
      // A lone P2 finding -> PASS.
      expect(
        resolveCodexAudit({
          ...base,
          findings: [{ id: "SAME_NAME_COLLISION", severity: "P2", sourceScope: "GLOBAL", status: "CONFIRMED", detail: "same name" }],
        }).status,
      ).toBe("PASS");
      // An unreadable config with no other unknown source is fail-closed as CONFIG.
      expect(resolveCodexAudit({ ...base, configReadable: false }).status).toBe("INCOMPLETE");
      expect(resolveCodexAudit({ ...base, configReadable: false }).coverage.unknownScopes).toEqual(["CONFIG"]);
    }
  });
});

// ------------------------------------------------------------------ P8: effective set

describe("P8 effective set", () => {
  it("is exactly the ELIGIBLE instances (ADR-006)", () => {
    const rng = new Rng(PROPERTY_SEED);
    for (let i = 0; i < 100; i++) {
      const instances = randomTestInstances(rng);
      const effective = effectiveInstances(instances);
      expect(effective).toEqual(instances.filter((x) => x.status === "ELIGIBLE"));
      expect(effective.every((x) => x.status === "ELIGIBLE")).toBe(true);
    }
  });
});

// ------------------------------------------------------------------ P9: replay

describe("P9 seed replay", () => {
  it("the same seed regenerates the same case stream byte-identically", () => {
    const first = new Rng(PROPERTY_SEED);
    const second = new Rng(PROPERTY_SEED);
    for (let i = 0; i < 200; i++) {
      expect(randomJson(first)).toEqual(randomJson(second));
      expect(randomString(first)).toBe(randomString(second));
    }
    // A different seed diverges (the seed actually drives the stream).
    // The comparison seed is derived from the active seed so this holds
    // for any --seed value, not just the frozen one.
    const other = new Rng(`${PROPERTY_SEED}-alt`);
    const base = new Rng(PROPERTY_SEED);
    let differs = 0;
    for (let i = 0; i < 50; i++) {
      if (canonicalizeJson(randomJson(other)) !== canonicalizeJson(randomJson(base))) differs++;
    }
    expect(differs).toBeGreaterThan(0);
  });
});

// ------------------------------------------------------- P10: policy normalisation

describe("P10 policy normalisation", () => {
  it("is idempotent, sorts and deduplicates, and rejects invalid policies", () => {
    const rng = new Rng(PROPERTY_SEED);
    for (let i = 0; i < 100; i++) {
      const policy = randomPolicy(rng);
      const once = normalizePolicy(policy);
      expect(normalizePolicy(once)).toEqual(once);
      if (once.allowedScopes !== undefined) {
        expect(once.allowedScopes).toEqual([...once.allowedScopes].sort());
        expect(new Set(once.allowedScopes).size).toBe(once.allowedScopes.length);
      }
      if (once.forbiddenScopes !== undefined) {
        expect(once.forbiddenScopes).toEqual([...once.forbiddenScopes].sort());
        expect(new Set(once.forbiddenScopes).size).toBe(once.forbiddenScopes.length);
      }
      if (once.forbiddenNames !== undefined) {
        expect(once.forbiddenNames).toEqual([...once.forbiddenNames].sort());
        expect(new Set(once.forbiddenNames).size).toBe(once.forbiddenNames.length);
      }
      expect(validatePolicy(policy)).toEqual([]);
    }
    // Invalid policies are rejected, never silently repaired.
    expect(validatePolicy({ allowedScopes: ["REPO"], forbiddenScopes: ["REPO"] }).length).toBeGreaterThan(0);
    expect(validatePolicy({ forbiddenNames: [""] }).length).toBeGreaterThan(0);
    expect(validatePolicy({ forbiddenNames: "deploy" }).length).toBeGreaterThan(0);
    expect(() => normalizePolicy({ allowedScopes: ["REPO"], forbiddenScopes: ["REPO"] })).toThrow();
    // Empty lists are not an error: normalisation drops them.
    expect(validatePolicy({ allowedScopes: [] })).toEqual([]);
    expect(normalizePolicy({ allowedScopes: [] })).toEqual({});
  });
});
