#!/usr/bin/env node
/**
 * T009 demo runner (`npm run demo`, P023 S3).
 *
 * Builds dist, audits the three demo profiles (one per engine, one
 * per audit state), writes JSON + HTML reports to
 * 03_evidence/T009/demo/, scans the HTML for external resources,
 * checks audit determinism (same profile twice → identical JSON
 * bytes), and screenshots the FAIL report with the Playwright
 * headless-shell binary when one is present in the local cache.
 *
 * The demo script itself always exits 0 when every step ran: the
 * audits intentionally return 0/1/2 (PASS/FAIL/INCOMPLETE) and those
 * codes are recorded, not propagated.
 */

import { execFileSync, execSync, spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { scanExternalResources } from "../dist/report/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli", "index.js");
const OUT_DIR = path.join(ROOT, "03_evidence", "T009", "demo");

const DEMOS = [
  { id: "codex-fail", profile: "codex-fail/profile.json", expectedExit: 1 },
  { id: "claude-pass", profile: "claude-pass/profile.json", expectedExit: 0 },
  {
    id: "openmausbot-incomplete",
    profile: "openmausbot-incomplete/profile.json",
    expectedExit: 2,
  },
];

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
  return `ok: ${pngPath} (${size} bytes, via ${path.basename(path.dirname(path.dirname(binary)))} )`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  execSync("npm run build", { cwd: ROOT, stdio: "inherit" });

  const stdoutLog = [];
  const scanLog = [];
  const summary = [];

  for (const demo of DEMOS) {
    const profilePath = path.join(ROOT, "tests", "fixtures", "demo", demo.profile);
    const jsonOut = path.join(OUT_DIR, `${demo.id}.report.json`);
    const htmlOut = path.join(OUT_DIR, `${demo.id}.report.html`);

    const jsonRun = runCli([
      "audit",
      "--profile",
      profilePath,
      "--format",
      "json",
      "--out",
      jsonOut,
    ]);
    const htmlRun = runCli([
      "audit",
      "--profile",
      profilePath,
      "--format",
      "html",
      "--out",
      htmlOut,
    ]);
    stdoutLog.push(`### ${demo.id} (json, exit ${jsonRun.exitCode})`);
    stdoutLog.push(jsonRun.stdout);
    if (jsonRun.stderr) stdoutLog.push(`stderr: ${jsonRun.stderr}`);
    stdoutLog.push(`### ${demo.id} (html, exit ${htmlRun.exitCode})`);
    stdoutLog.push(htmlRun.stdout);
    if (htmlRun.stderr) stdoutLog.push(`stderr: ${htmlRun.stderr}`);

    const jsonExitOk = jsonRun.exitCode === demo.expectedExit;
    const htmlExitOk = htmlRun.exitCode === demo.expectedExit;
    const html = fs.readFileSync(htmlOut, "utf8");
    const hits = scanExternalResources(html);
    scanLog.push(
      `${demo.id}: ${hits.length} external-resource hits` +
        (hits.length > 0 ? ` — ${hits.join("; ")}` : " (clean)"),
    );
    summary.push(
      `${demo.id}: json exit ${jsonRun.exitCode} (expected ${demo.expectedExit}, ${jsonExitOk ? "ok" : "MISMATCH"}), ` +
        `html exit ${htmlRun.exitCode} (expected ${demo.expectedExit}, ${htmlExitOk ? "ok" : "MISMATCH"}), ` +
        `external resources: ${hits.length}`,
    );
    if (!jsonExitOk || !htmlExitOk || hits.length > 0) {
      summary.push(`DEMO FAILED for ${demo.id}`);
      fs.writeFileSync(path.join(OUT_DIR, "demo-stdout.log"), stdoutLog.join("\n"), "utf8");
      fs.writeFileSync(path.join(OUT_DIR, "external-scan.log"), scanLog.join("\n"), "utf8");
      console.error(summary.join("\n"));
      process.exit(1);
    }
  }

  // Determinism: the FAIL profile audited twice produces identical JSON bytes.
  const repeatOut = path.join(OUT_DIR, "codex-fail.repeat.report.json");
  const repeat = runCli([
    "audit",
    "--profile",
    path.join(ROOT, "tests", "fixtures", "demo", "codex-fail/profile.json"),
    "--format",
    "json",
    "--out",
    repeatOut,
  ]);
  const first = fs.readFileSync(path.join(OUT_DIR, "codex-fail.report.json"));
  const second = fs.readFileSync(repeatOut);
  const deterministic = repeat.exitCode === 1 && first.equals(second);
  summary.push(
    `determinism: codex-fail audited twice → ${deterministic ? "identical JSON bytes" : "MISMATCH"}`,
  );
  fs.rmSync(repeatOut, { force: true });

  // Screenshot the FAIL report.
  const shot = screenshot(
    path.join(OUT_DIR, "codex-fail.report.html"),
    path.join(OUT_DIR, "codex-fail.report.png"),
  );
  summary.push(`screenshot: ${shot}`);

  fs.writeFileSync(path.join(OUT_DIR, "demo-stdout.log"), stdoutLog.join("\n"), "utf8");
  fs.writeFileSync(path.join(OUT_DIR, "external-scan.log"), scanLog.join("\n"), "utf8");
  console.log(summary.join("\n"));
  if (!deterministic) {
    console.error("DEMO FAILED: non-deterministic audit output");
    process.exit(1);
  }
}

main();
