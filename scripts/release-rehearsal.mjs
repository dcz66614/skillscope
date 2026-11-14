#!/usr/bin/env node
/**
 * Release rehearsal (`node scripts/release-rehearsal.mjs`, P023 T012, S4).
 *
 * Rehearses the T014 freeze/packaging flow against the current
 * committed HEAD — without writing anything into release/ (T014
 * owns that) and without touching business code:
 *
 *   1. The tree must be clean for tracked files (git archive only
 *      takes HEAD; untracked evidence files are ignored).
 *   2. `git archive HEAD` → source rehearsal zip (prefix
 *      skillscope/), `zip` of the freshly built dist/ → dist
 *      rehearsal zip.
 *   3. SHA256SUMS.txt over both zips; `unzip -t` on both;
 *      `sha256sum -c SHA256SUMS.txt`.
 *   4. Clean-room rebuild: extract the source zip to a temp dir,
 *      symlink node_modules from the repo (the ONLY deviation from
 *      a cold checkout — no network is available or used for
 *      `npm ci`), `npm run build` there, and run the CLI smoke
 *      audit on the extracted demo fixture. The resulting
 *      audit_sha256 must equal the repo's own audit of the same
 *      profile (redaction makes the hash path-independent).
 *   5. The zips, SHA256SUMS.txt and a manifest are kept as
 *      evidence in 03_evidence/T012/rehearsal/; the report is
 *      03_evidence/T012/RELEASE_REHEARSAL.md.
 *
 * This is a REHEARSAL, not the freeze: T014 redoes the whole flow
 * from the frozen commit (which will include the T012 evidence).
 * Exit 0 only when every check passes.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const OUT_DIR = path.join(ROOT, "03_evidence", "T012");
const REHEARSAL_DIR = path.join(OUT_DIR, "rehearsal");
const REPORT = path.join(OUT_DIR, "RELEASE_REHEARSAL.md");

const failures = [];
const log = [];
function note(line) {
  log.push(line);
  console.log(line);
}
function check(name, ok, detail = "") {
  note(`[${ok ? "PASS" : "FAIL"}] ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) {
    failures.push(name);
  }
  return ok;
}
function sha256(file) {
  return crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
}
function run(cmd, args, opts = {}) {
  const spawned = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  return {
    exitCode: spawned.status ?? 4,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
  };
}

function main() {
  const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" }).trim();
  const status = execFileSync("git", ["status", "--short"], { cwd: ROOT, encoding: "utf8" }).trim();
  const dirtyTracked = status
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith("??"));
  check("tracked tree clean at rehearsal commit", dirtyTracked.length === 0, dirtyTracked.join("; "));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-rehearsal-"));
  const sourceZip = path.join(work, "source.zip");
  const distZip = path.join(work, "dist.zip");
  const sumsFile = path.join(work, "SHA256SUMS.txt");
  let sourceSize = 0;
  let distSize = 0;
  let sourceSha = "";
  let distSha = "";
  let cleanAuditSha = null;
  let repoAuditSha = null;
  try {
    // 1. Source zip from the frozen commit.
    const archive = run("git", ["archive", "--format=zip", "--prefix=skillscope/", "-o", sourceZip, "HEAD"]);
    check("git archive HEAD → source.zip", archive.exitCode === 0, archive.stderr.slice(0, 300));
    if (fs.existsSync(sourceZip)) {
      sourceSize = fs.statSync(sourceZip).size;
      sourceSha = sha256(sourceZip);
    }
    check("source.zip non-empty", sourceSize > 0, `${sourceSize} bytes`);

    // 2. Dist zip from a fresh build.
    const build = run("npm", ["run", "build"]);
    check("npm run build", build.exitCode === 0, build.stderr.slice(0, 300));
    const zip = run("zip", ["-r", "-q", distZip, "dist"]);
    check("zip -r dist.zip dist", zip.exitCode === 0, zip.stderr.slice(0, 300));
    if (fs.existsSync(distZip)) {
      distSize = fs.statSync(distZip).size;
      distSha = sha256(distZip);
    }
    check("dist.zip non-empty", distSize > 0, `${distSize} bytes`);

    // 3. SHA256SUMS + integrity checks.
    fs.writeFileSync(
      sumsFile,
      `${sourceSha}  source.zip\n${distSha}  dist.zip\n`,
      "utf8",
    );
    const testSource = run("unzip", ["-t", sourceZip]);
    check("unzip -t source.zip", testSource.exitCode === 0, testSource.stdout.split("\n").slice(-2).join(" "));
    const testDist = run("unzip", ["-t", distZip]);
    check("unzip -t dist.zip", testDist.exitCode === 0, testDist.stdout.split("\n").slice(-2).join(" "));
    const sums = spawnSync("sha256sum", ["-c", "SHA256SUMS.txt"], { cwd: work, encoding: "utf8" });
    check("sha256sum -c SHA256SUMS.txt", sums.status === 0, (sums.stdout ?? "").trim());

    // 4. Clean-room rebuild + smoke audit (no network anywhere).
    const cleanDir = path.join(work, "clean");
    fs.mkdirSync(cleanDir, { recursive: true });
    const extract = run("unzip", ["-q", sourceZip, "-d", cleanDir]);
    check("extract source.zip to clean dir", extract.exitCode === 0, extract.stderr.slice(0, 300));
    const cleanRoot = path.join(cleanDir, "skillscope");
    check("clean tree has package.json + src + tests", fs.existsSync(path.join(cleanRoot, "package.json")) && fs.existsSync(path.join(cleanRoot, "src")) && fs.existsSync(path.join(cleanRoot, "tests")));
    // Empty skills dirs are kept in git via .gitkeep placeholders
    // (T012 fix: `git archive` drops empty dirs, and a missing
    // skills dir is fail-closed SOURCE_NOT_ENUMERATED, not empty).
    // Every directory holding a tracked .gitkeep must exist in the
    // extracted tree.
    const gitkeeps = execFileSync("git", ["ls-files", "**/.gitkeep"], { cwd: ROOT, encoding: "utf8" })
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const missingDirs = gitkeeps
      .map((rel) => path.join(cleanRoot, path.dirname(rel)))
      .filter((dir) => !fs.existsSync(dir));
    check(
      `all ${gitkeeps.length} .gitkeep directories present in clean tree`,
      missingDirs.length === 0,
      missingDirs.join("; "),
    );
    // No network: link the repo's node_modules instead of `npm ci`.
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(cleanRoot, "node_modules"), "dir");
    const cleanBuild = run("npm", ["run", "build"], { cwd: cleanRoot });
    check("clean-room npm run build (linked node_modules)", cleanBuild.exitCode === 0, cleanBuild.stderr.slice(0, 300));
    const cleanOut = path.join(work, "clean-smoke.json");
    const cleanAudit = run(
      "node",
      [
        path.join(cleanRoot, "dist", "cli", "index.js"),
        "audit",
        "--profile",
        path.join(cleanRoot, "tests", "fixtures", "demo", "codex-fail", "profile.json"),
        "--format",
        "json",
        "--out",
        cleanOut,
      ],
      { cwd: cleanRoot },
    );
    check("clean-room smoke audit exits 1 (codex-fail)", cleanAudit.exitCode === 1, `exit ${cleanAudit.exitCode}; ${cleanAudit.stderr.slice(0, 200)}`);
    if (fs.existsSync(cleanOut)) {
      cleanAuditSha = JSON.parse(fs.readFileSync(cleanOut, "utf8")).audit_sha256;
    }
    const repoOut = path.join(work, "repo-smoke.json");
    const repoAudit = run("node", [
      path.join(ROOT, "dist", "cli", "index.js"),
      "audit",
      "--profile",
      path.join(ROOT, "tests", "fixtures", "demo", "codex-fail", "profile.json"),
      "--format",
      "json",
      "--out",
      repoOut,
    ]);
    check("repo smoke audit exits 1 (codex-fail)", repoAudit.exitCode === 1, `exit ${repoAudit.exitCode}`);
    if (fs.existsSync(repoOut)) {
      repoAuditSha = JSON.parse(fs.readFileSync(repoOut, "utf8")).audit_sha256;
    }
    check(
      "clean-room audit_sha256 == repo audit_sha256 (path-independent redaction)",
      cleanAuditSha !== null && cleanAuditSha === repoAuditSha,
      `clean ${cleanAuditSha} vs repo ${repoAuditSha}`,
    );
  } finally {
    // Keep the artifacts as evidence.
    fs.mkdirSync(REHEARSAL_DIR, { recursive: true });
    for (const [src, dest] of [
      [sourceZip, "source.zip"],
      [distZip, "dist.zip"],
      [sumsFile, "SHA256SUMS.txt"],
    ]) {
      if (fs.existsSync(src)) {
        fs.copyFileSync(src, path.join(REHEARSAL_DIR, dest));
      }
    }
    const manifest = {
      schema: "skillscope.release-rehearsal/v1",
      generated_utc: new Date().toISOString(),
      head_commit: head,
      source_zip: { file: "source.zip", bytes: sourceSize, sha256: sourceSha },
      dist_zip: { file: "dist.zip", bytes: distSize, sha256: distSha },
      clean_room_audit_sha256: cleanAuditSha,
      repo_audit_sha256: repoAuditSha,
      verdict: failures.length === 0 ? "PASS" : "FAIL",
      failures,
    };
    fs.writeFileSync(
      path.join(REHEARSAL_DIR, "REHEARSAL_MANIFEST.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    fs.rmSync(work, { recursive: true, force: true });
    const report = [
      "# RELEASE_REHEARSAL.md — P023 T012 发布预演（非冻结）",
      "",
      `- HEAD commit: \`${head}\``,
      `- 生成时间 (UTC)：${manifest.generated_utc}`,
      "- 说明：本预演复现 T014 的打包流程（git archive → dist zip → SHA256SUMS → unzip -t → sha256sum -c → 干净目录重建 + 烟囱审计），但产物在 `03_evidence/T012/rehearsal/`，不写 `release/`；T014 将从冻结 commit 重新完整执行。",
      "- 唯一偏离冷检出的地方：干净目录用 symlink 链接本仓库的 `node_modules` 代替 `npm ci`（本机不联网，不可用也不需要网络）；构建与审计均在该目录内完成。",
      "",
      "## 产物",
      "",
      "| 文件 | 字节 | sha256 |",
      "|---|---:|---|",
      `| rehearsal/source.zip | ${sourceSize} | \`${sourceSha}\` |`,
      `| rehearsal/dist.zip | ${distSize} | \`${distSha}\` |`,
      "",
      "## 检查",
      "",
      ...log.map((line) => `- ${line}`),
      "",
      `## 结论：${manifest.verdict}`,
      "",
      `- clean-room audit_sha256：\`${cleanAuditSha}\``,
      `- repo audit_sha256：\`${repoAuditSha}\``,
      failures.length > 0 ? `- 失败：${failures.join("; ")}` : "- 全部检查通过。",
      "",
    ].join("\n");
    fs.writeFileSync(REPORT, report, "utf8");
    note(`release rehearsal: ${manifest.verdict} — report ${REPORT}`);
    if (failures.length > 0) {
      console.error(`release rehearsal: FAIL — ${failures.join("; ")}`);
      process.exit(1);
    }
  }
}

main();
