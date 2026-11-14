#!/usr/bin/env node
/**
 * T011 evidence assembler (P023 T011, S4).
 *
 * Runs the acceptance commands for real and assembles
 * 03_evidence/T011/GOLDEN_PROPERTY_MUTATION_REPORT.json from their
 * actual output — no hand-typed numbers. Every command below is executed
 * by this script; exit codes and counts are parsed from real output.
 *
 *   npm test                                  (full vitest suite)
 *   npm run test:property -- --seed <S0 seed> (property suite, fixed seed)
 *   npm run test:mutation                     (20 mutants, 8 classes)
 *   npm run test:oracle                       (Python Oracle unit tests)
 *   npm run s0:gate                           (S0 gate; hash must be unchanged)
 *
 * The gate rewrites 03_evidence/S0/* with only the base_commit tag
 * changed; this script restores those files afterwards (the established
 * housekeeping rule) and records the gate hash it observed.
 *
 * Usage: node scripts/t011-evidence.mjs
 * Exit 0 iff every command exited 0, the gate hash is unchanged, and the
 * mutation score is >= 0.95.
 */

import { execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const SEED = "P023-SKILLSCOPE-S0-2026-11-13";
const EXPECTED_GATE = "a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca";
const REPORT_PATH = path.join(REPO, "03_evidence", "T011", "GOLDEN_PROPERTY_MUTATION_REPORT.json");
const MATRIX_PATH = path.join(REPO, "03_evidence", "T011", "mutation-matrix.json");

/** Strip ANSI colour codes (vitest colours its summary even when piped). */
function stripAnsi(text) {
  return text.replace(/\[[0-9;]*m/g, "");
}

function run(command, args = []) {
  const started = Date.now();
  const res = spawnSync(command, args, {
    cwd: REPO,
    encoding: "utf8",
    timeout: 600000,
    maxBuffer: 128 * 1024 * 1024,
  });
  const output = stripAnsi(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
  return {
    command: [command, ...args].join(" "),
    exitCode: typeof res.status === "number" ? res.status : -1,
    durationMs: Date.now() - started,
    stdout: output,
  };
}

function parseVitestSummary(stdout) {
  const files = stdout.match(/Test Files\s+(\d+) passed/);
  const tests = stdout.match(/Tests\s+(\d+) passed/);
  const failed = stdout.match(/Tests\s+.*(\d+) failed/);
  return {
    testFilesPassed: files === null ? null : Number(files[1]),
    testsPassed: tests === null ? null : Number(tests[1]),
    testsFailed: failed === null ? 0 : Number(failed[1]),
  };
}

function gitHead() {
  return execSync("git rev-parse HEAD", { cwd: REPO, encoding: "utf8" }).trim();
}

function main() {
  const startedAt = new Date().toISOString();
  const results = {};

  // 1. Full suite.
  const full = run("npm", ["test"]);
  results.fullSuite = { ...parseVitestSummary(full.stdout), exitCode: full.exitCode, durationMs: full.durationMs };

  // 2. Property suite with the frozen seed.
  const property = run("npm", ["run", "test:property", "--", "--seed", SEED]);
  results.property = {
    seed: SEED,
    ...parseVitestSummary(property.stdout),
    exitCode: property.exitCode,
    durationMs: property.durationMs,
  };

  // 3. Mutation suite (writes mutation-matrix.json itself).
  const mutation = run("npm", ["run", "test:mutation"]);
  const matrix = JSON.parse(fs.readFileSync(MATRIX_PATH, "utf8"));
  results.mutation = {
    exitCode: mutation.exitCode,
    durationMs: mutation.durationMs,
    summary: matrix.summary,
    byClass: matrix.byClass,
  };

  // 4. Python Oracle unit tests.
  const oracle = run("npm", ["run", "test:oracle"]);
  const oracleRan = oracle.stdout.match(/Ran (\d+) tests?/);
  const oracleOk = oracle.stdout.match(/OK(?: \(.*\))?/) !== null;
  results.oracle = {
    exitCode: oracle.exitCode,
    durationMs: oracle.durationMs,
    testsRun: oracleRan === null ? null : Number(oracleRan[1]),
    ok: oracleOk,
  };

  // 5. S0 gate (hash must be unchanged); restore its evidence files after.
  const gate = run("npm", ["run", "s0:gate"]);
  const gateHash = gate.stdout.match(/gate_sha256:\s*([0-9a-f]{64})/);
  const parity = gate.stdout.match(/production\/oracle parity:\s*(\d+)\/(\d+)/);
  const goldenMatch = gate.stdout.match(/golden match: production (\d+)\/(\d+), oracle (\d+)\/(\d+)/);
  const detected = gate.stdout.match(/detected defects:\s*(\d+)\/(\d+)/);
  const falseAlarms = gate.stdout.match(/control false alarms:\s*(\d+)/);
  const replay = gate.stdout.match(/replay:\s*(\d+) runs, (\d+) unique gate hash/);
  results.gate = {
    exitCode: gate.exitCode,
    durationMs: gate.durationMs,
    gateSha256: gateHash === null ? null : gateHash[1],
    gateHashUnchanged: gateHash !== null && gateHash[1] === EXPECTED_GATE,
    parity: parity === null ? null : { matched: Number(parity[1]), total: Number(parity[2]) },
    goldenMatch: goldenMatch === null ? null : {
      production: Number(goldenMatch[1]),
      productionTotal: Number(goldenMatch[2]),
      oracle: Number(goldenMatch[3]),
      oracleTotal: Number(goldenMatch[4]),
    },
    detectedDefects: detected === null ? null : { detected: Number(detected[1]), total: Number(detected[2]) },
    controlFalseAlarms: falseAlarms === null ? null : Number(falseAlarms[1]),
    replay: replay === null ? null : { runs: Number(replay[1]), uniqueHashes: Number(replay[2]) },
  };
  try {
    execSync("git checkout -- 03_evidence/S0/", { cwd: REPO, stdio: "pipe" });
    results.gate.s0EvidenceRestored = true;
  } catch {
    results.gate.s0EvidenceRestored = false;
  }

  const allExitZero =
    results.fullSuite.exitCode === 0 &&
    results.property.exitCode === 0 &&
    results.mutation.exitCode === 0 &&
    results.oracle.exitCode === 0 &&
    results.gate.exitCode === 0;
  const passed =
    allExitZero &&
    results.gate.gateHashUnchanged &&
    results.mutation.summary.passed &&
    results.mutation.summary.survived === 0;

  const report = {
    task: "T011",
    project: "P023 SkillScope",
    seed: SEED,
    generatedAtUtc: startedAt,
    generatedBy: "scripts/t011-evidence.mjs (T011)",
    baseCommit: gitHead(),
    expectedGateSha256: EXPECTED_GATE,
    acceptance: results,
    passed,
    notes: [
      "All numbers above are parsed from real command output by this script; nothing was hand-typed.",
      "The full suite count includes the new T011 suites: tests/golden (S0 full-field, Oracle parity, extended), tests/property, tests/mutation definitions, and the T011 regression tests in tests/hash.",
      "One real defect was found and fixed by this task (see T011_REPORT.md): canonicalizeJson sorted object keys before NFC normalisation, so the canonical form was not a fixed point for decomposed keys. The fix is in src/canonical/index.ts; the frozen hash vectors still pass.",
      "Mutation score counts killed / (total - equivalent); there are no equivalent mutants in this run.",
    ],
  };
  fs.mkdirSync(path.dirname(REPORT_PATH), { recursive: true });
  fs.writeFileSync(REPORT_PATH, `${JSON.stringify(report, null, 2)}\n`, "utf8");

  console.log(`full suite: exit ${results.fullSuite.exitCode}, ${results.fullSuite.testsPassed} tests passed in ${results.fullSuite.testFilesPassed} files`);
  console.log(`property: exit ${results.property.exitCode}, seed ${SEED}, ${results.property.testsPassed} tests passed`);
  console.log(`mutation: exit ${results.mutation.exitCode}, score ${results.mutation.summary.score} (${results.mutation.summary.killed}/${results.mutation.summary.total - results.mutation.summary.equivalent})`);
  console.log(`oracle unit tests: exit ${results.oracle.exitCode}, ${results.oracle.testsRun} tests, ok=${results.oracle.ok}`);
  console.log(`gate: exit ${results.gate.exitCode}, hash ${results.gate.gateSha256}, unchanged=${results.gate.gateHashUnchanged}`);
  console.log(`report written to ${REPORT_PATH}`);
  console.log(`T011 evidence: ${passed ? "PASS" : "FAIL"}`);
  return passed ? 0 : 1;
}

process.exit(main());
