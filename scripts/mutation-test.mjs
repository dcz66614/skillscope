#!/usr/bin/env node
/**
 * Mutation testing for the frozen kernel (P023 T011, S4).
 *
 * Applies each mutant from tests/mutation/mutations.json to a throwaway
 * copy of the repo (node_modules symlinked, never copied; the real tree
 * is never touched) and runs the mutant's kill test there with vitest.
 *
 * A mutant is KILLED when its kill test exits non-zero, SURVIVED when
 * the kill test still passes, and ERROR when the mutant could not be
 * applied or the runner itself failed. Control runs first: every distinct
 * kill test is run once against a clean copy and must pass — if a control
 * fails, the kill test is broken and the run aborts instead of reporting
 * meaningless kills.
 *
 * Score = killed / (total - equivalent). Equivalent mutants (marked in
 * mutations.json) are excluded from the denominator and are expected to
 * survive. Exit code is 0 iff score >= 0.95; any survivor is still listed
 * prominently in the matrix and the report, and gets its own FIX task.
 *
 * Usage: node scripts/mutation-test.mjs [--mutant M01] [--list]
 * Output: 03_evidence/T011/mutation-matrix.json (in the real repo) + a
 * human-readable summary on stdout.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..");
const MUTATIONS_PATH = path.join(REPO, "tests", "mutation", "mutations.json");
const MATRIX_PATH = path.join(REPO, "03_evidence", "T011", "mutation-matrix.json");
const SCORE_TARGET = 0.95;
const KILL_TIMEOUT_MS = 180000;

// What a throwaway copy needs: sources, tests, fixtures and the package
// manifest. scripts/ and oracle/ are not needed by any kill test; the
// Oracle is exercised separately by the parity suite on the real tree.
const COPY_ENTRIES = ["package.json", "tsconfig.json", "tsconfig.build.json", "src", "tests"];

function copyTree(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, entry.name);
    const to = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      copyTree(from, to);
    } else if (entry.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(from), to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
}

function makeCopy() {
  const dir = mkdtempSync(path.join(tmpdir(), "skillscope-mutant-"));
  for (const entry of COPY_ENTRIES) {
    const from = path.join(REPO, entry);
    const to = path.join(dir, entry);
    if (fs.statSync(from).isDirectory()) {
      copyTree(from, to);
    } else {
      fs.copyFileSync(from, to);
    }
  }
  // Link node_modules so vitest resolves without copying ~hundreds of MB.
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  return dir;
}

function runVitest(copyDir, testFile) {
  const started = Date.now();
  try {
    execFileSync(path.join(copyDir, "node_modules", ".bin", "vitest"), ["run", testFile], {
      cwd: copyDir,
      encoding: "utf8",
      timeout: KILL_TIMEOUT_MS,
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 64 * 1024 * 1024,
    });
    return { exitCode: 0, durationMs: Date.now() - started, tail: "" };
  } catch (err) {
    const out = `${err.stdout ?? ""}\n${err.stderr ?? ""}`;
    const lines = out.split("\n").filter((l) => l.trim() !== "");
    return {
      exitCode: typeof err.status === "number" ? err.status : -1,
      durationMs: Date.now() - started,
      tail: lines.slice(-15).join("\n"),
    };
  }
}

function main() {
  const args = process.argv.slice(2);
  const onlyMutant = args.includes("--mutant") ? args[args.indexOf("--mutant") + 1] : null;
  if (args.includes("--list")) {
    const defs = JSON.parse(readFileSync(MUTATIONS_PATH, "utf8"));
    for (const m of defs.mutants) {
      console.log(`${m.id}  class ${m.class}  ${m.file}  kill: ${m.killTest}`);
    }
    return 0;
  }

  const defs = JSON.parse(readFileSync(MUTATIONS_PATH, "utf8"));
  const mutants = onlyMutant === null
    ? defs.mutants
    : defs.mutants.filter((m) => m.id === onlyMutant);
  if (mutants.length === 0) {
    console.error(`no mutant matches ${onlyMutant}`);
    return 2;
  }

  // ---- control runs: every distinct kill test must pass on a clean copy.
  const killTests = [...new Set(mutants.map((m) => m.killTest))];
  console.log(`control: ${killTests.length} distinct kill test(s) on a clean copy`);
  const controlDir = makeCopy();
  try {
    for (const testFile of killTests) {
      const res = runVitest(controlDir, testFile);
      console.log(`  control ${testFile}: exit ${res.exitCode} (${res.durationMs} ms)`);
      if (res.exitCode !== 0) {
        console.error(`CONTROL FAILED for ${testFile} — the kill test is broken; aborting.`);
        console.error(res.tail);
        return 2;
      }
    }
  } finally {
    fs.rmSync(controlDir, { recursive: true, force: true });
  }

  // ---- mutants.
  const results = [];
  for (const mutant of mutants) {
    const copyDir = makeCopy();
    try {
      const target = path.join(copyDir, mutant.file);
      const original = readFileSync(target, "utf8");
      const occurrences = original.split(mutant.search).length - 1;
      if (occurrences !== 1) {
        results.push({
          id: mutant.id,
          class: mutant.class,
          file: mutant.file,
          killTest: mutant.killTest,
          status: "ERROR",
          detail: `search string occurs ${occurrences} times (expected exactly 1); mutant not applied`,
        });
        console.log(`${mutant.id}: ERROR — search occurs ${occurrences}x`);
        continue;
      }
      writeFileSync(target, original.replace(mutant.search, mutant.replace), "utf8");
      const res = runVitest(copyDir, mutant.killTest);
      const equivalent = mutant.equivalent === true;
      const status = res.exitCode !== 0 ? "KILLED" : equivalent ? "SURVIVED_EQUIVALENT" : "SURVIVED";
      results.push({
        id: mutant.id,
        class: mutant.class,
        file: mutant.file,
        killTest: mutant.killTest,
        status,
        exitCode: res.exitCode,
        durationMs: res.durationMs,
        equivalent,
        ...(status === "SURVIVED" ? { killTestTail: res.tail } : {}),
      });
      console.log(`${mutant.id} (class ${mutant.class}): ${status} — kill test exit ${res.exitCode} (${res.durationMs} ms)`);
    } finally {
      fs.rmSync(copyDir, { recursive: true, force: true });
    }
  }

  const total = results.length;
  const equivalentCount = results.filter((r) => r.status === "SURVIVED_EQUIVALENT").length;
  const killed = results.filter((r) => r.status === "KILLED").length;
  const survived = results.filter((r) => r.status === "SURVIVED").length;
  const errors = results.filter((r) => r.status === "ERROR").length;
  const denominator = total - equivalentCount;
  const score = denominator === 0 ? 1 : killed / denominator;
  const byClass = {};
  for (const r of results) {
    const c = String(r.class);
    byClass[c] = byClass[c] ?? { total: 0, killed: 0, survived: 0, errors: 0 };
    byClass[c].total += 1;
    if (r.status === "KILLED") byClass[c].killed += 1;
    if (r.status === "SURVIVED") byClass[c].survived += 1;
    if (r.status === "ERROR") byClass[c].errors += 1;
  }

  const matrix = {
    seed: defs.seed,
    generatedBy: "scripts/mutation-test.mjs (T011)",
    classes: defs.classes,
    summary: {
      total,
      killed,
      survived,
      equivalent: equivalentCount,
      errors,
      score: Number(score.toFixed(4)),
      target: SCORE_TARGET,
      passed: score >= SCORE_TARGET && errors === 0,
    },
    byClass,
    results,
  };
  fs.mkdirSync(path.dirname(MATRIX_PATH), { recursive: true });
  writeFileSync(MATRIX_PATH, `${JSON.stringify(matrix, null, 2)}\n`, "utf8");

  console.log(`\nmutation score: ${killed}/${denominator} = ${(score * 100).toFixed(1)}% (target ≥ ${SCORE_TARGET * 100}%)`);
  console.log(`survived: ${survived}, equivalent: ${equivalentCount}, errors: ${errors}`);
  console.log(`matrix written to ${MATRIX_PATH}`);
  return score >= SCORE_TARGET && errors === 0 ? 0 : 1;
}

process.exit(main());
