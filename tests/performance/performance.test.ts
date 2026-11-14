/**
 * Performance tests (P023 T012, S4).
 *
 * The strict PROJECT_BOOK §10.3 targets (500 instances: scan
 * ≤ 5 s, HTML ≤ 2 s, peak RSS ≤ 300 MiB) are measured by
 * scripts/performance.mjs (`npm run test:performance`), which
 * records the real VM baseline in 03_evidence/T012/performance.json.
 * These vitest tests guard the same properties on a smaller
 * 100-instance fixture so `npm test` stays fast: the audit must
 * complete, count exactly the generated instances, return PASS,
 * and produce a stable canonical hash across two runs. The bounds
 * here are loose sanity bounds (10 s / 5 s), not the §10.3 targets
 * — a loaded CI worker must not flake the suite; the script is
 * the authority for the targets.
 *
 * The fixture is generated at test time (deterministic, seeded by
 * construction — fixed names and content) in a temp dir and
 * deleted afterwards; no real skills, no network.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { generatePerfFixture } from "../../scripts/perf-fixture.mjs";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const CLI_BIN = path.join(REPO_ROOT, "dist", "cli", "index.js");

const INSTANCE_COUNT = 100;

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-perf-"));
}

function runAudit(profilePath: string, format: "json" | "html", outPath: string) {
  const start = performance.now();
  const spawned = spawnSync(
    process.execPath,
    [CLI_BIN, "audit", "--profile", profilePath, "--format", format, "--out", outPath],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  return { exitCode: spawned.status ?? 4, wallMs: performance.now() - start, stderr: spawned.stderr ?? "" };
}

describe("performance: synthetic fixture audit", () => {
  it("100 instances: PASS, exact count, scan < 10 s, hash stable across runs", () => {
    const fixtureDir = tmpDir();
    const outDir = tmpDir();
    try {
      const generated = generatePerfFixture(fixtureDir, { count: INSTANCE_COUNT });
      expect(generated.count).toBe(INSTANCE_COUNT);
      expect(generated.files.length).toBe(INSTANCE_COUNT + 3); // skills + bundled + plugins + profile
      const profile = path.join(fixtureDir, "profile.json");

      const firstOut = path.join(outDir, "first.report.json");
      const first = runAudit(profile, "json", firstOut);
      expect(first.exitCode).toBe(0);
      expect(first.wallMs).toBeLessThan(10000);
      const firstReport = JSON.parse(fs.readFileSync(firstOut, "utf8"));
      expect(firstReport.status).toBe("PASS");
      expect(firstReport.observed_count).toBe(INSTANCE_COUNT);

      const secondOut = path.join(outDir, "second.report.json");
      const second = runAudit(profile, "json", secondOut);
      expect(second.exitCode).toBe(0);
      const secondReport = JSON.parse(fs.readFileSync(secondOut, "utf8"));
      expect(secondReport.audit_sha256).toBe(firstReport.audit_sha256);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 120000);

  it("100 instances: HTML report generates in < 5 s", () => {
    const fixtureDir = tmpDir();
    const outDir = tmpDir();
    try {
      generatePerfFixture(fixtureDir, { count: INSTANCE_COUNT });
      const htmlOut = path.join(outDir, "perf.report.html");
      const run = runAudit(path.join(fixtureDir, "profile.json"), "html", htmlOut);
      expect(run.exitCode).toBe(0);
      expect(run.wallMs).toBeLessThan(5000);
      expect(fs.existsSync(htmlOut)).toBe(true);
      expect(fs.statSync(htmlOut).size).toBeGreaterThan(0);
    } finally {
      fs.rmSync(fixtureDir, { recursive: true, force: true });
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }, 120000);
});
