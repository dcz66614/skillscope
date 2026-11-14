/**
 * Canonical JSON + SHA-256 tests (P023 T008b, S2).
 *
 * Covers src/canonical: frozen vector file (key order, NFC, array
 * order, astral-plane code-point order, -0, empty values, skill
 * instance), Python-computed anchor hashes (independent of the
 * implementation — computed with hashlib + json.dumps in the shell),
 * determinism (same input → same hash, twice), content sensitivity
 * (different skill content → different hash), UTF-8 / LF hygiene,
 * and rejection of non-JSON values.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalBytes,
  canonicalSha256,
  canonicalizeJson,
  compareCodePoints,
  isCanonicalJson,
} from "../../src/canonical/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const VECTORS = JSON.parse(
  fs.readFileSync(
    path.join(REPO, "tests", "fixtures", "t008b", "canonical-vectors.json"),
    "utf8",
  ),
) as {
  vectors: Array<{ name: string; input: unknown; expectedCanonical: string; expectedSha256: string }>;
};

/** Hashes computed independently with Python hashlib (see task report). */
const PYTHON_ANCHORS: Array<{ input: unknown; sha256: string }> = [
  { input: { a: 2, b: 1 }, sha256: "d3626ac30a87e6f7a6428233b3c68299976865fa5508e4267c5415c76af7a772" },
  { input: {}, sha256: "44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a" },
  { input: { café: 1 }, sha256: "4ba6f859a6604763e30e1afc74dd00bf3b245be58d902b5d1ae0eaa119e8a141" },
  { input: [3, 1, 2], sha256: "51bda7ab4e44726cde71fcb6e4b515357059bb6b6dd5146d1fc50f73f11678c6" },
];

describe("canonical vectors (frozen fixture)", () => {
  for (const vector of VECTORS.vectors) {
    it(`${vector.name}: canonical string + hash`, () => {
      expect(canonicalizeJson(vector.input)).toBe(vector.expectedCanonical);
      expect(vector.expectedSha256).toMatch(/^[0-9a-f]{64}$/);
      expect(canonicalSha256(vector.input)).toBe(vector.expectedSha256);
    });
  }
});

describe("Python anchor hashes (independent)", () => {
  for (const anchor of PYTHON_ANCHORS) {
    it(`sha256(${JSON.stringify(anchor.input)}) matches Python`, () => {
      expect(canonicalSha256(anchor.input)).toBe(anchor.sha256);
    });
  }
});

describe("canonical form rules", () => {
  it("object keys sort by Unicode code point, not UTF-16 unit", () => {
    // U+FFFF (65535) sorts before U+10000 (65536) by code point; UTF-16
    // code-unit order would put U+10000 first (lead surrogate D800).
    expect(compareCodePoints("\u{10000}", "￿")).toBeGreaterThan(0);
    expect(compareCodePoints("￿", "\u{10000}")).toBeLessThan(0);
    expect(canonicalizeJson({ "𐀀": 2, "￿": 1 })).toBe('{"￿":1,"𐀀":2}');
  });

  it("NFC: decomposed and composed spellings canonicalise identically", () => {
    expect(canonicalizeJson({ v: "é" })).toBe(canonicalizeJson({ v: "é" }));
    expect(canonicalSha256({ v: "é" })).toBe(canonicalSha256({ v: "é" }));
  });

  it("array order is significant", () => {
    expect(canonicalizeJson([1, 2, 3])).not.toBe(canonicalizeJson([3, 2, 1]));
  });

  it("-0 serialises as 0", () => {
    expect(canonicalizeJson({ a: -0 })).toBe('{"a":0}');
    expect(canonicalSha256({ a: -0 })).toBe(canonicalSha256({ a: 0 }));
  });

  it("no whitespace, no CR, no trailing newline", () => {
    const out = canonicalizeJson({ b: [1, { c: "x" }], a: null });
    expect(out).toBe('{"a":null,"b":[1,{"c":"x"}]}');
    expect(out).not.toContain("\r");
    expect(out).not.toContain("\n");
    expect(out).not.toContain(" ");
  });

  it("canonical bytes are valid UTF-8 that round-trips", () => {
    const value = { emoji: "😀", name: "café" };
    const bytes = canonicalBytes(value);
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes)).toBe(
      canonicalizeJson(value),
    );
  });

  it("same input hashes the same on repeat (no clock / pid / uuid)", () => {
    const value = { instances: [{ id: "repo:skills/deploy", n: 1 }] };
    expect(canonicalSha256(value)).toBe(canonicalSha256(value));
    expect(canonicalSha256(value)).toBe(
      canonicalSha256(JSON.parse(JSON.stringify(value)) as unknown),
    );
  });

  it("different skill content hashes differently", () => {
    const a = { contentSha256: "aa".repeat(32), logicalName: "deploy" };
    const b = { contentSha256: "bb".repeat(32), logicalName: "deploy" };
    expect(canonicalSha256(a)).not.toBe(canonicalSha256(b));
  });

  it("different logical name hashes differently even with same content", () => {
    const a = { contentSha256: "aa".repeat(32), logicalName: "deploy" };
    const b = { contentSha256: "aa".repeat(32), logicalName: "release" };
    expect(canonicalSha256(a)).not.toBe(canonicalSha256(b));
  });

  it("isCanonicalJson accepts canonical text and rejects the rest", () => {
    expect(isCanonicalJson('{"a":2,"b":1}')).toBe(true);
    expect(isCanonicalJson('{ "a": 2, "b": 1 }')).toBe(false);
    expect(isCanonicalJson('{"b":1,"a":2}')).toBe(false);
    expect(isCanonicalJson('{"a":2,"b":1}\n')).toBe(false);
    expect(isCanonicalJson('{"a":2,"b":1}\r\n')).toBe(false);
    expect(isCanonicalJson("not json")).toBe(false);
  });
});

describe("rejection of non-JSON values", () => {
  it.each([
    ["undefined", undefined],
    ["NaN", Number.NaN],
    ["Infinity", Number.POSITIVE_INFINITY],
    ["bigint", 10n],
    ["function", () => 1],
    ["symbol", Symbol("x")],
    ["Date", new Date(0)],
    ["Map", new Map()],
  ])("rejects %s", (_label, value) => {
    expect(() => canonicalizeJson(value)).toThrow(TypeError);
  });

  it("rejects circular structures", () => {
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;
    expect(() => canonicalizeJson(circular)).toThrow(TypeError);
    const arr: unknown[] = [];
    arr.push(arr);
    expect(() => canonicalizeJson(arr)).toThrow(TypeError);
  });

  it("rejects non-JSON values nested inside objects", () => {
    expect(() => canonicalizeJson({ a: undefined })).toThrow(TypeError);
    expect(() => canonicalizeJson({ a: Number.NaN })).toThrow(TypeError);
  });
});

describe("NFC key sort order (T011 regression)", () => {
  it("sorts keys by their NFC form, not their raw form", () => {
    // Decomposed "e" + combining acute sorts before "n" in raw code points
    // (U+0065 < U+006E) but its NFC form "é" sorts after it (U+00E9).
    // Before the T011 fix the canonical form was not a fixed point:
    // parse-and-re-canonicalise produced different bytes.
    const input = { "érelease": 0, notes: 3 };
    expect(canonicalizeJson(input)).toBe('{"notes":3,"érelease":0}');
    expect(canonicalSha256(input)).toBe(
      "e85a9a77a5df439198f0da71318fdc2f40bbb367594993e96868fbfb297b679f",
    );
    // Fixed point: the canonical form re-canonicalises to itself.
    expect(canonicalizeJson(JSON.parse(canonicalizeJson(input)))).toBe(
      canonicalizeJson(input),
    );
    expect(isCanonicalJson(canonicalizeJson(input))).toBe(true);
    // The decomposed and precomposed spellings are the same logical value.
    expect(canonicalizeJson({ "érelease": 0, notes: 3 })).toBe(
      canonicalizeJson(input),
    );
  });

  it("rejects two raw keys that NFC-normalise to the same key", () => {
    expect(() =>
      canonicalizeJson({ "é": 1, "é": 2 }),
    ).toThrow(TypeError);
  });
});
