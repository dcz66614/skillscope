#!/usr/bin/env node
/**
 * Extracted-tree reproduction check (P023 FIX-R2, P1-R2-01).
 *
 * `git archive` drops empty directories and the file-SHA manifest
 * cannot see the loss — the R2 regression fixtures were lost exactly
 * this way, so a passing `npm test` in the working tree said nothing
 * about the frozen source.zip. This script proves the published
 * source reproduces the working tree:
 *
 *   1. Extract release/source.zip (default) to a clean temp dir.
 *   2. Compare the extracted tree's directory set against the
 *      working tree's (excluding .git / node_modules / dist /
 *      release, which are not part of the archive) — empty
 *      directories included. Any missing directory fails.
 *   3. Symlink the repo's node_modules into the extracted tree (the
 *      ONLY deviation from a cold checkout — no network is available
 *      or used for `npm ci`) and run `npm run build` there.
 *   4. Run the r1 + r2 regression suites in the extracted tree.
 *   5. Run the full `npm test` in the extracted tree.
 *
 * Usage: node ./scripts/verify-extracted-tree.mjs [source.zip]
 * Exit 0 only when every step passes. Prints a [PASS]/[FAIL] line
 * per step plus a summary with the real exit codes.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const sourceZip = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.join(ROOT, "release", "source.zip");

const failures = [];
const log = [];
function note(line) {
  log.push(line);
  console.log(line);
}
function check(name, ok, detail = "") {
  note(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(name);
  return ok;
}
function run(cmd, args, opts = {}) {
  const spawned = spawnSync(cmd, args, { encoding: "utf8", ...opts });
  return {
    exitCode: spawned.status ?? 4,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
  };
}

/** All directories under root, relative, excluding build/scratch trees. */
function dirSet(root) {
  // Build outputs exist only at the repo root; a fixture skill dir
  // may legitimately be named "release" (e.g. project/release/),
  // so the skip applies to top-level entries only. __pycache__ is
  // a Python runtime artifact that appears at any depth and is
  // never a fixture, so it is skipped everywhere.
  const SKIP_TOP = new Set([".git", "node_modules", "dist", "release"]);
  const SKIP_ANY = new Set(["__pycache__"]);
  const out = new Set();
  const walk = (dir, rel, top) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory() || SKIP_ANY.has(e.name) || (top && SKIP_TOP.has(e.name))) continue;
      const childRel = rel ? `${rel}/${e.name}` : e.name;
      out.add(childRel);
      walk(path.join(dir, e.name), childRel, false);
    }
  };
  walk(root, "", true);
  return out;
}

if (!fs.existsSync(sourceZip)) {
  console.error(`source.zip not found: ${sourceZip}`);
  process.exit(2);
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-extract-"));
// mkdtemp creates 0700, but the r1/r2 regression suites stage their
// `nobody` permission repros into this directory's parent (the repo
// root's parent) — `nobody` must be able to traverse into it, exactly
// as the suites' own staging dirs chmod themselves 755.
fs.chmodSync(work, 0o755);
note(`work dir: ${work}`);
const extract = run("unzip", ["-q", sourceZip, "-d", work]);
check("extract source.zip", extract.exitCode === 0, extract.stderr.slice(0, 300));
const cleanRoot = path.join(work, "skillscope");
check(
  "extracted tree has package.json + src + tests",
  fs.existsSync(path.join(cleanRoot, "package.json")) &&
    fs.existsSync(path.join(cleanRoot, "src")) &&
    fs.existsSync(path.join(cleanRoot, "tests")),
);

// 2. Directory-set comparison (empty dirs included).
const expectedDirs = dirSet(ROOT);
const actualDirs = dirSet(cleanRoot);
const missingDirs = [...expectedDirs].filter((d) => !actualDirs.has(d));
const extraDirs = [...actualDirs].filter((d) => !expectedDirs.has(d));
check(
  `extracted directory set matches working tree (${expectedDirs.size} dirs)`,
  missingDirs.length === 0 && extraDirs.length === 0,
  `missing: ${missingDirs.slice(0, 10).join("; ")}; extra: ${extraDirs.slice(0, 10).join("; ")}`,
);

// 3. Clean-room build (linked node_modules only — no network).
fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(cleanRoot, "node_modules"), "dir");
const build = run("npm", ["run", "build"], { cwd: cleanRoot });
check("extracted-tree npm run build", build.exitCode === 0, build.stderr.slice(0, 300));

// 4. r1 + r2 regression suites in the extracted tree.
const regression = run(
  "npx",
  ["vitest", "run", "tests/regression/r1-fix.test.ts", "tests/regression/r2-fix.test.ts"],
  { cwd: cleanRoot },
);
check(
  "extracted-tree r1 + r2 regression suites",
  regression.exitCode === 0,
  `exit ${regression.exitCode}; ${regression.stdout.split("\n").filter((l) => /Test Files|Tests /.test(l)).join(" | ")}`,
);
if (regression.exitCode !== 0) {
  console.log(regression.stdout.slice(-3000));
  console.log(regression.stderr.slice(-2000));
}

// 5. Full npm test in the extracted tree.
const full = run("npm", ["test"], { cwd: cleanRoot });
check(
  "extracted-tree full npm test",
  full.exitCode === 0,
  `exit ${full.exitCode}; ${full.stdout.split("\n").filter((l) => /Test Files|Tests /.test(l)).join(" | ")}`,
);
if (full.exitCode !== 0) {
  console.log(full.stdout.slice(-3000));
  console.log(full.stderr.slice(-2000));
}

note(`verify-extracted-tree ${failures.length === 0 ? "PASS" : "FAIL"} — ${failures.length} failure(s): ${failures.join("; ")}`);
process.exit(failures.length === 0 ? 0 : 1);
