/**
 * End-to-end tests (P023 T012, S4).
 *
 * These tests drive the REAL built CLI (`dist/cli/index.js`) as a
 * child process — never the in-process API — over the synthetic
 * demo fixtures in tests/fixtures/demo/ (NOT tests/fixtures/s0/,
 * so the S0 gate is untouched). Every audit writes its report to
 * a temp directory, never into the fixture tree, and asserts the
 * frozen exit codes: 0 PASS, 1 FAIL, 2 INCOMPLETE.
 *
 * Covered here (the script runner scripts/e2e.mjs repeats the
 * same chain with a screenshot and a persisted log):
 *   - frozen exit codes + statuses for all three demo profiles
 *   - JSON report validates against skillscope.report/v1
 *   - HTML embeds the exact canonical ReportV1 JSON
 *   - HTML contains 0 external resources
 *   - fixture trees byte-identical before/after (0 source writes)
 *   - determinism: same profile twice → identical JSON bytes
 *
 * The S0 gate itself is NOT run here: it is covered once by
 * tests/cli (whose verify test runs the frozen gate), and the
 * full chain including `verify --fixtures s0` is covered by
 * scripts/e2e.mjs (`npm run test:e2e`). Running the gate from two
 * parallel test files would race on the same 03_evidence/S0/
 * evidence files (T012).
 */

import { spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it, beforeAll } from "vitest";
import { canonicalizeJson } from "../../src/canonical/index.js";
import { validateAgainstSchemaId, REPORT_SCHEMA_ID } from "../../src/io/index.js";
import { scanExternalResources } from "../../src/report/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO = path.join(REPO_ROOT, "tests", "fixtures", "demo");
const CLI_BIN = path.join(REPO_ROOT, "dist", "cli", "index.js");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-e2e-"));
}

function runCli(args: string[]) {
  const spawned = spawnSync(process.execPath, [CLI_BIN, ...args], {
    cwd: REPO_ROOT,
    encoding: "utf8",
  });
  return {
    exitCode: spawned.status ?? 4,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
  };
}

function treeHashes(dir: string): string {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const entry of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        const hash = crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex");
        out.push(`${path.relative(dir, full)}  ${hash}`);
      }
    }
  };
  walk(dir);
  return out.join("\n");
}

const DEMOS = [
  { id: "codex-fail", expectedExit: 1, expectedStatus: "FAIL" },
  { id: "claude-pass", expectedExit: 0, expectedStatus: "PASS" },
  { id: "openmausbot-incomplete", expectedExit: 2, expectedStatus: "INCOMPLETE" },
];

let fixtureHashesBefore = "";

beforeAll(() => {
  // dist/ is built once by the vitest globalSetup; only the fixture
  // snapshot belongs here.
  fixtureHashesBefore = treeHashes(DEMO);
});

describe("e2e: profile → CLI → JSON / HTML", () => {
  for (const demo of DEMOS) {
    it(`${demo.id}: frozen exit ${demo.expectedExit}, ${demo.expectedStatus}, schema-valid JSON`, () => {
      const dir = tmpDir();
      const jsonOut = path.join(dir, `${demo.id}.report.json`);
      const run = runCli([
        "audit",
        "--profile",
        path.join(DEMO, demo.id, "profile.json"),
        "--format",
        "json",
        "--out",
        jsonOut,
      ]);
      expect(run.exitCode).toBe(demo.expectedExit);
      expect(fs.existsSync(jsonOut)).toBe(true);
      const report = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
      expect(report.status).toBe(demo.expectedStatus);
      expect(validateAgainstSchemaId(report, REPORT_SCHEMA_ID)).toEqual([]);
      expect(typeof report.audit_sha256).toBe("string");
      expect(report.audit_sha256.length).toBe(64);
      fs.rmSync(dir, { recursive: true, force: true });
    });

    it(`${demo.id}: HTML embeds the exact canonical ReportV1 JSON, 0 external resources`, () => {
      const dir = tmpDir();
      const jsonOut = path.join(dir, `${demo.id}.report.json`);
      const htmlOut = path.join(dir, `${demo.id}.report.html`);
      const jsonRun = runCli([
        "audit",
        "--profile",
        path.join(DEMO, demo.id, "profile.json"),
        "--format",
        "json",
        "--out",
        jsonOut,
      ]);
      const htmlRun = runCli([
        "audit",
        "--profile",
        path.join(DEMO, demo.id, "profile.json"),
        "--format",
        "html",
        "--out",
        htmlOut,
      ]);
      expect(jsonRun.exitCode).toBe(demo.expectedExit);
      expect(htmlRun.exitCode).toBe(demo.expectedExit);
      const report = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
      const html = fs.readFileSync(htmlOut, "utf8");
      const embedded = html.match(
        /<script type="application\/json" id="skillscope-report">([\s\S]*?)<\/script>/,
      );
      expect(embedded).not.toBeNull();
      expect(embedded?.[1]).toBe(canonicalizeJson(report));
      expect(scanExternalResources(html)).toEqual([]);
      expect(html).toContain(report.status);
      fs.rmSync(dir, { recursive: true, force: true });
    });
  }

  it("determinism: codex-fail audited twice → identical JSON bytes", () => {
    const dir = tmpDir();
    const first = path.join(dir, "first.report.json");
    const second = path.join(dir, "second.report.json");
    const profile = path.join(DEMO, "codex-fail", "profile.json");
    expect(runCli(["audit", "--profile", profile, "--format", "json", "--out", first]).exitCode).toBe(1);
    expect(runCli(["audit", "--profile", profile, "--format", "json", "--out", second]).exitCode).toBe(1);
    expect(fs.readFileSync(first).equals(fs.readFileSync(second))).toBe(true);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("fixture trees byte-identical before/after (0 source writes)", () => {
    expect(treeHashes(DEMO)).toBe(fixtureHashesBefore);
  });
});
