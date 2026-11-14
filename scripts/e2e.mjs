#!/usr/bin/env node
/**
 * End-to-end runner (`npm run test:e2e`, P023 T012, S4).
 *
 * Verifies the full profile → CLI → HTML / JSON chain against the
 * real built CLI (`dist/cli/index.js`, never the in-process API),
 * using only the synthetic demo fixtures in tests/fixtures/demo/:
 *
 *   1. codex-fail → exit 1, FAIL; claude-pass → exit 0, PASS;
 *      openmausbot-incomplete → exit 2, INCOMPLETE (frozen codes).
 *   2. Each JSON report validates against the frozen
 *      skillscope.report/v1 schema (dist/io).
 *   3. Each HTML report embeds the exact canonical ReportV1 JSON
 *      (byte-identical to canonicalizeJson of the JSON report file)
 *      and contains 0 external resources (dist/report scan).
 *   4. The demo fixture trees are byte-identical before and after
 *      every audit (0 writes into scanned source directories).
 *   5. Determinism: the codex-fail profile audited twice produces
 *      byte-identical JSON reports (same audit_sha256).
 *   6. `verify --fixtures s0` exits 0 (frozen S0 gate still green);
 *      03_evidence/S0/ is restored afterwards (the gate rewrites
 *      the base_commit label there).
 *   7. The FAIL HTML report is screenshotted with the local
 *      headless-Chromium binary when one is cached (same discovery
 *      as scripts/demo.mjs; skipped — never downloaded — when absent).
 *
 * All reports are written to a temp directory (never into the
 * fixture tree). The log and the machine-readable summary go to
 * 03_evidence/T012/e2e.log and e2e.json. Exit 0 only when every
 * check passes.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli", "index.js");
const DEMO = path.join(ROOT, "tests", "fixtures", "demo");
const OUT_DIR = path.join(ROOT, "03_evidence", "T012");

const DEMOS = [
  { id: "codex-fail", profile: "codex-fail/profile.json", expectedExit: 1, expectedStatus: "FAIL" },
  { id: "claude-pass", profile: "claude-pass/profile.json", expectedExit: 0, expectedStatus: "PASS" },
  {
    id: "openmausbot-incomplete",
    profile: "openmausbot-incomplete/profile.json",
    expectedExit: 2,
    expectedStatus: "INCOMPLETE",
  },
];

const failures = [];
const log = [];
function note(line) {
  log.push(line);
  console.log(line);
}

function runCli(args) {
  const spawned = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });
  return {
    exitCode: spawned.status ?? 4,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
  };
}

/** sha256 of every file under dir, as "relpath  hash" lines. */
function treeHashes(dir) {
  const out = [];
  const walk = (d) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
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

function findHeadlessShell() {
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (!fs.existsSync(cache)) {
    return null;
  }
  const candidates = [];
  for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    for (const dir of ["chrome-linux", "chrome-linux64", "chrome-headless-shell-linux64"]) {
      for (const bin of ["headless_shell", "chrome-headless-shell", "chrome"]) {
        const full = path.join(cache, entry.name, dir, bin);
        if (fs.existsSync(full)) {
          candidates.push(full);
        }
      }
    }
  }
  candidates.sort();
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function screenshot(htmlPath, pngPath) {
  const binary = findHeadlessShell();
  if (binary === null) {
    return "skipped: no headless Chromium binary in ~/.cache/ms-playwright";
  }
  const spawned = spawnSync(
    binary,
    [
      "--headless",
      "--disable-gpu",
      "--no-sandbox",
      `--screenshot=${pngPath}`,
      "--window-size=1280,1100",
      "--hide-scrollbars",
      `file://${htmlPath}`,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  if (spawned.status !== 0 || !fs.existsSync(pngPath)) {
    return `failed: exit ${spawned.status}; stderr: ${(spawned.stderr ?? "").slice(0, 300)}`;
  }
  const size = fs.statSync(pngPath).size;
  return `ok: ${pngPath} (${size} bytes)`;
}

async function main() {
  execSync("npm run build", { cwd: ROOT, stdio: "pipe" });
  const { validateAgainstSchemaId, REPORT_SCHEMA_ID } = await import("../dist/io/index.js");
  const { canonicalizeJson: canonical } = await import("../dist/canonical/index.js");
  const { scanExternalResources } = await import("../dist/report/index.js");

  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-e2e-"));
  const checks = [];
  const check = (name, ok, detail = "") => {
    checks.push({ name, status: ok ? "PASS" : "FAIL", detail });
    note(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
    if (!ok) {
      failures.push(name);
    }
  };

  const beforeHashes = treeHashes(DEMO);
  try {
    for (const demo of DEMOS) {
      const profilePath = path.join(DEMO, demo.profile);
      const jsonOut = path.join(workDir, `${demo.id}.report.json`);
      const htmlOut = path.join(workDir, `${demo.id}.report.html`);

      const jsonRun = runCli(["audit", "--profile", profilePath, "--format", "json", "--out", jsonOut]);
      check(
        `${demo.id}: json exit ${jsonRun.exitCode} (expected ${demo.expectedExit})`,
        jsonRun.exitCode === demo.expectedExit,
        jsonRun.stderr.slice(0, 200),
      );
      const htmlRun = runCli(["audit", "--profile", profilePath, "--format", "html", "--out", htmlOut]);
      check(
        `${demo.id}: html exit ${htmlRun.exitCode} (expected ${demo.expectedExit})`,
        htmlRun.exitCode === demo.expectedExit,
        htmlRun.stderr.slice(0, 200),
      );
      if (!fs.existsSync(jsonOut) || !fs.existsSync(htmlOut)) {
        check(`${demo.id}: report files exist`, false, "missing output file");
        continue;
      }
      const report = JSON.parse(fs.readFileSync(jsonOut, "utf8"));
      check(
        `${demo.id}: report status ${report.status} (expected ${demo.expectedStatus})`,
        report.status === demo.expectedStatus,
      );
      const problems = validateAgainstSchemaId(report, REPORT_SCHEMA_ID);
      check(`${demo.id}: JSON validates against ${REPORT_SCHEMA_ID}`, problems.length === 0, problems.join("; "));
      check(
        `${demo.id}: audit_sha256 present`,
        typeof report.audit_sha256 === "string" && report.audit_sha256.length === 64,
      );

      const html = fs.readFileSync(htmlOut, "utf8");
      const embedded = html.match(/<script type="application\/json" id="skillscope-report">([\s\S]*?)<\/script>/);
      if (embedded === null) {
        check(`${demo.id}: HTML embeds canonical ReportV1 JSON`, false, "no embedded script block");
      } else {
        check(
          `${demo.id}: embedded JSON byte-identical to canonical JSON report`,
          embedded[1] === canonical(report),
          embedded[1] === canonical(report)
            ? ""
            : "embedded block differs from canonicalizeJson(report)",
        );
      }
      const hits = scanExternalResources(html);
      check(`${demo.id}: HTML external resources 0`, hits.length === 0, hits.join("; "));
      const statusInHtml = html.includes(report.status);
      check(
        `${demo.id}: HTML contains the status meaning text`,
        statusInHtml,
        statusInHtml ? "" : "status string missing from HTML",
      );
    }

    // Determinism: codex-fail audited twice → identical JSON bytes.
    const repeatOut = path.join(workDir, "codex-fail.repeat.report.json");
    const repeat = runCli([
      "audit",
      "--profile",
      path.join(DEMO, "codex-fail", "profile.json"),
      "--format",
      "json",
      "--out",
      repeatOut,
    ]);
    const first = fs.readFileSync(path.join(workDir, "codex-fail.report.json"));
    const second = fs.existsSync(repeatOut) ? fs.readFileSync(repeatOut) : Buffer.alloc(0);
    check(
      "determinism: codex-fail audited twice → identical JSON bytes",
      repeat.exitCode === 1 && first.equals(second),
    );

    // Frozen S0 gate via the CLI itself.
    let verifyExit = 4;
    try {
      const verify = runCli(["verify", "--fixtures", "s0"]);
      verifyExit = verify.exitCode;
    } finally {
      execFileSync("git", ["checkout", "--", "03_evidence/S0/"], { cwd: ROOT });
    }
    check("verify --fixtures s0 exits 0 (S0 gate still green)", verifyExit === 0, `exit ${verifyExit}`);

    // Screenshot the FAIL report (headless shell from local cache only).
    const shot = screenshot(
      path.join(workDir, "codex-fail.report.html"),
      path.join(OUT_DIR, "e2e-codex-fail.png"),
    );
    const shotOk = shot.startsWith("ok:") || shot.startsWith("skipped:");
    check("screenshot codex-fail HTML report", shotOk, shot);
    if (shot.startsWith("failed:")) {
      failures.push("screenshot failed");
    }
  } finally {
    const afterHashes = treeHashes(DEMO);
    check("fixture trees byte-identical before/after (0 source writes)", beforeHashes === afterHashes);
    fs.rmSync(workDir, { recursive: true, force: true });
  }

  const summary = {
    schema: "skillscope.e2e/v1",
    generated_utc: new Date().toISOString(),
    checks,
    verdict: failures.length === 0 ? "PASS" : "FAIL",
    failures,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(path.join(OUT_DIR, "e2e.log"), `${log.join("\n")}\n`, "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "e2e.json"), `${JSON.stringify(summary, null, 2)}\n`, "utf8");
  note(`e2e: ${summary.verdict} — ${checks.filter((c) => c.status === "PASS").length}/${checks.length} checks passed`);
  if (failures.length > 0) {
    console.error(`e2e: FAIL — ${failures.join("; ")}`);
    process.exit(1);
  }
}

await main();
