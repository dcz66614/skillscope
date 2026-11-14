/**
 * Seeded deterministic generators for the T011 property suite.
 *
 * The seed is the frozen S0 seed (P023-SKILLSCOPE-S0-2026-11-13) unless
 * the SKILLSCOPE_PROPERTY_SEED environment variable overrides it
 * (scripts/property-test.mjs sets it from --seed). Every property test
 * replays the same case stream on every run for a given seed: the PRNG
 * is a mulberry32 stream keyed by an FNV-1a hash of the seed string, and
 * every generator consumes the stream in a fixed order. No Date, no
 * Math.random, no other environment input.
 */

export const PROPERTY_SEED =
  process.env.SKILLSCOPE_PROPERTY_SEED ?? "P023-SKILLSCOPE-S0-2026-11-13";

/** FNV-1a 32-bit hash of a string. */
export function hashSeed(seed: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** mulberry32: small deterministic PRNG, period 2^32. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Deterministic random source for property cases. */
export class Rng {
  private readonly nextFloat: () => number;

  constructor(seedString: string = PROPERTY_SEED) {
    this.nextFloat = mulberry32(hashSeed(seedString));
  }

  /** Float in [0, 1). */
  next(): number {
    return this.nextFloat();
  }

  /** Integer in [min, max] inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  /** True with probability p. */
  bool(p = 0.5): boolean {
    return this.next() < p;
  }

  /** Uniform element of a non-empty array. */
  pick<T>(arr: readonly T[]): T {
    return arr[Math.floor(this.next() * arr.length)]!;
  }

  /** Random subset (possibly empty) of an array, order preserved. */
  subset<T>(arr: readonly T[]): T[] {
    return arr.filter(() => this.bool(0.5));
  }

  /** Shuffle a copy of an array (Fisher-Yates). */
  shuffled<T>(arr: readonly T[]): T[] {
    const out = [...arr];
    for (let i = out.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  }
}

const ASCII_LETTERS = "abcdefghijklmnopqrstuvwxyz";
const WORD_PARTS = ["deploy", "notes", "acme", "release", "helper", "ent", "tool", "docs", "sites", "x"];

/**
 * A random string drawn from a deliberately awkward alphabet: plain ASCII,
 * namespace colons, digits, hyphens, astral-plane characters and combining
 * marks (the cases where UTF-16 code-unit order and NFC disagree with the
 * canonical order).
 */
export function randomString(rng: Rng): string {
  const kind = rng.int(0, 5);
  if (kind === 0) {
    return rng.pick(WORD_PARTS);
  }
  if (kind === 1) {
    // Namespaced name.
    return `${rng.pick(WORD_PARTS)}:${rng.pick(WORD_PARTS)}`;
  }
  if (kind === 2) {
    const n = rng.int(1, 6);
    let s = "";
    for (let i = 0; i < n; i++) s += ASCII_LETTERS[rng.int(0, ASCII_LETTERS.length - 1)]!;
    return s;
  }
  if (kind === 3) {
    // Astral-plane character (code point > 0xFFFF) mixed with BMP.
    return `${rng.pick(WORD_PARTS)}\u{1F600}${rng.pick(WORD_PARTS)}`;
  }
  if (kind === 4) {
    // Decomposed form: e + combining acute (NFC differs from the raw form).
    return `e\u0301${rng.pick(WORD_PARTS)}`;
  }
  // Precomposed equivalent plus a combining mark.
  return `caf\u00e9${rng.pick(WORD_PARTS)}`;
}

/**
 * A random JSON value (objects, arrays, strings, numbers, booleans, null),
 * depth-limited. Numbers include -0, integers and fractions; strings come
 * from the awkward alphabet above.
 */
export function randomJson(rng: Rng, depth = 0): unknown {
  const roll = rng.int(0, depth >= 3 ? 5 : 7);
  switch (roll) {
    case 0:
      return randomString(rng);
    case 1:
      return rng.pick([-0, 0, 1, -1, 42, 3.14, -2.5, 1e9, 0.5]);
    case 2:
      return rng.bool();
    case 3:
      return null;
    case 4: {
      const n = rng.int(0, 3);
      return Array.from({ length: n }, () => randomJson(rng, depth + 1));
    }
    case 5: {
      const n = rng.int(0, 3);
      const out: Record<string, unknown> = {};
      for (let i = 0; i < n; i++) {
        out[randomString(rng)] = randomJson(rng, depth + 1);
      }
      return out;
    }
    case 6: {
      // Shuffled object keys: same logical value, different insertion order.
      const keys = [randomString(rng), randomString(rng), randomString(rng)];
      const out: Record<string, unknown> = {};
      for (const k of rng.shuffled(keys)) out[k] = rng.int(0, 9);
      return out;
    }
    default:
      return randomString(rng);
  }
}
