#!/usr/bin/env node
/**
 * Offline check (`npm run test:offline`, P023 T010, S3).
 *
 * Proves the product needs no account, no LLM, no network and no
 * real skills to run. Four independent checks; all must pass and the
 * script exits 0 only then:
 *
 *   1. Static scan: no network call sites in src/, scripts/*.mjs or
 *      the built dist/ (fetch, http/https request/get, net.connect,
 *      WebSocket, axios, undici, XMLHttpRequest) and no https://
 *      strings in the built JS (data files such as JSON Schemas are
 *      not code and are excluded from the string scan).
 *   2. Dead-proxy run: the three demo audits are run with
 *      http_proxy/https_proxy pointed at a blackholed address
 *      (127.0.0.1:9). Any attempted HTTP call would fail; the audits
 *      must still return their frozen exit codes 1/0/2.
 *   3. Output scan: the JSON and HTML reports from (2) contain no
 *      http:// or https:// URLs, and the HTML reports pass the
 *      report renderer's own scanExternalResources (no <link>,
 *      <script src>, <img src>, external src/href/action, @import
 *      or url(...)).
 *   4. Docs scan: README.md, docs/ and .github/workflows/ contain
 *      no https:// strings, so the docs never point the reader at a
 *      remote resource the product depends on.
 *
 * Reports are written to a temp directory (never into the fixture
 * tree) and deleted afterwards. The script builds dist first so the
 * scan covers the artifact a CI step would actually call.
 */

import { spawnSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { scanExternalResources } from "../dist/report/index.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli", "index.js");

const NETWORK_CALL_PATTERNS = [
  /\bfetch\s*\(/,
  /\bhttps?\.request\s*\(/,
  /\bhttps?\.get\s*\(/,
  /\bnet\.connect\s*\(/,
  /\bnew\s+WebSocket\s*\(/,
  /\baxios\b/,
  /\bundici\b/,
  /\bXMLHttpRequest\b/,
  /require\(\s*["']https?["']\s*\)/,
  /from\s+["']node:https?["']/,
  /from\s+["']https?["']/,
];

const URL_PATTERN = /https?:\/\//;

function listFiles(dir, exts) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...listFiles(full, exts));
    } else if (exts.some((ext) => entry.name.endsWith(ext))) {
      out.push(full);
    }
  }
  return out;
}

function checkStatic() {
  const failures = [];
  const codeFiles = [
    ...listFiles(path.join(ROOT, "src"), [".ts"]),
    ...listFiles(path.join(ROOT, "scripts"), [".mjs"]),
    ...listFiles(path.join(ROOT, "dist"), [".js"]),
    // The checker itself is excluded: its pattern list necessarily
    // contains the forbidden words (axios, undici, XMLHttpRequest)
    // as string literals. It is not product code and it makes no
    // network calls.
  ].filter((file) => path.basename(file) !== "offline-check.mjs");
  for (const file of codeFiles) {
    const text = fs.readFileSync(file, "utf8");
    for (const re of NETWORK_CALL_PATTERNS) {
      const hit = text.match(re);
      if (hit !== null) {
        failures.push(`${path.relative(ROOT, file)}: network call ${JSON.stringify(hit[0])}`);
      }
    }
  }
  // No https:// strings in the built JS at all.
  for (const file of listFiles(path.join(ROOT, "dist"), [".js"])) {
    const text = fs.readFileSync(file, "utf8");
    const hit = text.match(URL_PATTERN);
    if (hit !== null) {
      failures.push(`${path.relative(ROOT, file)}: URL string ${JSON.stringify(hit[0])}`);
    }
  }
  return failures;
}

function runCli(args, env) {
  const spawned = spawnSync(process.execPath, [CLI, ...args], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
  return {
    exitCode: spawned.status ?? 4,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
  };
}

function checkDeadProxy(tmpDir) {
  const failures = [];
  const deadProxy = {
    http_proxy: "http://127.0.0.1:9",
    https_proxy: "http://127.0.0.1:9",
    HTTP_PROXY: "http://127.0.0.1:9",
    HTTPS_PROXY: "http://127.0.0.1:9",
    NO_PROXY: "",
    no_proxy: "",
  };
  const demos = [
    { id: "codex-fail", expectedExit: 1 },
    { id: "claude-pass", expectedExit: 0 },
    { id: "openmausbot-incomplete", expectedExit: 2 },
  ];
  for (const demo of demos) {
    const profile = path.join(ROOT, "tests", "fixtures", "demo", demo.id, "profile.json");
    const jsonOut = path.join(tmpDir, `${demo.id}.report.json`);
    const htmlOut = path.join(tmpDir, `${demo.id}.report.html`);
    const jsonRun = runCli(
      ["audit", "--profile", profile, "--ci", "--format", "json", "--out", jsonOut],
      deadProxy,
    );
    if (jsonRun.exitCode !== demo.expectedExit) {
      failures.push(
        `${demo.id} json via dead proxy: exit ${jsonRun.exitCode}, expected ${demo.expectedExit}; stderr: ${jsonRun.stderr.slice(0, 200)}`,
      );
      continue;
    }
    const htmlRun = runCli(
      ["audit", "--profile", profile, "--ci", "--format", "html", "--out", htmlOut],
      deadProxy,
    );
    if (htmlRun.exitCode !== demo.expectedExit) {
      failures.push(
        `${demo.id} html via dead proxy: exit ${htmlRun.exitCode}, expected ${demo.expectedExit}; stderr: ${htmlRun.stderr.slice(0, 200)}`,
      );
      continue;
    }
    for (const out of [jsonOut, htmlOut]) {
      const text = fs.readFileSync(out, "utf8");
      const hit = text.match(URL_PATTERN);
      if (hit !== null) {
        failures.push(`${path.basename(out)}: URL string ${JSON.stringify(hit[0])}`);
      }
    }
    const external = scanExternalResources(fs.readFileSync(htmlOut, "utf8"));
    if (external.length > 0) {
      failures.push(`${demo.id} html: external resources: ${external.join("; ")}`);
    }
  }
  return failures;
}

function checkDocs() {
  const failures = [];
  const docFiles = [
    path.join(ROOT, "README.md"),
    ...listFiles(path.join(ROOT, "docs"), [".md"]),
    ...listFiles(path.join(ROOT, ".github"), [".yml", ".yaml"]),
  ];
  for (const file of docFiles) {
    if (!fs.existsSync(file)) {
      failures.push(`${path.relative(ROOT, file)}: missing file`);
      continue;
    }
    const text = fs.readFileSync(file, "utf8");
    const hit = text.match(URL_PATTERN);
    if (hit !== null) {
      failures.push(`${path.relative(ROOT, file)}: URL string ${JSON.stringify(hit[0])}`);
    }
  }
  return failures;
}

function main() {
  execSync("npm run build", { cwd: ROOT, stdio: "pipe" });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-offline-"));
  const failures = [];
  try {
    const staticFailures = checkStatic();
    console.log(`static scan: ${staticFailures.length === 0 ? "OK (no network call sites, no https:// in dist)" : "FAIL"}`);
    failures.push(...staticFailures);

    const proxyFailures = checkDeadProxy(tmpDir);
    console.log(
      `dead-proxy demo audits: ${proxyFailures.length === 0 ? "OK (exit 1/0/2, no URLs in reports, no external resources)" : "FAIL"}`,
    );
    failures.push(...proxyFailures);

    const docFailures = checkDocs();
    console.log(`docs scan: ${docFailures.length === 0 ? "OK (no https:// in README/docs/workflows)" : "FAIL"}`);
    failures.push(...docFailures);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`offline-check: ${failure}`);
    }
    console.error(`offline-check: FAIL (${failures.length} violation(s))`);
    process.exit(1);
  }
  console.log("offline-check: PASS — no account, no LLM, no network, no real skills needed");
}

main();
