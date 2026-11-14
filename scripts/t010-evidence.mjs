#!/usr/bin/env node
/**
 * T010 evidence runner (P023 T010, S3).
 *
 * Produces the evidence for 03_evidence/T010/:
 *   - exit-code-matrix.json: the full exit-code matrix, measured by
 *     running the real built CLI (normal and --ci) against the three
 *     demo profiles plus the error cases.
 *   - command-log.txt: every command run, with its stdout/stderr.
 *   - readme-first-screen.png: the README's first screen (title,
 *     question, labels, scope-matrix image, install block) rendered
 *     to HTML and screenshotted with the local headless Chromium
 *     cache when one is present; recorded as skipped otherwise.
 *
 * Nothing here is asserted by hand: the matrix is written from the
 * measured exit codes, and the script exits non-zero if any measured
 * code differs from the contract (PASS 0, FAIL 1, INCOMPLETE 2,
 * input 3, internal 4).
 */

import { spawnSync, execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli", "index.js");
const OUT_DIR = path.join(ROOT, "03_evidence", "T010");

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

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function inlineMd(text) {
  return escapeHtml(text)
    .replace(/`([^`]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\*([^*]+)\*/g, "<em>$1</em>")
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '<img alt="$1" src="$2">')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>');
}

/**
 * Minimal Markdown renderer, just enough for the README's first
 * screen (headings, paragraphs, code blocks, lists, images, links).
 * It renders the actual README text — no hand-written HTML.
 */
function renderFirstScreen(markdown) {
  const lines = markdown.split("\n");
  const out = [];
  let inCode = false;
  let inList = false;
  const closeList = () => {
    if (inList) {
      out.push("</ul>");
      inList = false;
    }
  };
  for (const line of lines) {
    if (line.startsWith("## Quick start")) break;
    if (line.startsWith("```")) {
      closeList();
      if (inCode) {
        out.push("</code></pre>");
        inCode = false;
      } else {
        out.push('<pre><code>');
        inCode = true;
      }
      continue;
    }
    if (inCode) {
      out.push(`${escapeHtml(line)}\n`);
      continue;
    }
    if (line.startsWith("# ")) {
      closeList();
      out.push(`<h1>${inlineMd(line.slice(2))}</h1>`);
    } else if (line.startsWith("## ")) {
      closeList();
      out.push(`<h2>${inlineMd(line.slice(3))}</h2>`);
    } else if (line.startsWith("- ")) {
      if (!inList) {
        out.push("<ul>");
        inList = true;
      }
      out.push(`<li>${inlineMd(line.slice(2))}</li>`);
    } else if (line.trim() === "") {
      closeList();
    } else {
      closeList();
      out.push(`<p>${inlineMd(line)}</p>`);
    }
  }
  closeList();
  if (inCode) out.push("</code></pre>");
  return `<!doctype html><html><head><meta charset="utf-8"><style>
body{font-family:system-ui,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#111}
h1{font-size:28px} h2{font-size:20px}
pre{background:#f4f4f4;padding:12px;overflow-x:auto}
code{background:#f4f4f4;padding:1px 4px}
pre code{background:none;padding:0}
img{max-width:100%;border:1px solid #ddd}
</style></head><body>${out.join("\n")}</body></html>`;
}

function findHeadlessShell() {
  const cache = path.join(os.homedir(), ".cache", "ms-playwright");
  if (!fs.existsSync(cache)) return null;
  const candidates = [];
  for (const entry of fs.readdirSync(cache, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    for (const dir of ["chrome-linux", "chrome-linux64", "chrome-headless-shell-linux64"]) {
      for (const bin of ["headless_shell", "chrome-headless-shell", "chrome"]) {
        const full = path.join(cache, entry.name, dir, bin);
        if (fs.existsSync(full)) candidates.push(full);
      }
    }
  }
  candidates.sort();
  return candidates.length > 0 ? candidates[candidates.length - 1] : null;
}

function screenshotReadme() {
  const readme = fs.readFileSync(path.join(ROOT, "README.md"), "utf8");
  const htmlPath = path.join(OUT_DIR, "readme-first-screen.html");
  // The rendered copy lives in 03_evidence/T010/, so relative image
  // paths must be made absolute for the screenshot; the README itself
  // keeps its relative paths.
  const html = renderFirstScreen(readme).replace(
    'src="docs/',
    `src="file://${ROOT}/docs/`,
  );
  fs.writeFileSync(htmlPath, html, "utf8");
  const pngPath = path.join(OUT_DIR, "readme-first-screen.png");
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
      "--window-size=1000,1100",
      "--hide-scrollbars",
      `file://${htmlPath}`,
    ],
    { encoding: "utf8", timeout: 60000 },
  );
  if (spawned.status !== 0 || !fs.existsSync(pngPath)) {
    return `failed: exit ${spawned.status}; stderr: ${(spawned.stderr ?? "").slice(0, 300)}`;
  }
  return `ok: ${pngPath} (${fs.statSync(pngPath).size} bytes)`;
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  execSync("npm run build", { cwd: ROOT, stdio: "pipe" });
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-t010-"));
  const log = [];
  const matrix = [];
  const note = (text) => {
    log.push(text);
    console.log(text);
  };
  try {
    const cases = [
      { id: "codex-fail", profile: "codex-fail/profile.json", expected: 1, status: "FAIL" },
      { id: "claude-pass", profile: "claude-pass/profile.json", expected: 0, status: "PASS" },
      {
        id: "openmausbot-incomplete",
        profile: "openmausbot-incomplete/profile.json",
        expected: 2,
        status: "INCOMPLETE",
      },
    ];
    for (const c of cases) {
      for (const mode of ["normal", "ci"]) {
        const out = path.join(tmpDir, `${c.id}.${mode}.json`);
        const args = [
          "audit",
          "--profile",
          path.join(ROOT, "tests", "fixtures", "demo", c.profile),
          ...(mode === "ci" ? ["--ci"] : []),
          "--out",
          out,
        ];
        const run = runCli(args);
        const stdoutLines = run.stdout.split("\n").filter((l) => l.length > 0);
        const entry = {
          case: c.id,
          mode,
          expected_exit: c.expected,
          actual_exit: run.exitCode,
          expected_status: c.status,
          stdout_lines: stdoutLines.length,
          stdout: mode === "ci" ? (stdoutLines[0] ?? "") : undefined,
          report_written: fs.existsSync(out),
        };
        matrix.push(entry);
        note(
          `$ node dist/cli/index.js ${args.join(" ")} → exit ${run.exitCode} (expected ${c.expected}), stdout lines: ${stdoutLines.length}`,
        );
        if (run.exitCode !== c.expected) {
          throw new Error(`matrix mismatch: ${c.id} ${mode}: exit ${run.exitCode}, expected ${c.expected}`);
        }
        if (mode === "ci" && stdoutLines.length !== 1) {
          throw new Error(`matrix mismatch: ${c.id} ci: ${stdoutLines.length} stdout lines, expected exactly 1`);
        }
      }
    }
    // Error cases (CI mode).
    const errorCases = [
      {
        id: "missing-profile",
        args: ["audit", "--profile", path.join(tmpDir, "nope.json"), "--ci", "--out", path.join(tmpDir, "x.json")],
        expected: 3,
      },
      {
        id: "unwritable-out",
        args: [
          "audit",
          "--profile",
          path.join(ROOT, "tests", "fixtures", "demo", "claude-pass", "profile.json"),
          "--ci",
          "--out",
          path.join(tmpDir, "no-such-dir", "out.json"),
        ],
        expected: 4,
      },
      {
        id: "ci-on-init",
        args: ["init", "--ci", "--dir", tmpDir],
        expected: 3,
      },
      {
        id: "unknown-flag",
        args: [
          "audit",
          "--profile",
          path.join(ROOT, "tests", "fixtures", "demo", "codex-fail", "profile.json"),
          "--ci",
          "--bogus",
        ],
        expected: 3,
      },
    ];
    for (const c of errorCases) {
      const run = runCli(c.args);
      const stdoutLines = run.stdout.split("\n").filter((l) => l.length > 0);
      matrix.push({
        case: c.id,
        mode: "ci",
        expected_exit: c.expected,
        actual_exit: run.exitCode,
        stdout_lines: stdoutLines.length,
        stdout: stdoutLines[0] ?? "",
      });
      note(`$ node dist/cli/index.js ${c.args.join(" ")} → exit ${run.exitCode} (expected ${c.expected})`);
      if (run.exitCode !== c.expected) {
        throw new Error(`matrix mismatch: ${c.id}: exit ${run.exitCode}, expected ${c.expected}`);
      }
    }
    const shot = screenshotReadme();
    note(`readme screenshot: ${shot}`);
    fs.writeFileSync(
      path.join(OUT_DIR, "exit-code-matrix.json"),
      `${JSON.stringify({ schema: "skillscope.t010-exit-code-matrix/v1", entries: matrix }, null, 2)}\n`,
      "utf8",
    );
    note(`matrix: ${matrix.length} entries, all measured exit codes match the contract`);
  } finally {
    fs.writeFileSync(path.join(OUT_DIR, "command-log.txt"), `${log.join("\n")}\n`, "utf8");
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

main();
