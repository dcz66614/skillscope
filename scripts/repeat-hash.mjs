#!/usr/bin/env node
/**
 * Deterministic replay (P023 T004): `npm run s0:repeat -- --count 100`.
 *
 * Runs the full 48-fixture gate `count` times in-process (production
 * adapters only, no Oracle subprocess) and requires exactly one unique
 * gate_sha256. Writes 03_evidence/S0/REPEAT_HASH.json.
 *
 * Exit 0 only when unique_gate_hash_count == 1.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { repeatGate, repoRoot, SEED } from "./s0-run.mjs";

const root = repoRoot();
const evidenceDir = path.join(root, "03_evidence", "S0");

function parseCount(argv) {
  const idx = argv.indexOf("--count");
  if (idx >= 0 && argv[idx + 1] !== undefined) {
    const n = Number.parseInt(argv[idx + 1], 10);
    if (Number.isInteger(n) && n > 0) return n;
    throw new Error(`--count must be a positive integer, got ${argv[idx + 1]}`);
  }
  return 100;
}

async function main() {
  const count = parseCount(process.argv.slice(2));
  const replay = await repeatGate(root, count);
  const gateSha256 = replay.uniqueHashes[0];
  const doc = {
    schema: "skillscope.s0-repeat-hash/v1",
    seed: SEED,
    replay_count: replay.count,
    unique_gate_hash_count: replay.uniqueHashCount,
    unique_gate_hashes: replay.uniqueHashes,
    gate_sha256: gateSha256,
    hashes: replay.hashes,
    status: replay.uniqueHashCount === 1 ? "PASS" : "FAIL",
  };
  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "REPEAT_HASH.json"),
    `${JSON.stringify(doc, null, 2)}\n`,
    "utf8",
  );
  console.log(
    `s0:repeat ${doc.status} — ${replay.count} runs, `
    + `${replay.uniqueHashCount} unique gate hash: ${gateSha256}`,
  );
  process.exit(doc.status === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error(`s0:repeat crashed: ${err.stack ?? err.message}`);
  process.exit(1);
});
