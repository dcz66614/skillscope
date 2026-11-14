/**
 * Snapshot I/O tests (P023 T008b, S2).
 *
 * Covers src/io: the JSON Schema subset validator (each keyword, plus
 * union types), frozen schema loading, bounded JSON file reading
 * (NOT_FOUND / TOO_LARGE / NOT_JSON), canonical file writing (bytes
 * on disk, trailing LF, no CR, verification), snapshot dispatch by
 * schema id (profile / report / audit-result / OpenMausBot snapshot),
 * unknown-schema and schema-invalid rejection, and cross-checks that
 * a valid profile also passes the TypeScript contract validators
 * (src/contracts) — the JSON Schema and the TS interface must agree.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  AUDIT_RESULT_SCHEMA_ID,
  OPENMAUSBOT_SNAPSHOT_ID,
  PROFILE_SCHEMA_ID,
  REPORT_SCHEMA_ID,
  detectSchemaId,
  loadProfile,
  loadReport,
  loadSchema,
  loadSnapshot,
  readJsonFile,
  validateAgainstSchema,
  validateAgainstSchemaId,
  writeJsonFile,
} from "../../src/io/index.js";
import {
  isSkillInstanceV1,
  isSourceRootV1,
} from "../../src/contracts/index.js";
import { canonicalizeJson } from "../../src/canonical/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const FIX = path.join(REPO, "tests", "fixtures", "t008b");

function readFixture(name: string): unknown {
  return JSON.parse(fs.readFileSync(path.join(FIX, name), "utf8")) as unknown;
}

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-t008b-io-"));
}

describe("validateAgainstSchema: keywords", () => {
  it("accepts a valid value and reports nothing", () => {
    expect(
      validateAgainstSchema({ a: 1, b: "x" }, {
        type: "object",
        required: ["a"],
        properties: { a: { type: "integer" }, b: { type: "string" } },
        additionalProperties: false,
      }),
    ).toEqual([]);
  });

  it("type mismatch: reports the path and stops descending", () => {
    const errors = validateAgainstSchema({ a: "nope" }, {
      type: "object",
      properties: { a: { type: "integer" } },
    });
    expect(errors).toEqual(["$.a: expected integer, got string"]);
  });

  it("union type accepts either member", () => {
    const schema = { type: ["string", "null"], pattern: "^[0-9a-f]{64}$" };
    expect(validateAgainstSchema(null, schema)).toEqual([]);
    expect(validateAgainstSchema("a".repeat(64), schema)).toEqual([]);
    expect(validateAgainstSchema(42, schema)).toEqual([
      "$: expected one of string, null, got integer",
    ]);
  });

  it("enum and const", () => {
    expect(validateAgainstSchema("b", { enum: ["a", "b"] })).toEqual([]);
    expect(validateAgainstSchema("c", { enum: ["a", "b"] })).toHaveLength(1);
    expect(validateAgainstSchema("x", { const: "x" })).toEqual([]);
    expect(validateAgainstSchema("y", { const: "x" })).toHaveLength(1);
  });

  it("required, additionalProperties, nested items", () => {
    expect(
      validateAgainstSchema({ a: 1 }, {
        type: "object",
        required: ["a", "b"],
        additionalProperties: false,
        properties: { a: { type: "integer" } },
      }),
    ).toEqual(['$: missing required field "b"']);
    expect(
      validateAgainstSchema({ a: 1, z: 2 }, {
        type: "object",
        properties: { a: { type: "integer" } },
        additionalProperties: false,
      }),
    ).toEqual(['$: additional property "z" is not allowed']);
    expect(
      validateAgainstSchema(["a", 2], { type: "array", items: { type: "string" } }),
    ).toEqual(["$[1]: expected string, got integer"]);
  });

  it("string / number / array bounds and pattern", () => {
    expect(validateAgainstSchema("ab", { minLength: 3 })).toHaveLength(1);
    expect(validateAgainstSchema("abcd", { maxLength: 3 })).toHaveLength(1);
    expect(validateAgainstSchema("abc", { pattern: "^[0-9]+$" })).toHaveLength(1);
    expect(validateAgainstSchema(2, { minimum: 3 })).toHaveLength(1);
    expect(validateAgainstSchema(4, { maximum: 3 })).toHaveLength(1);
    expect(validateAgainstSchema([1], { minItems: 2 })).toHaveLength(1);
    expect(validateAgainstSchema([1, 2, 3], { maxItems: 2 })).toHaveLength(1);
    expect(validateAgainstSchema(2.5, { type: "integer" })).toEqual([
      "$: expected integer, got number",
    ]);
  });

  it("rejects a non-object schema", () => {
    expect(validateAgainstSchema(1, "nope")).toHaveLength(1);
  });
});

describe("frozen schemas", () => {
  it("loads every schema id", () => {
    for (const id of [
      PROFILE_SCHEMA_ID,
      REPORT_SCHEMA_ID,
      AUDIT_RESULT_SCHEMA_ID,
      OPENMAUSBOT_SNAPSHOT_ID,
    ]) {
      expect(() => loadSchema(id)).not.toThrow();
    }
    expect(() => loadSchema("no-such-schema/v9")).toThrow(/unknown schema id/);
  });

  it("valid profile fixture passes; invalid fixture fails with paths", () => {
    expect(validateAgainstSchemaId(readFixture("profile-valid.json"), PROFILE_SCHEMA_ID)).toEqual([]);
    const errors = validateAgainstSchemaId(readFixture("profile-invalid.json"), PROFILE_SCHEMA_ID);
    expect(errors.length).toBeGreaterThanOrEqual(2);
    expect(errors.join("\n")).toContain("$.engine");
    expect(errors.join("\n")).toContain("additional property");
  });

  it("valid report fixture passes; bad hash pattern fails", () => {
    expect(validateAgainstSchemaId(readFixture("report-valid.json"), REPORT_SCHEMA_ID)).toEqual([]);
    const errors = validateAgainstSchemaId(
      readFixture("report-invalid-hash.json"),
      REPORT_SCHEMA_ID,
    );
    expect(errors.length).toBe(1);
    expect(errors[0]).toContain("$.audit_sha256");
  });

  it("valid audit-result fixture passes", () => {
    expect(
      validateAgainstSchemaId(readFixture("audit-result-valid.json"), AUDIT_RESULT_SCHEMA_ID),
    ).toEqual([]);
  });

  it("valid OpenMausBot snapshot fixture passes (schema loaded by reference)", () => {
    expect(
      validateAgainstSchemaId(readFixture("snapshot-omb-valid.json"), OPENMAUSBOT_SNAPSHOT_ID),
    ).toEqual([]);
    const bad = readFixture("snapshot-omb-valid.json") as Record<string, unknown>;
    bad["version"] = "openmausbot-snapshot/v2";
    expect(validateAgainstSchemaId(bad, OPENMAUSBOT_SNAPSHOT_ID)).toHaveLength(1);
  });

  it("JSON Schema and TS contract validators agree on the valid profile", () => {
    const profile = readFixture("profile-valid.json") as {
      source_roots: unknown[];
    };
    for (const root of profile.source_roots) {
      expect(isSourceRootV1(root)).toBe(true);
    }
    expect(isSkillInstanceV1({
      instanceId: "repo:skills/deploy",
      engine: "codex",
      sourceRootId: "repo",
      sourceScope: "REPO",
      relativePath: "skills/deploy",
      canonicalPathHash: "a".repeat(64),
      logicalName: "deploy",
      folderName: "deploy",
      contentSha256: "b".repeat(64),
      status: "ELIGIBLE",
      evidenceLevel: "STATIC_RULE",
    })).toBe(true);
  });
});

describe("readJsonFile", () => {
  it("reads a valid JSON file", () => {
    const dir = tmpDir();
    const file = path.join(dir, "ok.json");
    fs.writeFileSync(file, '{"a":1}\n', "utf8");
    expect(readJsonFile(file)).toEqual({ ok: true, value: { a: 1 } });
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("NOT_FOUND for a missing file", () => {
    const result = readJsonFile(path.join(tmpDir(), "missing.json"));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("NOT_FOUND");
    }
  });

  it("NOT_JSON for invalid JSON", () => {
    const dir = tmpDir();
    const file = path.join(dir, "bad.json");
    fs.writeFileSync(file, "{not json", "utf8");
    const result = readJsonFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("NOT_JSON");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("TOO_LARGE when the file exceeds maxBytes", () => {
    const dir = tmpDir();
    const file = path.join(dir, "big.json");
    fs.writeFileSync(file, '{"a":"' + "x".repeat(100) + '"}', "utf8");
    const result = readJsonFile(file, { maxBytes: 10 });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("TOO_LARGE");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("NOT_UTF8 for invalid UTF-8 bytes", () => {
    const dir = tmpDir();
    const file = path.join(dir, "bad.bin");
    fs.writeFileSync(file, Buffer.from([0xff, 0xfe, 0xfd]));
    const result = readJsonFile(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("NOT_UTF8");
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("writeJsonFile", () => {
  it("writes canonical JSON + one LF, UTF-8, no CR, and re-reads", () => {
    const dir = tmpDir();
    const file = path.join(dir, "out.json");
    const value = { b: 1, a: [3, 2, { z: "é" }] };
    writeJsonFile(file, value);
    const bytes = fs.readFileSync(file);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(
      `${canonicalizeJson(value)}\n`,
    );
    expect(bytes.includes(0x0d)).toBe(false);
    expect(readJsonFile(file)).toEqual({ ok: true, value });
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("loadSnapshot dispatch", () => {
  it("loads a profile, a report and an audit-result by schema id", () => {
    const dir = tmpDir();
    const cases: Array<[string, string, string]> = [
      ["profile-valid.json", PROFILE_SCHEMA_ID, "profile"],
      ["report-valid.json", REPORT_SCHEMA_ID, "report"],
      ["audit-result-valid.json", AUDIT_RESULT_SCHEMA_ID, "audit-result"],
      ["snapshot-omb-valid.json", OPENMAUSBOT_SNAPSHOT_ID, "snapshot"],
    ];
    for (const [fixture, schemaId, label] of cases) {
      const file = path.join(dir, `${label}.json`);
      fs.copyFileSync(path.join(FIX, fixture), file);
      const result = loadSnapshot(file);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.schemaId).toBe(schemaId);
        expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("same file loads to the same hash on repeat", () => {
    const file = path.join(FIX, "profile-valid.json");
    const first = loadSnapshot(file);
    const second = loadSnapshot(file);
    expect(first.ok && second.ok).toBe(true);
    if (first.ok && second.ok) {
      expect(first.sha256).toBe(second.sha256);
    }
  });

  it("UNKNOWN_SCHEMA for a value with no recognised id", () => {
    const dir = tmpDir();
    const file = path.join(dir, "unknown.json");
    fs.writeFileSync(file, '{"hello":"world"}', "utf8");
    const result = loadSnapshot(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("UNKNOWN_SCHEMA");
    }
    expect(detectSchemaId({ hello: "world" })).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("SCHEMA_INVALID for a value that fails its declared schema", () => {
    const dir = tmpDir();
    const file = path.join(dir, "bad-profile.json");
    fs.copyFileSync(path.join(FIX, "profile-invalid.json"), file);
    const result = loadSnapshot(file);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.kind).toBe("SCHEMA_INVALID");
      expect(result.error.details?.length).toBeGreaterThan(0);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("loadProfile / loadReport reject the wrong schema id", () => {
    expect(loadProfile(path.join(FIX, "report-valid.json")).ok).toBe(false);
    expect(loadReport(path.join(FIX, "profile-valid.json")).ok).toBe(false);
    expect(loadProfile(path.join(FIX, "profile-valid.json")).ok).toBe(true);
    expect(loadReport(path.join(FIX, "report-valid.json")).ok).toBe(true);
  });
});
