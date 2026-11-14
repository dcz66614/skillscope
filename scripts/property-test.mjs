#!/usr/bin/env node
/**
 * Property suite runner (P023 T011, S4).
 *
 * Vitest accepts no custom --seed flag, so the frozen seed is carried in
 * the environment: this wrapper parses --seed and runs
 * `vitest run tests/property` with SKILLSCOPE_PROPERTY_SEED set. The
 * tests default to the frozen S0 seed when the variable is absent, so a
 * bare `vitest run tests/property` still replays the frozen stream.
 *
 * Usage: node scripts/property-test.mjs [--seed <seed>]
 * (invoked as: npm run test:property -- --seed <seed>)
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const FROZEN_SEED = "P023-SKILLSCOPE-S0-2026-11-13";

const args = process.argv.slice(2);
let seed = FROZEN_SEED;
const idx = args.indexOf("--seed");
if (idx !== -1) {
  if (idx + 1 >= args.length) {
    console.error("--seed requires a value");
    process.exit(2);
  }
  seed = args[idx + 1];
}

console.log(`property seed: ${seed}`);
const res = spawnSync(path.join(REPO, "node_modules", ".bin", "vitest"), ["run", "tests/property"], {
  cwd: REPO,
  stdio: "inherit",
  env: { ...process.env, SKILLSCOPE_PROPERTY_SEED: seed },
});
process.exit(typeof res.status === "number" ? res.status : 1);
