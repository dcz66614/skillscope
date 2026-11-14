#!/usr/bin/env node
/**
 * S0 gate (P023 T004): `npm run s0:gate`.
 *
 *  1. Rebuilds dist (so the gate always checks the current sources).
 *  2. Runs all 48 fixtures through the production adapters (dist) and
 *     canonicalises the results (scripts/s0-run.mjs + s0-canonical.mjs).
 *  3. Runs the independent Python Reference Oracle over the same manifest
 *     and compares production vs Oracle field-by-field (no ignored fields).
 *  4. Compares both against the frozen golden tests/golden/s0/expected.json.
 *  5. Verifies zero source writes (fixture-tree hashes before/after) and
 *     zero network capability in the exercised code (static scan).
 *  6. Replays the full gate 100 times in-process and requires exactly one
 *     gate_sha256.
 *  7. Writes 03_evidence/S0/S0_GATE.json, ORACLE_PARITY.json, S0_GATE.log.
 *
 * Exit 0 only when every S0 criterion in IMPLEMENTATION_PLAN §6 holds.
 * Read-only with respect to the fixtures; evidence goes to 03_evidence/S0/.
 */

import { execFileSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { withBuildLock } from "./build-lock.mjs";
import { canonicalEquals, canonicalJson } from "./s0-canonical.mjs";
import {
  SEED,
  diffFixtureTrees,
  fixturesRoot,
  gateHash,
  hashFixtureTree,
  loadManifest,
  repeatGate,
  repoRoot,
  runAllFixtures,
} from "./s0-run.mjs";

const root = repoRoot();
const evidenceDir = path.join(root, "03_evidence", "S0");
const manifestPath = path.join(fixturesRoot(root), "manifest.json");
const goldenPath = path.join(root, "tests", "golden", "s0", "expected.json");

function gitHead() {
  try {
    return execSync("git rev-parse HEAD", { cwd: root, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

/** Static scan: the code the gate exercises must contain no network
 * capability (no http/https/net imports, no fetch calls). Returns the
 * list of offending matches (file:line:text). */
function scanNetworkCapability() {
  const hits = [];
  const pattern = /(from\s+["']node:(https?|net)["'])|(\brequire\s*\(\s*["'](https?|net)["']\s*\))|(\bfetch\s*\()/;
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") continue;
        walk(full);
      } else if (/\.(ts|mjs|js)$/.test(entry.name)) {
        const lines = fs.readFileSync(full, "utf8").split("\n");
        lines.forEach((line, idx) => {
          if (pattern.test(line)) {
            hits.push(`${path.relative(root, full)}:${idx + 1}:${line.trim()}`);
          }
        });
      }
    }
  };
  walk(path.join(root, "src"));
  walk(path.join(root, "scripts"));
  return hits;
}

/** First differing JSON paths between two values (bounded). */
function diffPaths(a, b, prefix = "", out = []) {
  if (out.length >= 5) return out;
  if (canonicalEquals(a, b)) return out;
  if (a !== null && b !== null && typeof a === "object" && typeof b === "object") {
    const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
    for (const key of keys) {
      diffPaths(a[key], b[key], `${prefix}.${key}`, out);
      if (out.length >= 5) break;
    }
    return out;
  }
  out.push(`${prefix}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
  return out;
}

function hasDeviationMarker(result) {
  if (result.findings.length > 0) return true;
  if (result.coverage.unknownScopes.length > 0) return true;
  return result.instances.some((inst) => inst.status !== "ELIGIBLE");
}

async function main() {
  const failures = [];
  const baseCommit = gitHead();

  // 1. Rebuild dist from current sources. The build is serialized
  // with the test files' beforeAll builds through the shared lock
  // (scripts/build-lock.mjs): concurrent tsc processes write the
  // same dist/ files, and a CLI spawned mid-write can load a
  // truncated module (T012 flake, 2026-11-13).
  //
  // SKILLSCOPE_GATE_NO_REBUILD=1 skips the rebuild. TEST-ONLY: the
  // vitest globalSetup builds dist immediately before the suite, so
  // inside `npm test` a rebuild is both redundant and racy (it
  // rewrites dist/ while other test files spawn the CLI). Standalone
  // runs (`npm run s0:gate`, `skillscope verify`, scripts/e2e.mjs)
  // never set it and always rebuild.
  const skipRebuild = process.env.SKILLSCOPE_GATE_NO_REBUILD === "1";
  try {
    if (!skipRebuild) {
      withBuildLock(() => execSync("npm run build", { cwd: root, stdio: "pipe" }));
    }
  } catch (err) {
    const out = err.stdout?.toString() ?? "";
    const errOut = err.stderr?.toString() ?? "";
    console.error(`build failed:\n${out}\n${errOut}`);
    process.exit(1);
  }

  // 2. Production run, with fixture-tree hashes before/after.
  const manifest = loadManifest(root);
  const treeBefore = hashFixtureTree(fixturesRoot(root));
  const production = await runAllFixtures(root);
  const treeAfter = hashFixtureTree(fixturesRoot(root));
  const changedPaths = diffFixtureTrees(treeBefore, treeAfter);
  const sourceWriteCount = changedPaths.length;

  // 3. Static network-capability scan.
  const networkHits = scanNetworkCapability();
  const externalRequestCount = networkHits.length;

  // 4. Independent Python Oracle over the same manifest.
  let oracle;
  try {
    const stdout = execFileSync(
      "python3",
      [
        path.join(root, "oracle", "python", "reference_resolver.py"),
        "--manifest",
        manifestPath,
        "--fixtures",
        fixturesRoot(root),
      ],
      { cwd: root, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 },
    );
    oracle = JSON.parse(stdout);
  } catch (err) {
    console.error(`oracle run failed: ${err.message}\n${err.stdout ?? ""}\n${err.stderr ?? ""}`);
    process.exit(1);
  }

  // 5. Production vs Oracle parity (field-by-field, no ignored fields).
  const parity = [];
  let parityMatches = 0;
  for (let i = 0; i < manifest.fixtures.length; i += 1) {
    const fixtureId = manifest.fixtures[i].fixture_id;
    const prod = production[i];
    const orc = oracle[i];
    const match = prod !== undefined && orc !== undefined
      && prod.fixture_id === fixtureId && orc.fixture_id === fixtureId
      && canonicalEquals(prod, orc);
    if (match) parityMatches += 1;
    parity.push({
      fixture_id: fixtureId,
      parity: match,
      ...(match ? {} : { diff: diffPaths(prod, orc, fixtureId) }),
    });
  }

  // 6. Golden comparison (both sides against the frozen golden).
  const golden = JSON.parse(fs.readFileSync(goldenPath, "utf8"));
  if (golden.seed !== SEED) {
    failures.push(`golden seed ${golden.seed} != ${SEED}`);
  }
  const goldenById = new Map(golden.results.map((r) => [r.fixture_id, r]));
  let goldenProdMatches = 0;
  let goldenOracleMatches = 0;
  const goldenMismatches = [];
  for (const entry of manifest.fixtures) {
    const expected = goldenById.get(entry.fixture_id);
    if (expected === undefined) {
      goldenMismatches.push(`${entry.fixture_id}: missing from golden`);
      continue;
    }
    const prod = production.find((r) => r.fixture_id === entry.fixture_id);
    const orc = oracle.find((r) => r.fixture_id === entry.fixture_id);
    if (canonicalEquals(prod, expected)) goldenProdMatches += 1;
    else goldenMismatches.push(`${entry.fixture_id}: production != golden`);
    if (canonicalEquals(orc, expected)) goldenOracleMatches += 1;
    else goldenMismatches.push(`${entry.fixture_id}: oracle != golden`);
  }

  // 7. Detection / false-alarm accounting.
  let controlCount = 0;
  let controlFalseAlarms = 0;
  let plantedCount = 0;
  let detectedDefects = 0;
  let incompleteFixtureCount = 0;
  let incompleteSourceCount = 0;
  for (const result of production) {
    incompleteSourceCount += result.coverage.unknownScopes.length;
    if (result.status === "INCOMPLETE") incompleteFixtureCount += 1;
    if (result.kind === "control") {
      controlCount += 1;
      const hasP1 = result.findings.some((f) => f.severity === "P1");
      if (result.status !== "PASS" || hasP1) controlFalseAlarms += 1;
    } else {
      plantedCount += 1;
      const expected = goldenById.get(result.fixture_id);
      if (
        expected !== undefined
        && canonicalEquals(result, expected)
        && hasDeviationMarker(expected)
      ) {
        detectedDefects += 1;
      }
    }
  }

  // 8. Explicit §6.3 STOP rule: an unreadable/invalid config or an
  // unenumerated source must never be reported as PASS.
  for (const result of production) {
    const unreadableConfig =
      result.extra.configReadable === false
      || result.extra.flags?.configSource === "invalid";
    if ((unreadableConfig || result.coverage.unknownScopes.length > 0)
      && result.status === "PASS") {
      failures.push(`${result.fixture_id}: unreadable config / unenumerated source reported as PASS`);
    }
  }

  // 9. Deterministic replay: 100 full gate runs, one gate hash.
  const replay = await repeatGate(root, 100);
  const gateSha256 = gateHash(production);

  // 10. Verdict.
  if (production.length !== 48) failures.push(`fixture_count ${production.length} != 48`);
  if (parityMatches !== 48) failures.push(`production/oracle parity ${parityMatches}/48`);
  if (goldenProdMatches !== 48) failures.push(`production/golden ${goldenProdMatches}/48`);
  if (goldenOracleMatches !== 48) failures.push(`oracle/golden ${goldenOracleMatches}/48`);
  if (detectedDefects !== 24) failures.push(`detected defects ${detectedDefects}/24`);
  if (controlFalseAlarms !== 0) failures.push(`control false alarms ${controlFalseAlarms}`);
  if (sourceWriteCount !== 0) failures.push(`source writes ${sourceWriteCount}: ${changedPaths.join(", ")}`);
  if (externalRequestCount !== 0) failures.push(`network capability hits: ${networkHits.join("; ")}`);
  if (replay.uniqueHashCount !== 1) failures.push(`replay produced ${replay.uniqueHashCount} unique gate hashes`);
  if (replay.uniqueHashes[0] !== gateSha256) failures.push("replay hash != gate hash");
  if (goldenMismatches.length > 0) failures.push(...goldenMismatches.slice(0, 10));

  const status = failures.length === 0 ? "PASS" : "FAIL";
  const gate = {
    schema: "skillscope.s0-gate/v1",
    seed: SEED,
    base_commit: baseCommit,
    fixture_count: production.length,
    control_count: controlCount,
    control_false_alarms: controlFalseAlarms,
    planted_defect_count: plantedCount,
    detected_defects: detectedDefects,
    production_oracle_parity: `${parityMatches}/48`,
    golden_match_production: `${goldenProdMatches}/48`,
    golden_match_oracle: `${goldenOracleMatches}/48`,
    incomplete_source_count: incompleteSourceCount,
    incomplete_fixture_count: incompleteFixtureCount,
    external_request_count: externalRequestCount,
    source_write_count: sourceWriteCount,
    source_write_paths: changedPaths,
    network_capability_hits: networkHits,
    replay_count: replay.count,
    unique_gate_hash_count: replay.uniqueHashCount,
    gate_sha256: gateSha256,
    status,
    failure_reasons: failures,
    results: production,
  };

  const parityDoc = {
    schema: "skillscope.oracle-parity/v1",
    seed: SEED,
    base_commit: baseCommit,
    parity: `${parityMatches}/48`,
    gate_sha256: gateSha256,
    results: parity,
  };

  fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(
    path.join(evidenceDir, "S0_GATE.json"),
    `${JSON.stringify(gate, null, 2)}\n`,
    "utf8",
  );
  fs.writeFileSync(
    path.join(evidenceDir, "ORACLE_PARITY.json"),
    `${JSON.stringify(parityDoc, null, 2)}\n`,
    "utf8",
  );
  const logLines = [
    `S0 gate ${status} — seed ${SEED} — base ${baseCommit}`,
    `fixtures: ${production.length} (control ${controlCount}, planted ${plantedCount})`,
    `production/oracle parity: ${parityMatches}/48`,
    `golden match: production ${goldenProdMatches}/48, oracle ${goldenOracleMatches}/48`,
    `detected defects: ${detectedDefects}/24; control false alarms: ${controlFalseAlarms}`,
    `incomplete sources: ${incompleteSourceCount} across ${incompleteFixtureCount} fixtures`,
    `external requests: ${externalRequestCount}; source writes: ${sourceWriteCount}`,
    `replay: ${replay.count} runs, ${replay.uniqueHashCount} unique gate hash`,
    `gate_sha256: ${gateSha256}`,
    ...(failures.length > 0 ? ["failures:", ...failures.map((f) => ` - ${f}`)] : []),
  ];
  fs.writeFileSync(path.join(evidenceDir, "S0_GATE.log"), `${logLines.join("\n")}\n`, "utf8");
  console.log(logLines.join("\n"));
  process.exit(status === "PASS" ? 0 : 1);
}

main().catch((err) => {
  console.error(`s0:gate crashed: ${err.stack ?? err.message}`);
  process.exit(1);
});
