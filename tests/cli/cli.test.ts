/**
 * CLI + static HTML report tests (P023 T009, S3).
 *
 * The demo fixtures live in tests/fixtures/demo/<id>/ (NOT in
 * tests/fixtures/s0/, so the S0 gate is untouched). Each profile is a
 * frozen skillscope.profile/v1 file; the CLI resolves all paths
 * relative to the profile file's directory. Every audit in this file
 * writes its report to a temp directory (never into the fixture
 * tree) and asserts the real exit codes: 0 PASS, 1 FAIL,
 * 2 INCOMPLETE, 3 input/config error.
 *
 * The `verify` test runs the frozen S0 gate and restores
 * 03_evidence/S0/ afterwards (the gate rewrites the base_commit
 * label there, exactly as the coordinator's own gate runs do).
 */
import { spawnSync } from "node:child_process";
import { checkoutS0 } from "../helpers/test-infra.js";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { runAudit } from "../../src/cli/audit.js";
import { runInit } from "../../src/cli/init.js";
import { runVerify } from "../../src/cli/verify.js";
import { loadProfile, validateAgainstSchemaId, REPORT_SCHEMA_ID } from "../../src/io/index.js";
import {
  renderReportHtml,
  scanExternalResources,
} from "../../src/report/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const DEMO = path.join(REPO_ROOT, "tests", "fixtures", "demo");
const CLI_BIN = path.join(REPO_ROOT, "dist", "cli", "index.js");

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-cli-"));
}

function copyFixture(id: string, dest: string): string {
  fs.cpSync(path.join(DEMO, id), dest, { recursive: true });
  return path.join(dest, "profile.json");
}

function auditOut(dir: string, name: string): string {
  return path.join(dir, name);
}

describe("audit exit codes and report shape", () => {
  it("codex-fail: NAME_SELECTOR_BLAST_RADIUS → exit 1, FAIL, schema-valid report", () => {
    const dir = tmpDir();
    const out = auditOut(dir, "codex-fail.report.json");
    const result = runAudit({
      profilePath: path.join(DEMO, "codex-fail", "profile.json"),
      format: "json",
      outPath: out,
    });
    expect(result.exitCode).toBe(1);
    expect(result.audit?.status).toBe("FAIL");
    expect(result.report?.status).toBe("FAIL");
    expect(result.audit?.findings.map((f) => f.id)).toContain("NAME_SELECTOR_BLAST_RADIUS");
    // Policy was applied (ADR-005): the kernel, not the PoC, owns it.
    expect(result.audit?.policy.applied).toBe(true);
    expect(result.report?.expected_count).toBe(1); // only `release` stays ELIGIBLE
    expect(result.report?.observed_count).toBe(3);
    expect(result.report?.coverage).toEqual({ enumerated_sources: 5, required_sources: 5 });
    expect(result.report?.oracle_result_sha256).toBeNull();
    expect(result.report?.audit_sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.report?.inventory_sha256).toMatch(/^[0-9a-f]{64}$/);
    // The written file is canonical JSON and validates against the frozen schema.
    const written = fs.readFileSync(out, "utf8");
    expect(written.endsWith("\n")).toBe(true);
    expect(validateAgainstSchemaId(JSON.parse(written), REPORT_SCHEMA_ID)).toEqual([]);
    expect(JSON.parse(written)).toEqual(result.report);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("claude-pass: clean three-layer profile → exit 0, PASS", () => {
    const dir = tmpDir();
    const out = auditOut(dir, "claude-pass.report.json");
    const result = runAudit({
      profilePath: path.join(DEMO, "claude-pass", "profile.json"),
      format: "json",
      outPath: out,
    });
    expect(result.exitCode).toBe(0);
    expect(result.audit?.status).toBe("PASS");
    expect(result.audit?.instances).toHaveLength(2);
    expect(result.audit?.policy.applied).toBe(true);
    expect(result.report?.expected_count).toBe(2);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("openmausbot-incomplete: missing snapshot → exit 2, INCOMPLETE", () => {
    const dir = tmpDir();
    const out = auditOut(dir, "omb.report.json");
    const result = runAudit({
      profilePath: path.join(DEMO, "openmausbot-incomplete", "profile.json"),
      format: "json",
      outPath: out,
    });
    expect(result.exitCode).toBe(2);
    expect(result.audit?.status).toBe("INCOMPLETE");
    expect(result.audit?.coverage.unknownScopes.length).toBeGreaterThan(0);
    // §6.3: observed_count is null while the audit cannot enumerate.
    expect(result.report?.observed_count).toBeNull();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("policy passthrough: forbidden name reaches the kernel (ADR-005)", () => {
    const dir = tmpDir();
    const profilePath = copyFixture("codex-fail", dir);
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as Record<string, unknown>;
    const policy = profile["policy"] as Record<string, unknown>;
    policy["forbidden_names"] = ["release"];
    fs.writeFileSync(profilePath, JSON.stringify(profile), "utf8");
    const out = auditOut(dir, "policy.report.json");
    const result = runAudit({ profilePath, format: "json", outPath: out });
    expect(result.exitCode).toBe(1);
    expect(result.audit?.findings.map((f) => f.id)).toContain("DISABLE_MISMATCH");
    // The kernel produced it (the Codex PoC never emits DISABLE_MISMATCH).
    expect(result.audit?.policy.violationCount).toBeGreaterThan(0);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("determinism: same profile twice → identical JSON bytes and audit hash", () => {
    const dir = tmpDir();
    const outA = auditOut(dir, "a.json");
    const outB = auditOut(dir, "b.json");
    const a = runAudit({
      profilePath: path.join(DEMO, "codex-fail", "profile.json"),
      format: "json",
      outPath: outA,
    });
    const b = runAudit({
      profilePath: path.join(DEMO, "codex-fail", "profile.json"),
      format: "json",
      outPath: outB,
    });
    expect(a.exitCode).toBe(1);
    expect(b.exitCode).toBe(1);
    expect(fs.readFileSync(outB)).toEqual(fs.readFileSync(outA));
    expect(b.report?.audit_sha256).toBe(a.report?.audit_sha256);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("exit 3: missing file, malformed JSON, schema-invalid profile, contradictory policy", () => {
    const dir = tmpDir();
    const missing = runAudit({
      profilePath: path.join(dir, "nope.json"),
      outPath: auditOut(dir, "x.json"),
    });
    expect(missing.exitCode).toBe(3);
    expect(missing.error).toMatch(/cannot load profile/);

    const badJson = path.join(dir, "bad.json");
    fs.writeFileSync(badJson, "{not json", "utf8");
    expect(
      runAudit({ profilePath: badJson, outPath: auditOut(dir, "x.json") }).exitCode,
    ).toBe(3);

    const badSchema = path.join(dir, "bad-schema.json");
    fs.writeFileSync(
      badSchema,
      JSON.stringify({ schema: "skillscope.profile/v1", profile_id: "x" }),
      "utf8",
    );
    expect(
      runAudit({ profilePath: badSchema, outPath: auditOut(dir, "x.json") }).exitCode,
    ).toBe(3);

    const badPolicyDir = tmpDir();
    const profilePath = copyFixture("codex-fail", badPolicyDir);
    const profile = JSON.parse(fs.readFileSync(profilePath, "utf8")) as Record<string, unknown>;
    const policy = profile["policy"] as Record<string, unknown>;
    policy["allowed_scopes"] = ["REPO"];
    policy["forbidden_scopes"] = ["REPO"];
    fs.writeFileSync(profilePath, JSON.stringify(profile), "utf8");
    const badPolicy = runAudit({ profilePath, outPath: auditOut(badPolicyDir, "x.json") });
    expect(badPolicy.exitCode).toBe(3);
    expect(badPolicy.error).toMatch(/invalid policy/);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(badPolicyDir, { recursive: true, force: true });
  });

  it("no absolute paths leak into a report written from a temp-dir copy", () => {
    const dir = tmpDir();
    const profilePath = copyFixture("openmausbot-incomplete", dir);
    const jsonOut = auditOut(dir, "omb.json");
    const htmlOut = auditOut(dir, "omb.html");
    const jsonResult = runAudit({ profilePath, format: "json", outPath: jsonOut });
    const htmlResult = runAudit({ profilePath, format: "html", outPath: htmlOut });
    expect(jsonResult.exitCode).toBe(2);
    expect(htmlResult.exitCode).toBe(2);
    expect(fs.readFileSync(jsonOut, "utf8")).not.toContain(dir);
    expect(fs.readFileSync(htmlOut, "utf8")).not.toContain(dir);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("static HTML report", () => {
  it("matrix, findings, coverage, hashes; no external resources; embedded JSON equals the JSON file", () => {
    const dir = tmpDir();
    const jsonOut = auditOut(dir, "codex-fail.report.json");
    const htmlOut = auditOut(dir, "codex-fail.report.html");
    const jsonResult = runAudit({
      profilePath: path.join(DEMO, "codex-fail", "profile.json"),
      format: "json",
      outPath: jsonOut,
    });
    const htmlResult = runAudit({
      profilePath: path.join(DEMO, "codex-fail", "profile.json"),
      format: "html",
      outPath: htmlOut,
    });
    expect(jsonResult.exitCode).toBe(1);
    expect(htmlResult.exitCode).toBe(1);
    const html = fs.readFileSync(htmlOut, "utf8");
    // Scope matrix (§7.1): one row, REPO/USER columns with counts.
    expect(html).toContain("Scope matrix");
    expect(html).toContain("<th>REPO</th>");
    expect(html).toContain("<th>USER</th>");
    // Findings and coverage.
    expect(html).toContain("NAME_SELECTOR_BLAST_RADIUS");
    expect(html).toContain("Coverage");
    expect(html).toContain("Enumerated sources: <strong>5</strong> of <strong>5</strong>");
    // Explicit three-state wording.
    expect(html).toContain("RESULT: FAIL — at least one confirmed scope deviation");
    // Hashes match the JSON report.
    expect(html).toContain(jsonResult.report?.audit_sha256 as string);
    expect(html).toContain(jsonResult.report?.inventory_sha256 as string);
    // No external resources.
    expect(scanExternalResources(html)).toEqual([]);
    // The embedded JSON parses to exactly the JSON report file.
    const embedded = html.match(
      /<script type="application\/json" id="skillscope-report">(.*?)<\/script>/s,
    );
    expect(embedded).not.toBeNull();
    expect(JSON.parse(embedded?.[1] as string)).toEqual(
      JSON.parse(fs.readFileSync(jsonOut, "utf8")),
    );
    // The renderer is deterministic: rendering the same audit twice
    // is byte-identical (and it never recomputes the verdict — it
    // prints audit.status as given).
    const once = renderReportHtml(htmlResult.audit as never, htmlResult.report as never);
    const twice = renderReportHtml(htmlResult.audit as never, htmlResult.report as never);
    expect(twice).toBe(once);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("PASS and INCOMPLETE reports carry their own explicit state wording", () => {
    const dir = tmpDir();
    const passOut = auditOut(dir, "pass.html");
    const pass = runAudit({
      profilePath: path.join(DEMO, "claude-pass", "profile.json"),
      format: "html",
      outPath: passOut,
    });
    expect(pass.exitCode).toBe(0);
    expect(fs.readFileSync(passOut, "utf8")).toContain(
      "RESULT: PASS — all required sources enumerated",
    );
    const incOut = auditOut(dir, "inc.html");
    const inc = runAudit({
      profilePath: path.join(DEMO, "openmausbot-incomplete", "profile.json"),
      format: "html",
      outPath: incOut,
    });
    expect(inc.exitCode).toBe(2);
    expect(fs.readFileSync(incOut, "utf8")).toContain(
      "RESULT: INCOMPLETE — a required source could not be enumerated",
    );
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("init", () => {
  it("writes a valid starter profile and refuses to overwrite", () => {
    const dir = tmpDir();
    const first = runInit(dir);
    expect(first.exitCode).toBe(0);
    expect(first.profilePath).toBe(path.join(dir, "skillscope.json"));
    const loaded = loadProfile(first.profilePath as string);
    expect(loaded.ok).toBe(true);
    const second = runInit(dir);
    expect(second.exitCode).toBe(3);
    expect(second.error).toMatch(/already exists/);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("CLI binary", () => {
  // dist/ is built once by the vitest globalSetup before any test
  // file runs (tests/helpers/global-setup.ts); per-file builds were
  // removed in T012 because a build starting mid-suite can overlap
  // CLI spawns from other files.
  function runBin(args: string[], cwd = REPO_ROOT) {
    return spawnSync(process.execPath, [CLI_BIN, ...args], { cwd, encoding: "utf8" });
  }

  it("audit on the FAIL demo exits 1 and prints RESULT: FAIL", () => {
    const dir = tmpDir();
    const out = auditOut(dir, "bin.json");
    const run = runBin([
      "audit",
      "--profile",
      path.join(DEMO, "codex-fail", "profile.json"),
      "--out",
      out,
    ]);
    expect(run.status).toBe(1);
    expect(run.stdout).toContain("RESULT: FAIL");
    expect(run.stdout).toContain("Report: ");
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("--engine/--cwd reads skillscope.json from the cwd; --help and bad flags exit 3", () => {
    const dir = tmpDir();
    const init = runBin(["init", "--dir", dir]);
    expect(init.status).toBe(0);
    const run = runBin(["audit", "--engine", "codex", "--cwd", dir, "--out", auditOut(dir, "e.json")]);
    // The starter profile points at empty conventional roots: USER/ADMIN
    // missing → INCOMPLETE (fail-closed), which is the honest answer.
    expect(run.status).toBe(2);
    expect(run.stdout).toContain("RESULT: INCOMPLETE");
    expect(runBin(["--help"]).status).toBe(0);
    expect(runBin(["bogus"]).status).toBe(3);
    // --ci is implemented by T010 (see tests/ci): it is accepted on
    // audit now; the T009 assertion that it exits 3 no longer holds.
    // NOTE: --out must be explicit here — without it the default
    // report path lands next to the profile, inside the fixture tree.
    expect(runBin(["audit", "--profile", path.join(DEMO, "codex-fail", "profile.json"), "--ci", "--out", auditOut(dir, "ci.json")]).status).toBe(1);
    expect(runBin(["audit", "--profile", path.join(DEMO, "codex-fail", "profile.json"), "--bogus"]).status).toBe(3);
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe("verify", () => {
  it(
    "verify --fixtures s0 runs the frozen gate and passes",
    () => {
      let result: ReturnType<typeof runVerify>;
      // Inside `npm test`, dist was just built by the vitest
      // globalSetup; letting the gate rebuild it mid-suite would
      // rewrite dist/ while other test files spawn the CLI
      // (SKILLSCOPE_GATE_NO_REBUILD, see scripts/s0-gate.mjs).
      // Standalone gate runs always rebuild.
      const previous = process.env.SKILLSCOPE_GATE_NO_REBUILD;
      process.env.SKILLSCOPE_GATE_NO_REBUILD = "1";
      try {
        result = runVerify();
      } finally {
        if (previous === undefined) {
          delete process.env.SKILLSCOPE_GATE_NO_REBUILD;
        } else {
          process.env.SKILLSCOPE_GATE_NO_REBUILD = previous;
        }
        // The gate rewrites the base_commit label in 03_evidence/S0/;
        // checkoutS0 retries on .git/index.lock (parallel test files
        // restore the same directory).
        checkoutS0(REPO_ROOT);
      }
      expect(result.gateExitCode).toBe(0);
      expect(result.exitCode).toBe(0);
    },
    300000,
  );
});
