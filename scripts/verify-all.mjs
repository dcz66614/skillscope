#!/usr/bin/env node
/**
 * Full verification battery (`npm run verify:all`, P023 T012, S4).
 *
 * Runs every acceptance check in one command and records the
 * outcome in 03_evidence/T012/verify-all.json (+ verify-all.log).
 * Exit 0 only when every step exits 0:
 *
 *   1. typecheck        (tsc --noEmit)
 *   2. test             (full vitest suite, incl. T012 e2e/offline/
 *                        performance tests)
 *   3. test:oracle      (Python Oracle, independent of production)
 *   4. test:e2e         (profile → CLI → HTML/JSON chain)
 *   5. test:offline     (no account / LLM / network / real skills)
 *   6. test:performance (500-instance targets, §10.3)
 *   7. s0:gate          (frozen S0 gate; 03_evidence/S0/ restored
 *                        afterwards — the gate rewrites the
 *                        base_commit label there)
 *   8. license inventory (every installed package's license from
 *      its own package.json, cross-checked against package-lock;
 *      the product itself is MIT — LICENSE at the repo root,
 *      content hash pinned in scripts/release-build.mjs,
 *      package.json claims "license": "MIT"; FIX-R3 corrected the
 *      pre-decision PENDING_SAM_DECISION label)
 *
 * No step is allowed to hide another's failure: every step runs
 * even after a failure, and the summary lists each exit code. The
 * license inventory is a real check, not a static list — a package
 * with no determinable license fails the run.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "03_evidence", "T012");
const OUT_JSON = path.join(OUT_DIR, "verify-all.json");
const OUT_LOG = path.join(OUT_DIR, "verify-all.log");

const STEPS = [
  { name: "typecheck", command: "npm", args: ["run", "typecheck"] },
  { name: "test", command: "npm", args: ["test"] },
  { name: "test:oracle", command: "npm", args: ["run", "test:oracle"] },
  { name: "test:e2e", command: "npm", args: ["run", "test:e2e"] },
  { name: "test:offline", command: "npm", args: ["run", "test:offline"] },
  { name: "test:performance", command: "npm", args: ["run", "test:performance"] },
  { name: "s0:gate", command: "npm", args: ["run", "s0:gate"] },
];

const log = [];
function note(line) {
  log.push(line);
  console.log(line);
}

/** Run one step, capturing exit code, duration and output tail. */
function runStep(step) {
  const start = Date.now();
  const spawned = spawnSync(step.command, step.args, { cwd: ROOT, encoding: "utf8" });
  const durationMs = Date.now() - start;
  const output = `${spawned.stdout ?? ""}\n${spawned.stderr ?? ""}`;
  const tail = output
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(-15)
    .join("\n");
  return {
    name: step.name,
    command: `${step.command} ${step.args.join(" ")}`,
    exit_code: spawned.status ?? 4,
    duration_ms: durationMs,
    status: spawned.status === 0 ? "PASS" : "FAIL",
    output_tail: tail,
  };
}

/**
 * Build the dependency license inventory from the lockfile and the
 * installed packages' own package.json files. Returns
 * { inventory, notInstalledOptional, failures }.
 *
 * npm does NOT install `optional: true` platform packages for other
 * platforms (rolldown bindings, lightningcss binaries, fsevents,
 * …) — those are recorded in notInstalledOptional, not failures.
 * Only a missing non-optional package, a version mismatch, or a
 * package with no determinable license fails the run.
 */
function licenseInventory() {
  const lockPath = path.join(ROOT, "package-lock.json");
  const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
  const packages = lock.packages ?? {};
  const failures = [];
  const notInstalledOptional = [];
  const inventory = [];
  for (const [key, entry] of Object.entries(packages)) {
    if (key === "") {
      continue; // the project root itself
    }
    const name = key.replace(/^node_modules\//, "");
    if (name.includes("node_modules/")) {
      continue; // nested copy: same package, recorded once by name below
    }
    const pkgPath = path.join(ROOT, "node_modules", name, "package.json");
    let installed = null;
    try {
      installed = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
      if (entry.optional === true) {
        notInstalledOptional.push({
          name,
          version: entry.version,
          reason: "optional platform package, not installed on linux x64",
        });
      } else {
        failures.push(`${name}: not installed under node_modules (lockfile lists ${entry.version})`);
      }
      continue;
    }
    if (installed.version !== entry.version) {
      failures.push(
        `${name}: installed ${installed.version} != lockfile ${entry.version}`,
      );
    }
    const raw = installed.license;
    let license = null;
    if (typeof raw === "string") {
      license = raw;
    } else if (raw !== null && typeof raw === "object" && typeof raw.type === "string") {
      license = raw.type;
    } else if (Array.isArray(installed.licenses)) {
      license = installed.licenses.map((l) => l.type).filter(Boolean).join(" OR ");
    }
    if (license === null || license.length === 0) {
      failures.push(`${name}@${installed.version}: no license field in package.json`);
      continue;
    }
    inventory.push({ name, version: installed.version, license });
  }
  inventory.sort((a, b) => a.name.localeCompare(b.name));
  const unique = new Map();
  for (const item of inventory) {
    if (!unique.has(item.name)) {
      unique.set(item.name, item);
    }
  }
  notInstalledOptional.sort((a, b) => a.name.localeCompare(b.name));
  return { inventory: [...unique.values()], notInstalledOptional, failures };
}

function main() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const steps = [];
  for (const step of STEPS) {
    note(`verify-all: running ${step.command} ${step.args.join(" ")} …`);
    const result = runStep(step);
    steps.push(result);
    note(
      `verify-all: ${step.name} → ${result.status} (exit ${result.exit_code}, ${result.duration_ms} ms)`,
    );
    if (step.name === "s0:gate") {
      // The gate rewrites the base_commit label in 03_evidence/S0/.
      execFileSync("git", ["checkout", "--", "03_evidence/S0/"], { cwd: ROOT });
    }
  }

  note("verify-all: building dependency license inventory …");
  const { inventory, notInstalledOptional, failures: licenseFailures } = licenseInventory();
  const licenseStep = {
    name: "license-inventory",
    command: "node scripts/verify-all.mjs (license inventory)",
    exit_code: licenseFailures.length === 0 ? 0 : 1,
    duration_ms: 0,
    status: licenseFailures.length === 0 ? "PASS" : "FAIL",
    output_tail:
      licenseFailures.length === 0
        ? `${inventory.length} packages installed, licenses: ${[...new Set(inventory.map((i) => i.license))].sort().join(", ")}; ${notInstalledOptional.length} optional platform packages not installed on linux x64`
        : licenseFailures.join("\n"),
  };
  steps.push(licenseStep);
  note(
    `verify-all: license-inventory → ${licenseStep.status} (${inventory.length} packages)`,
  );

  const failed = steps.filter((s) => s.status !== "PASS");
  const summary = {
    schema: "skillscope.verify-all/v1",
    generated_utc: new Date().toISOString(),
    head_commit: head,
    steps,
    licenses: inventory,
    not_installed_optional: notInstalledOptional,
    product_license: "MIT (LICENSE, sha256 50b8b302ffcb53aec1866ad4b94721c200400e6aac8cee12db03b85f24e39ed2)",
    verdict: failed.length === 0 ? "PASS" : "FAIL",
    failures: failed.map((s) => s.name),
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "licenses.json"), `${JSON.stringify({ generated_utc: summary.generated_utc, licenses: inventory, not_installed_optional: notInstalledOptional, product_license: summary.product_license }, null, 2)}\n`, "utf8");
  fs.writeFileSync(OUT_LOG, `${log.join("\n")}\n`, "utf8");
  note(
    `verify-all: ${summary.verdict} — ${steps.length - failed.length}/${steps.length} steps passed; ${inventory.length} packages inventoried`,
  );
  if (failed.length > 0) {
    console.error(`verify-all: FAIL — ${failed.map((s) => s.name).join(", ")}`);
    process.exit(1);
  }
}

main();
