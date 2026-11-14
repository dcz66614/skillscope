/**
 * CI mode tests (P023 T010, S3).
 *
 * `--ci` is a boolean flag on `audit` only (ADR-014). It suppresses
 * the multi-line §0.1 console summary and prints exactly one
 * machine-readable line to stdout:
 *
 *   skillscope: RESULT=<STATUS|ERROR> exit=<code>[ report=<path>]
 *
 * The exit-code contract is unchanged: 0 PASS, 1 FAIL, 2 INCOMPLETE,
 * 3 input/config error, 4 internal error. INCOMPLETE is never
 * weakened to 0 in CI mode — a job that cannot enumerate a required
 * source must fail the pipeline, not pass it silently.
 *
 * Every test spawns the real built binary (dist/cli/index.js), the
 * same artifact a GitHub Actions step would call. Reports go to a
 * temp directory, never into the fixture tree.
 */
import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { validateAgainstSchemaId, REPORT_SCHEMA_ID } from "../../src/io/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DEMO = path.join(REPO_ROOT, "tests", "fixtures", "demo");
const CLI_BIN = path.join(REPO_ROOT, "dist", "cli", "index.js");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-ci-"));
}

function runBin(args: string[], cwd = REPO_ROOT) {
  return spawnSync(process.execPath, [CLI_BIN, ...args], { cwd, encoding: "utf8" });
}

/** Non-empty stdout lines of a run. */
function stdoutLines(run: ReturnType<typeof runBin>): string[] {
  return (run.stdout ?? "").split("\n").filter((line) => line.length > 0);
}

describe("audit --ci exit-code matrix", () => {
  // dist/ is built once by the vitest globalSetup before any test
  // file runs (tests/helpers/global-setup.ts); per-file builds were
  // removed in T012 because a build starting mid-suite can overlap
  // CLI spawns from other files.
  it("FAIL demo --ci: exit 1, exactly one stdout line, schema-valid JSON report", () => {
    const dir = tmpDir();
    const out = path.join(dir, "codex-fail.report.json");
    const run = runBin([
      "audit",
      "--profile",
      path.join(DEMO, "codex-fail", "profile.json"),
      "--ci",
      "--out",
      out,
    ]);
    expect(run.status).toBe(1);
    expect(stdoutLines(run)).toHaveLength(1);
    expect(stdoutLines(run)[0]).toMatch(
      /^skillscope: RESULT=FAIL exit=1 report=.+codex-fail\.report\.json$/,
    );
    expect(run.stdout).not.toContain("coverage:");
    expect(fs.existsSync(out)).toBe(true);
    expect(validateAgainstSchemaId(JSON.parse(fs.readFileSync(out, "utf8")), REPORT_SCHEMA_ID)).toEqual([]);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).status).toBe("FAIL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("PASS demo --ci: exit 0, one line, RESULT=PASS", () => {
    const dir = tmpDir();
    const out = path.join(dir, "claude-pass.report.json");
    const run = runBin([
      "audit",
      "--profile",
      path.join(DEMO, "claude-pass", "profile.json"),
      "--ci",
      "--out",
      out,
    ]);
    expect(run.status).toBe(0);
    expect(stdoutLines(run)).toHaveLength(1);
    expect(stdoutLines(run)[0]).toMatch(/^skillscope: RESULT=PASS exit=0 report=.+$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("INCOMPLETE demo --ci: exit 2, never weakened to 0", () => {
    const dir = tmpDir();
    const out = path.join(dir, "omb.report.json");
    const run = runBin([
      "audit",
      "--profile",
      path.join(DEMO, "openmausbot-incomplete", "profile.json"),
      "--ci",
      "--out",
      out,
    ]);
    expect(run.status).toBe(2);
    expect(stdoutLines(run)).toHaveLength(1);
    expect(stdoutLines(run)[0]).toMatch(/^skillscope: RESULT=INCOMPLETE exit=2 report=.+$/);
    expect(JSON.parse(fs.readFileSync(out, "utf8")).status).toBe("INCOMPLETE");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--ci with --format html: exit per status, HTML written, one stdout line", () => {
    const dir = tmpDir();
    const out = path.join(dir, "codex-fail.report.html");
    const run = runBin([
      "audit",
      "--profile",
      path.join(DEMO, "codex-fail", "profile.json"),
      "--ci",
      "--format",
      "html",
      "--out",
      out,
    ]);
    expect(run.status).toBe(1);
    expect(stdoutLines(run)).toHaveLength(1);
    expect(stdoutLines(run)[0]).toMatch(/^skillscope: RESULT=FAIL exit=1 report=.+\.html$/);
    expect(fs.readFileSync(out, "utf8")).toContain("RESULT: FAIL");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--ci with --engine/--cwd: same contract as --profile", () => {
    const dir = tmpDir();
    const init = runBin(["init", "--dir", dir]);
    expect(init.status).toBe(0);
    const run = runBin([
      "audit",
      "--engine",
      "codex",
      "--cwd",
      dir,
      "--ci",
      "--out",
      path.join(dir, "e.json"),
    ]);
    // Starter profile points at empty conventional roots: fail-closed INCOMPLETE.
    expect(run.status).toBe(2);
    expect(stdoutLines(run)).toHaveLength(1);
    expect(stdoutLines(run)[0]).toMatch(/^skillscope: RESULT=INCOMPLETE exit=2 report=.+$/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exit 3 in --ci mode: missing profile, bad format, unknown flag, --ci on init/verify", () => {
    const dir = tmpDir();
    const missing = runBin([
      "audit",
      "--profile",
      path.join(dir, "nope.json"),
      "--ci",
      "--out",
      path.join(dir, "x.json"),
    ]);
    expect(missing.status).toBe(3);
    expect(stdoutLines(missing)).toHaveLength(1);
    expect(stdoutLines(missing)[0]).toBe("skillscope: RESULT=ERROR exit=3");
    expect(missing.stderr).toMatch(/cannot load profile/);

    const badFormat = runBin([
      "audit",
      "--profile",
      path.join(DEMO, "codex-fail", "profile.json"),
      "--ci",
      "--format",
      "yaml",
    ]);
    expect(badFormat.status).toBe(3);

    const unknown = runBin([
      "audit",
      "--profile",
      path.join(DEMO, "codex-fail", "profile.json"),
      "--ci",
      "--bogus",
    ]);
    expect(unknown.status).toBe(3);

    expect(runBin(["init", "--ci", "--dir", dir]).status).toBe(3);
    expect(runBin(["verify", "--fixtures", "s0", "--ci"]).status).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exit 4 in --ci mode: unwritable report path is ERROR, not PASS", () => {
    const dir = tmpDir();
    const run = runBin([
      "audit",
      "--profile",
      path.join(DEMO, "claude-pass", "profile.json"),
      "--ci",
      "--out",
      path.join(dir, "no-such-dir", "out.json"),
    ]);
    expect(run.status).toBe(4);
    expect(stdoutLines(run)).toHaveLength(1);
    // The audit itself passed, but no report was written: the CI line
    // must not claim RESULT=PASS.
    expect(stdoutLines(run)[0]).toBe("skillscope: RESULT=ERROR exit=4");
    expect(run.stderr).toMatch(/cannot write report/);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("normal (non-ci) audit is unchanged: multi-line summary still printed", () => {
    const dir = tmpDir();
    const out = path.join(dir, "plain.json");
    const run = runBin([
      "audit",
      "--profile",
      path.join(DEMO, "codex-fail", "profile.json"),
      "--out",
      out,
    ]);
    expect(run.status).toBe(1);
    expect(stdoutLines(run).length).toBeGreaterThan(1);
    expect(run.stdout).toContain("RESULT: FAIL");
    expect(run.stdout).toContain("coverage:");
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
