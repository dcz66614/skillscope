/**
 * Canonical JSON + SHA-256 (P023 T008b, S2).
 *
 * Freezes the deterministic serialisation every SkillScope report,
 * snapshot and hash depends on, so the same logical content always
 * produces the same bytes — and the same hash — on any machine, at any
 * time. T009 (CLI + HTML report) hashes its JSON output through here;
 * T012 replays it.
 *
 * Canonical form (frozen, see ADR-011):
 *   - UTF-8, LF only (no CR, no trailing newline in the canonical
 *     string itself; `writeJsonFile` in src/io appends one LF on disk).
 *   - Object keys sorted by Unicode code point order (NOT UTF-16 code
 *     unit order, so the ordering matches Python's `sort_keys=True` and
 *     the independent Oracle's canonical form for every character,
 *     including astral-plane keys).
 *   - Array order is significant and preserved.
 *   - Every string — key and value — is NFC-normalised, so canonically
 *     equivalent spellings (e.g. "e" + combining acute vs "é") hash
 *     the same.
 *   - Numbers use JSON number syntax; -0 serialises as 0. Non-finite
 *     numbers are rejected, not silently coerced.
 *   - No whitespace between tokens (separators "," and ":").
 *
 * The hash is SHA-256 over the UTF-8 bytes of the canonical string. It
 * contains no wall clock, no random UUID, no PID and no absolute path:
 * any of those in the input must be removed by the caller (src/privacy
 * `redactReport`) before hashing a report, or the hash is not portable.
 *
 * Rejected inputs (throw `TypeError`): undefined, functions, symbols,
 * bigint, non-finite numbers, Date / Map / Set / class instances and
 * any other non-plain object, circular structures. Only JSON data
 * (null, boolean, finite number, string, array, plain object) is
 * canonicalisable — a value that cannot round-trip through JSON must
 * not silently acquire a hash.
 *
 * Pure module: no file access, no clock, no network, no randomness.
 */

import { createHash } from "node:crypto";

export const CANONICAL_SCHEMA = "skillscope.canonical/v1";

/** Compare two strings by Unicode code point sequence. */
export function compareCodePoints(a: string, b: string): number {
  const aPoints = Array.from(a);
  const bPoints = Array.from(b);
  const n = Math.min(aPoints.length, bPoints.length);
  for (let i = 0; i < n; i++) {
    const aChar = aPoints[i] as string;
    const bChar = bPoints[i] as string;
    const ac = aChar.codePointAt(0) as number;
    const bc = bChar.codePointAt(0) as number;
    if (ac !== bc) {
      return ac - bc;
    }
  }
  return aPoints.length - bPoints.length;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const proto = Object.getPrototypeOf(value) as unknown;
  return proto === Object.prototype || proto === null;
}

function canonicalize(value: unknown, seen: Set<object>): string {
  if (value === null) {
    return "null";
  }
  switch (typeof value) {
    case "boolean":
      return value ? "true" : "false";
    case "number":
      if (!Number.isFinite(value)) {
        throw new TypeError("canonical JSON rejects non-finite numbers");
      }
      // JSON.stringify(-0) === "0": -0 and 0 hash the same, as they must.
      return JSON.stringify(value);
    case "string":
      return JSON.stringify(value.normalize("NFC"));
    case "object": {
      if (seen.has(value)) {
        throw new TypeError("canonical JSON rejects circular structures");
      }
      seen.add(value);
      try {
        if (Array.isArray(value)) {
          const parts = value.map((item) => canonicalize(item, seen));
          return `[${parts.join(",")}]`;
        }
        if (!isPlainObject(value)) {
          throw new TypeError(
            "canonical JSON accepts only plain objects (no Date, Map, Set or class instances)",
          );
        }
        // Keys sort by their NFC-normalised form (T011 fix): sorting the
        // raw keys and normalising afterwards is not a fixed point — a
        // decomposed key such as "e" + combining acute sorts before "n"
        // (first code point U+0065) but its NFC form "é" sorts after it
        // (U+00E9), so the canonical form was not stable under
        // parse-and-re-canonicalise and two canonically equivalent
        // spellings hashed differently. The independent Oracle normalises
        // first and sorts second (oracle/python/canonical.py); this
        // matches it. Two distinct raw keys that NFC-normalise to the
        // same key have no unique canonical form and are rejected
        // fail-closed instead of silently dropping one entry.
        const keys = Object.keys(value).map((key) => ({
          raw: key,
          normalized: key.normalize("NFC"),
        }));
        const seenNormalized = new Set<string>();
        for (const { normalized } of keys) {
          if (seenNormalized.has(normalized)) {
            throw new TypeError(
              `canonical JSON rejects NFC-colliding object keys: ${JSON.stringify(normalized)}`,
            );
          }
          seenNormalized.add(normalized);
        }
        keys.sort((a, b) => compareCodePoints(a.normalized, b.normalized));
        const parts = keys.map(
          ({ raw, normalized }) =>
            `${JSON.stringify(normalized)}:${canonicalize(value[raw], seen)}`,
        );
        return `{${parts.join(",")}}`;
      } finally {
        seen.delete(value);
      }
    }
    default:
      throw new TypeError(
        `canonical JSON rejects values of type ${typeof value}`,
      );
  }
}

/**
 * Serialise a JSON value to its canonical string. Deterministic for the
 * same logical value; NFC-normalised; no trailing newline, no CR.
 */
export function canonicalizeJson(value: unknown): string {
  return canonicalize(value, new Set());
}

/** UTF-8 bytes of the canonical JSON string. */
export function canonicalBytes(value: unknown): Buffer {
  return Buffer.from(canonicalizeJson(value), "utf8");
}

/**
 * SHA-256 (lowercase hex) of the canonical JSON UTF-8 bytes. Same input
 * → same hash, on any machine, at any time.
 */
export function canonicalSha256(value: unknown): string {
  return createHash("sha256").update(canonicalBytes(value)).digest("hex");
}

/**
 * True when `text` is already in canonical form: it parses as JSON and
 * re-canonicalising the parsed value reproduces `text` byte for byte.
 * Non-JSON text is never canonical.
 */
export function isCanonicalJson(text: string): boolean {
  if (typeof text !== "string" || text.includes("\r")) {
    return false;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return false;
  }
  try {
    return canonicalizeJson(parsed) === text;
  } catch {
    return false;
  }
}
