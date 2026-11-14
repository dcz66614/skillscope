/**
 * Offline tests (P023 T012, S4).
 *
 * Proves the product needs no account, no LLM, no network and no
 * real skills to run — the same promise scripts/offline-check.mjs
 * proves as a script (`npm run test:offline`), here as vitest
 * assertions inside `npm test`:
 *
 *   1. Dead-proxy run: the three demo audits are spawned with
 *      http_proxy/https_proxy pointed at a blackholed address
 *      (127.0.0.1:9). Any attempted HTTP call would fail; the
 *      audits must still return their frozen exit codes 1/0/2.
 *   2. Static scan: no network call sites in src/, scripts/*.mjs
 *      or the built dist/ (same pattern list as
 *      scripts/offline-check.mjs; the checker script itself is
 *      excluded because its pattern list necessarily contains the
 *      literals, and this test file is not scanned — it lives in
 *      tests/, not in src/, scripts/ or dist/).
 *   3. Output scan: the JSON and HTML reports contain no http://
 *      or https:// URLs.
 *
 * Reports are written to a temp directory (never into the fixture
 * tree) and deleted afterwards.
 */

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { scanExternalResources } from "../../src/report/index.js";

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const DEMO = path.join(REPO_ROOT, "tests", "fixtures", "demo");
const CLI_BIN = path.join(REPO_ROOT, "dist", "cli", "index.js");

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

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-offline-"));
}

function listFiles(dir: string, exts: string[]): string[] {
  const out: string[] = [];
  if (!fs.existsSync(dir)) {
    return out;
  }
  const walk = (d: string) => {
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "node_modules") {
          continue;
        }
        walk(full);
      } else if (entry.isFile() && exts.some((ext) => full.endsWith(ext))) {
        out.push(full);
      }
    }
  };
  walk(dir);
  return out;
}

describe("offline: no account, no LLM, no network, no real skills", () => {
  it("dead-proxy run: demo audits keep frozen exit codes 1/0/2", () => {
    const dir = tmpDir();
    const deadEnv = {
      ...process.env,
      http_proxy: "http://127.0.0.1:9",
      https_proxy: "http://127.0.0.1:9",
      HTTP_PROXY: "http://127.0.0.1:9",
      HTTPS_PROXY: "http://127.0.0.1:9",
      no_proxy: "",
      NO_PROXY: "",
    };
    for (const [id, expectedExit] of [
      ["codex-fail", 1],
      ["claude-pass", 0],
      ["openmausbot-incomplete", 2],
    ] as const) {
      const out = path.join(dir, `${id}.report.json`);
      const spawned = spawnSync(
        process.execPath,
        [CLI_BIN, "audit", "--profile", path.join(DEMO, id, "profile.json"), "--format", "json", "--out", out],
        { cwd: REPO_ROOT, encoding: "utf8", env: deadEnv },
      );
      expect(spawned.status).toBe(expectedExit);
      expect(fs.existsSync(out)).toBe(true);
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("static scan: no network call sites in src/, scripts/*.mjs or dist/", () => {
    const files = [
      ...listFiles(path.join(REPO_ROOT, "src"), [".ts"]),
      ...listFiles(path.join(REPO_ROOT, "scripts"), [".mjs"]).filter(
        (file) => path.basename(file) !== "offline-check.mjs",
      ),
      ...listFiles(path.join(REPO_ROOT, "dist"), [".js"]),
    ];
    expect(files.length).toBeGreaterThan(0);
    const hits: string[] = [];
    for (const file of files) {
      const content = fs.readFileSync(file, "utf8");
      for (const pattern of NETWORK_CALL_PATTERNS) {
        if (pattern.test(content)) {
          hits.push(`${path.relative(REPO_ROOT, file)}: ${pattern}`);
        }
      }
    }
    expect(hits).toEqual([]);
  });

  it("output scan: JSON and HTML reports contain no http(s):// URLs", () => {
    const dir = tmpDir();
    const expected: Record<string, number> = {
      "codex-fail": 1,
      "claude-pass": 0,
      "openmausbot-incomplete": 2,
    };
    for (const id of ["codex-fail", "claude-pass", "openmausbot-incomplete"]) {
      for (const format of ["json", "html"] as const) {
        const out = path.join(dir, `${id}.report.${format}`);
        const spawned = spawnSync(
          process.execPath,
          [CLI_BIN, "audit", "--profile", path.join(DEMO, id, "profile.json"), "--format", format, "--out", out],
          { cwd: REPO_ROOT, encoding: "utf8" },
        );
        expect(spawned.status).toBe(expected[id]);
        expect(fs.existsSync(out)).toBe(true);
        const content = fs.readFileSync(out, "utf8");
        expect(URL_PATTERN.test(content)).toBe(false);
        if (format === "html") {
          expect(scanExternalResources(content)).toEqual([]);
        }
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
});
