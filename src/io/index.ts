/**
 * Snapshot I/O (P023 T008b, S2).
 *
 * The import path for every observation the product trusts: a file is
 * read (bounded, UTF-8), parsed as JSON, dispatched by its schema id
 * and validated against the frozen JSON Schema in `schemas/` (or, for
 * the OpenMausBot snapshot, the T007-owned schema loaded by reference
 * from its adapter directory — never copied). Nothing unvalidated
 * reaches the resolver, and nothing here writes host configuration.
 *
 * Supported schema ids (frozen):
 *   skillscope.profile/v1       — schemas/skillscope-profile-v1.json
 *   skillscope.report/v1        — schemas/skillscope-report-v1.json
 *   skillscope.audit-result/v1  — schemas/skillscope-audit-result-v1.json
 *   openmausbot-snapshot/v1     — src/adapters/openmausbot/openmausbot-snapshot-v1.json
 *     (dispatched on the `version` field, not `schema`)
 *
 * The validator implements the JSON Schema subset our schemas use
 * (type, enum, const, required, properties, additionalProperties,
 * items, minLength, maxLength, pattern, minimum, maximum, minItems,
 * maxItems). Unknown keywords are ignored and documented; schemas
 * must stay self-contained (no $ref). Errors carry JSON paths.
 *
 * `writeJsonFile` writes canonical JSON (src/canonical) plus one
 * trailing LF, UTF-8, via temp-file + rename in the same directory.
 * It never writes inside a scanned host directory — callers pass an
 * explicit output path (T009's --out).
 *
 * Read results are discriminated unions, never exceptions for expected
 * file problems (NOT_FOUND / TOO_LARGE / NOT_JSON / NOT_UTF8 /
 * UNKNOWN_SCHEMA / SCHEMA_INVALID). Programmer errors (bad arguments)
 * still throw.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { canonicalBytes, canonicalSha256 } from "../canonical/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, "..", "..");

/** Default read bound: snapshots and reports stay small by design. */
export const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;

export const PROFILE_SCHEMA_ID = "skillscope.profile/v1";
export const REPORT_SCHEMA_ID = "skillscope.report/v1";
export const AUDIT_RESULT_SCHEMA_ID = "skillscope.audit-result/v1";
export const OPENMAUSBOT_SNAPSHOT_ID = "openmausbot-snapshot/v1";

/** schema id → schema file, relative to the repo root. */
export const SCHEMA_FILES: Readonly<Record<string, string>> = {
  [PROFILE_SCHEMA_ID]: "schemas/skillscope-profile-v1.json",
  [REPORT_SCHEMA_ID]: "schemas/skillscope-report-v1.json",
  [AUDIT_RESULT_SCHEMA_ID]: "schemas/skillscope-audit-result-v1.json",
  [OPENMAUSBOT_SNAPSHOT_ID]:
    "src/adapters/openmausbot/openmausbot-snapshot-v1.json",
};

export type ReadErrorKind =
  | "NOT_FOUND"
  | "TOO_LARGE"
  | "NOT_JSON"
  | "NOT_UTF8"
  | "UNKNOWN_SCHEMA"
  | "SCHEMA_INVALID";

export interface ReadError {
  kind: ReadErrorKind;
  message: string;
  /** Schema validation problems, when kind is SCHEMA_INVALID. */
  details?: string[];
}

export type ReadJsonResult =
  | { ok: true; value: unknown }
  | { ok: false; error: ReadError };

export type LoadSnapshotResult =
  | { ok: true; schemaId: string; value: unknown; sha256: string }
  | { ok: false; error: ReadError };

type JsonSchema = Record<string, unknown>;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function typeName(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (Array.isArray(value)) {
    return "array";
  }
  if (typeof value === "number") {
    return Number.isInteger(value) ? "integer" : "number";
  }
  return typeof value;
}

function checkType(value: unknown, expected: string, at: string, errors: string[]): void {
  const actual = typeName(value);
  if (expected === "integer") {
    if (actual !== "integer") {
      errors.push(`${at}: expected integer, got ${actual}`);
    }
    return;
  }
  if (expected === "number") {
    if (actual !== "integer" && actual !== "number") {
      errors.push(`${at}: expected number, got ${actual}`);
    }
    return;
  }
  if (actual !== expected) {
    errors.push(`${at}: expected ${expected}, got ${actual}`);
  }
}

/**
 * Validate `value` against a (subset) JSON Schema. Returns the list of
 * problems; empty means valid. Supported keywords: type, enum, const,
 * required, properties, additionalProperties, items, minLength,
 * maxLength, pattern, minimum, maximum, minItems, maxItems. Anything
 * else in the schema is ignored.
 */
export function validateAgainstSchema(value: unknown, schema: unknown, at = "$"): string[] {
  const errors: string[] = [];
  if (!isRecord(schema)) {
    return [`${at}: schema must be an object`];
  }
  if (schema["const"] !== undefined) {
    if (JSON.stringify(value) !== JSON.stringify(schema["const"])) {
      errors.push(`${at}: must equal ${JSON.stringify(schema["const"])}`);
    }
  }
  if (Array.isArray(schema["enum"])) {
    const hit = (schema["enum"] as unknown[]).some(
      (option) => JSON.stringify(option) === JSON.stringify(value),
    );
    if (!hit) {
      errors.push(`${at}: must be one of ${JSON.stringify(schema["enum"])}`);
    }
  }
  if (typeof schema["type"] === "string") {
    checkType(value, schema["type"], at, errors);
    // A type mismatch makes the remaining keywords meaningless.
    if (errors.length > 0) {
      return errors;
    }
  } else if (Array.isArray(schema["type"])) {
    // Union type, e.g. ["string", "null"]: accept when any member fits.
    const candidates = (schema["type"] as unknown[]).filter(
      (t): t is string => typeof t === "string",
    );
    const matched = candidates.some((candidate) => {
      const probe: string[] = [];
      checkType(value, candidate, at, probe);
      return probe.length === 0;
    });
    if (!matched) {
      errors.push(
        `${at}: expected one of ${candidates.join(", ")}, got ${typeName(value)}`,
      );
      return errors;
    }
  }
  if (typeof value === "string") {
    if (typeof schema["minLength"] === "number" && value.length < schema["minLength"]) {
      errors.push(`${at}: string shorter than minLength ${schema["minLength"]}`);
    }
    if (typeof schema["maxLength"] === "number" && value.length > schema["maxLength"]) {
      errors.push(`${at}: string longer than maxLength ${schema["maxLength"]}`);
    }
    if (typeof schema["pattern"] === "string") {
      let re: RegExp;
      try {
        re = new RegExp(schema["pattern"]);
      } catch {
        return [...errors, `${at}: schema pattern is not a valid regex`];
      }
      if (!re.test(value)) {
        errors.push(`${at}: string does not match pattern ${schema["pattern"]}`);
      }
    }
  }
  if (typeof value === "number") {
    if (typeof schema["minimum"] === "number" && value < schema["minimum"]) {
      errors.push(`${at}: number below minimum ${schema["minimum"]}`);
    }
    if (typeof schema["maximum"] === "number" && value > schema["maximum"]) {
      errors.push(`${at}: number above maximum ${schema["maximum"]}`);
    }
  }
  if (Array.isArray(value)) {
    if (typeof schema["minItems"] === "number" && value.length < schema["minItems"]) {
      errors.push(`${at}: array shorter than minItems ${schema["minItems"]}`);
    }
    if (typeof schema["maxItems"] === "number" && value.length > schema["maxItems"]) {
      errors.push(`${at}: array longer than maxItems ${schema["maxItems"]}`);
    }
    if (schema["items"] !== undefined) {
      value.forEach((item, i) => {
        errors.push(...validateAgainstSchema(item, schema["items"], `${at}[${i}]`));
      });
    }
  }
  if (isRecord(value)) {
    if (Array.isArray(schema["required"])) {
      for (const field of schema["required"]) {
        if (typeof field === "string" && value[field] === undefined) {
          errors.push(`${at}: missing required field "${field}"`);
        }
      }
    }
    const properties = isRecord(schema["properties"]) ? schema["properties"] : {};
    for (const [key, childSchema] of Object.entries(properties)) {
      if (value[key] !== undefined) {
        errors.push(...validateAgainstSchema(value[key], childSchema, `${at}.${key}`));
      }
    }
    if (schema["additionalProperties"] === false) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(`${at}: additional property "${key}" is not allowed`);
        }
      }
    } else if (isRecord(schema["additionalProperties"])) {
      for (const key of Object.keys(value)) {
        if (!(key in properties)) {
          errors.push(
            ...validateAgainstSchema(
              value[key],
              schema["additionalProperties"],
              `${at}.${key}`,
            ),
          );
        }
      }
    }
  }
  return errors;
}

/** Load a frozen schema document by schema id. Throws on unknown id. */
export function loadSchema(schemaId: string): JsonSchema {
  const rel = SCHEMA_FILES[schemaId];
  if (rel === undefined) {
    throw new Error(`unknown schema id: ${schemaId}`);
  }
  const text = fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
  return JSON.parse(text) as JsonSchema;
}

/** Validate a value against a frozen schema id. Returns problems (empty = valid). */
export function validateAgainstSchemaId(value: unknown, schemaId: string): string[] {
  return validateAgainstSchema(value, loadSchema(schemaId));
}

/**
 * Read a file as UTF-8 JSON, bounded. Returns a discriminated result;
 * expected file problems are values, not exceptions.
 */
export function readJsonFile(
  filePath: string,
  options: { maxBytes?: number } = {},
): ReadJsonResult {
  const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
  let stat: fs.Stats;
  try {
    stat = fs.statSync(filePath);
  } catch {
    return { ok: false, error: { kind: "NOT_FOUND", message: `file not found: ${filePath}` } };
  }
  if (stat.size > maxBytes) {
    return {
      ok: false,
      error: {
        kind: "TOO_LARGE",
        message: `file is ${stat.size} bytes, over the ${maxBytes} byte limit: ${filePath}`,
      },
    };
  }
  let bytes: Buffer;
  try {
    bytes = fs.readFileSync(filePath);
  } catch (err) {
    return {
      ok: false,
      error: { kind: "NOT_FOUND", message: `cannot read file: ${filePath} (${String(err)})` },
    };
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false, error: { kind: "NOT_UTF8", message: `file is not valid UTF-8: ${filePath}` } };
  }
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch (err) {
    return {
      ok: false,
      error: { kind: "NOT_JSON", message: `file is not valid JSON: ${filePath} (${String(err)})` },
    };
  }
}

/**
 * Write a JSON value as canonical JSON + one trailing LF, UTF-8, via
 * temp file + rename in the same directory. Verifies the written bytes
 * by re-reading them; throws on failure (the temp file is removed).
 */
export function writeJsonFile(filePath: string, value: unknown): void {
  const dir = path.dirname(filePath);
  const tmpPath = path.join(dir, `.skillscope-tmp-${process.pid}-${Date.now()}`);
  const bytes = Buffer.concat([canonicalBytes(value), Buffer.from("\n", "utf8")]);
  try {
    fs.writeFileSync(tmpPath, bytes, { mode: 0o644 });
    const written = fs.readFileSync(tmpPath);
    if (!written.equals(bytes)) {
      throw new Error(`verification read mismatch after writing ${filePath}`);
    }
    fs.renameSync(tmpPath, filePath);
  } finally {
    try {
      fs.rmSync(tmpPath, { force: true });
    } catch {
      // Best effort cleanup; the rename already succeeded or threw.
    }
  }
}

/** Detect the schema id of a parsed JSON value, if it carries one. */
export function detectSchemaId(value: unknown): string | null {
  if (!isRecord(value)) {
    return null;
  }
  if (typeof value["schema"] === "string" && value["schema"] in SCHEMA_FILES) {
    return value["schema"];
  }
  if (value["version"] === OPENMAUSBOT_SNAPSHOT_ID) {
    return OPENMAUSBOT_SNAPSHOT_ID;
  }
  return null;
}

/**
 * Import an observation snapshot: read, dispatch by schema id, validate
 * against the frozen schema. On success the canonical SHA-256 of the
 * imported value is returned alongside it — the frozen, portable
 * fingerprint T009 records in its report. Nothing unvalidated is
 * returned as a value.
 */
export function loadSnapshot(filePath: string): LoadSnapshotResult {
  const read = readJsonFile(filePath);
  if (!read.ok) {
    return { ok: false, error: read.error };
  }
  const schemaId = detectSchemaId(read.value);
  if (schemaId === null) {
    return {
      ok: false,
      error: {
        kind: "UNKNOWN_SCHEMA",
        message:
          "value carries no recognised schema id (expected skillscope.profile/v1, skillscope.report/v1, skillscope.audit-result/v1, or version openmausbot-snapshot/v1)",
      },
    };
  }
  const problems = validateAgainstSchemaId(read.value, schemaId);
  if (problems.length > 0) {
    return {
      ok: false,
      error: {
        kind: "SCHEMA_INVALID",
        message: `value fails ${schemaId} validation`,
        details: problems,
      },
    };
  }
  return { ok: true, schemaId, value: read.value, sha256: canonicalSha256(read.value) };
}

/** Typed loader for a profile file (skillscope.profile/v1). */
export function loadProfile(filePath: string): LoadSnapshotResult {
  const result = loadSnapshot(filePath);
  if (result.ok && result.schemaId !== PROFILE_SCHEMA_ID) {
    return {
      ok: false,
      error: {
        kind: "UNKNOWN_SCHEMA",
        message: `expected a ${PROFILE_SCHEMA_ID} file, got ${result.schemaId}`,
      },
    };
  }
  return result;
}

/** Typed loader for a report file (skillscope.report/v1). */
export function loadReport(filePath: string): LoadSnapshotResult {
  const result = loadSnapshot(filePath);
  if (result.ok && result.schemaId !== REPORT_SCHEMA_ID) {
    return {
      ok: false,
      error: {
        kind: "UNKNOWN_SCHEMA",
        message: `expected a ${REPORT_SCHEMA_ID} file, got ${result.schemaId}`,
      },
    };
  }
  return result;
}
