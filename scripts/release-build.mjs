#!/usr/bin/env node
/**
 * Formal freeze (`npm run release:build`, P023 T014, S5).
 *
 * Freezes the final commit's source + runnable distribution:
 *
 *   1. Resolves the frozen commit. The freeze is PINNED by the
 *      manifest: if release/RELEASE_MANIFEST.json already exists
 *      and names a commit that exists in this repo, that commit is
 *      re-frozen (re-running the build regenerates byte-identical
 *      artifacts); otherwise the frozen commit is HEAD. The pin
 *      exists so a later release commit (which adds release/ itself
 *      to the tree) can never make `git archive` swallow the
 *      previous release artifacts into source.zip.
 *   2. The tracked tree must be clean, and the working tree must
 *      match the frozen commit everywhere except release/,
 *      03_evidence/T014/ (the report lands there after the build)
 *      and the two freeze-outcome bookkeeping files
 *      (00_control/TASK_BOARD.csv, 00_control/PROJECT_STATE.json
 *      — the release commit itself flips them to T014 PASS, so a
 *      post-freeze re-run must not trip over that sanctioned
 *      change). Nothing uncommitted is ever packaged.
 *   3. `git archive <frozen>` (prefix skillscope/) →
 *      release/source.zip. The frozen commit must carry S0 gate
 *      PASS with the known gate hash, T013 review P0=0/P1=0, and
 *      the MIT LICENSE file (Sam decided 2026-11-13 that ALL
 *      project licenses are MIT; the LICENSE content hash is
 *      pinned below and must match the canonical text). Before
 *      archiving, FIX-R2 (P1-R2-01) fails the build if any empty
 *      directory in the tree lacks .gitkeep — `git archive` drops
 *      empty dirs and the file-SHA manifest cannot see the loss
 *      (the R2 regression fixtures were lost exactly this way);
 *      release-verify additionally compares the frozen commit's
 *      directory set against source.zip's directory entries.
 *   4. Fresh `npm run build` → deterministic STORE dist.zip
 *      (scripts/release-zip.mjs: fixed 1980-01-01 timestamps,
 *      sorted entries) containing package.json, package-lock.json,
 *      README.md and LICENSE at the root, the whole dist/ tree, the
 *      schemas/ directory, the docs/ directory (README links
 *      docs/quickstart.md, docs/host-rules.md and
 *      docs/images/scope-matrix.png — FIX-R3, P2-R3-01) and
 *      src/adapters/openmausbot/openmausbot-snapshot-v1.json — the
 *      CLI reads schemas relative to the repo root at runtime
 *      (src/io/index.ts loadSchema) and tsc does not copy .json into
 *      dist/, so a dist.zip without them crashes on the first audit.
 *      FIX-R3 (P1-R3-01): the MIT LICENSE is a dist entry with its
 *      content hash pinned to EXPECTED_LICENSE_SHA256, package.json
 *      must claim `"license": "MIT"` and the README License section
 *      must state MIT — a standalone dist.zip carries substantial
 *      portions of the Software, so the MIT notice must travel
 *      with it, not only in source.zip. After `npm ci` the zip runs
 *      on its own.
 *   5. Clean-room rebuild: extract source.zip to a temp dir,
 *      symlink node_modules from the repo (the ONLY deviation from
 *      a cold checkout — no network is available or used for
 *      `npm ci`), `npm run build` there, and run the CLI smoke
 *      audit on the extracted demo fixture. The resulting
 *      audit_sha256 must equal the repo's own audit of the same
 *      profile (redaction makes the hash path-independent).
 *   6. dist.zip smoke run: extract dist.zip to a temp dir with
 *      package.json + linked node_modules and run the same audit
 *      from the extracted dist/ — the distributed build itself
 *      must run, not just the rebuilt one.
 *   7. release/RELEASE_FILE_LIST.csv (every frozen-commit file:
 *      path, bytes, content SHA-256, git blob SHA) and
 *      release/RELEASE_MANIFEST.json (fully deterministic given
 *      the frozen commit — the timestamp recorded is the frozen
 *      commit's committer date, never wall-clock time).
 *   8. release/SHA256SUMS.txt over source.zip, dist.zip and
 *      RELEASE_MANIFEST.json; `unzip -t` on both zips;
 *      `sha256sum -c SHA256SUMS.txt`.
 *
 * This script writes release/ only. The freeze report
 * (03_evidence/T014/T014_FREEZE_REPORT.md) is written separately
 * and committed together with release/ afterwards. Exit 0 only
 * when every check passes.
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { writeZip } from "./release-zip.mjs";

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const RELEASE_DIR = path.join(ROOT, "release");
export const MANIFEST_FILE = path.join(RELEASE_DIR, "RELEASE_MANIFEST.json");
export const EXPECTED_GATE_SHA256 =
  "a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca";
// Canonical MIT LICENSE text (Copyright (c) 2026 dcz66614), byte-identical
// to P021's LICENSE. Sam decided 2026-11-13 that ALL project licenses are
// MIT; FIX-R1 added this LICENSE to the repo root. T014 now pins the
// license by content hash instead of requiring its absence (ADR-026).
export const EXPECTED_LICENSE_SHA256 =
  "50b8b302ffcb53aec1866ad4b94721c200400e6aac8cee12db03b85f24e39ed2";
export const DEMO_PROFILE = path.join("tests", "fixtures", "demo", "codex-fail", "profile.json");

// The one documented public example token in the tree (jwt.io example,
// tests/fixtures/t008b/pii-sample.json + tests/privacy/privacy.test.ts).
// A secret scan must allow exactly this value and nothing else eyJ-like.
export const KNOWN_PUBLIC_JWT_EXAMPLE =
  "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";

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
export function sha256Hex(buf) {
  return crypto.createHash("sha256").update(buf).digest("hex");
}
export function sha256File(file) {
  return sha256Hex(fs.readFileSync(file));
}
export function run(cmd, args, opts = {}) {
  const spawned = spawnSync(cmd, args, { cwd: ROOT, encoding: "utf8", ...opts });
  return {
    exitCode: spawned.status ?? 4,
    stdout: spawned.stdout ?? "",
    stderr: spawned.stderr ?? "",
  };
}
function git(args, opts = {}) {
  return run("git", args, opts);
}
function gitOut(args, opts = {}) {
  const r = git(args, opts);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.slice(0, 200)}`);
  return r.stdout;
}

/** Resolve the frozen commit: existing manifest pin, else HEAD. */
export function resolveFrozenCommit() {
  if (fs.existsSync(MANIFEST_FILE)) {
    try {
      const pinned = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8")).frozen_commit;
      if (typeof pinned === "string" && /^[0-9a-f]{40}$/.test(pinned)) {
        const exists = git(["cat-file", "-t", pinned]);
        if (exists.exitCode === 0 && exists.stdout.trim() === "commit") {
          return { commit: pinned, pinned: true };
        }
      }
    } catch {
      // Fall through to HEAD below; a corrupt manifest is a failure
      // of the build, not a silent re-freeze — checked by the caller.
    }
    throw new Error(
      "release/RELEASE_MANIFEST.json exists but has no valid frozen_commit — " +
        "delete release/ for a fresh freeze or restore the manifest",
    );
  }
  return { commit: gitOut(["rev-parse", "HEAD"]).trim(), pinned: false };
}

/** SHA-256 of the LICENSE blob of a commit (null when the commit has none). */
export function licenseSha256FromCommit(commit) {
  try {
    const content = execFileSync("git", ["show", `${commit}:LICENSE`], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    return sha256Hex(content);
  } catch {
    return null;
  }
}

/** Every tracked file of a commit: [{ path, bytes, sha256, blob }]. */
export function fileListFromCommit(commit) {
  const ls = gitOut(["ls-tree", "-r", "-l", commit]);
  const files = [];
  for (const line of ls.split("\n")) {
    if (!line.trim()) continue;
    // "<mode> blob <sha> <size>\t<path>" (size "-" for submodules; none here)
    const tab = line.indexOf("\t");
    const meta = line.slice(0, tab).split(/\s+/);
    const blob = meta[2];
    const size = Number(meta[3]);
    const filePath = line.slice(tab + 1);
    const content = execFileSync("git", ["cat-file", "-p", blob], {
      cwd: ROOT,
      maxBuffer: 64 * 1024 * 1024,
    });
    files.push({
      path: filePath,
      bytes: content.length,
      sha256: sha256Hex(content),
      blob,
      lsSize: size,
    });
  }
  files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return files;
}

export function fileListCsv(files) {
  const rows = ["path,bytes,sha256,git_blob_sha"];
  for (const f of files) rows.push(`${f.path},${f.bytes},${f.sha256},${f.blob}`);
  return `${rows.join("\n")}\n`;
}

/**
 * FIX-R2 (P1-R2-01): leaf-empty directories in the working tree that
 * carry no .gitkeep. `git archive` drops empty directories, so such a
 * directory never reaches source.zip — and the file-SHA manifest
 * cannot see the loss. Only leaf directories (no files, no
 * subdirectories) are reported: an empty chain ends in one leaf, and
 * a .gitkeep in the leaf makes the whole chain survive the archive
 * (git tracks the file, creating all parents). Build outputs
 * (.git, node_modules, dist, release) are not part of the archive
 * and are skipped. Returns repo-relative paths, [] when clean.
 */
export function emptyDirsMissingGitkeep() {
  // Build outputs exist only at the repo root; a fixture skill dir
  // may legitimately be named "release" (e.g. project/release/),
  // so the skip applies to top-level entries only.
  const SKIP_TOP = new Set([".git", "node_modules", "dist", "release"]);
  const missing = [];
  const walk = (dir, top) => {
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    const subdirs = entries.filter((e) => e.isDirectory() && !(top && SKIP_TOP.has(e.name)));
    const files = entries.filter((e) => e.isFile() || e.isSymbolicLink());
    if (subdirs.length === 0 && files.length === 0) {
      missing.push(path.relative(ROOT, dir) || ".");
      return;
    }
    for (const sub of subdirs) walk(path.join(dir, sub.name), false);
  };
  walk(ROOT, true);
  return missing;
}

function environmentInfo() {
  const cpu = os.cpus()[0];
  return {
    node: process.version,
    npm: run("npm", ["-v"]).stdout.trim(),
    python: run("python3", ["--version"]).stdout.trim(),
    git: run("git", ["--version"]).stdout.trim(),
    platform: `${os.platform()} ${os.arch()}`,
    cpu_model: cpu ? cpu.model : "unknown",
    cpu_count: os.cpus().length,
    total_memory_bytes: os.totalmem(),
  };
}

/** Run the CLI smoke audit; returns { exitCode, auditSha256 }. */
function smokeAudit(cliJs, profileAbs, outAbs, cwd) {
  const r = run("node", [cliJs, "audit", "--profile", profileAbs, "--format", "json", "--out", outAbs], {
    cwd,
  });
  let auditSha256 = null;
  if (fs.existsSync(outAbs)) {
    try {
      auditSha256 = JSON.parse(fs.readFileSync(outAbs, "utf8")).audit_sha256 ?? null;
    } catch {
      auditSha256 = null;
    }
  }
  return { exitCode: r.exitCode, auditSha256, stderr: r.stderr };
}

export function collectDistEntries() {
  const entries = [];
  const walk = (dir, prefix) => {
    for (const name of fs.readdirSync(dir).sort()) {
      const abs = path.join(dir, name);
      const rel = `${prefix}${name}`;
      const st = fs.statSync(abs);
      if (st.isDirectory()) walk(abs, `${rel}/`);
      else entries.push({ path: rel, data: fs.readFileSync(abs) });
    }
  };
  for (const rootFile of ["package.json", "package-lock.json", "README.md", "LICENSE"]) {
    entries.push({ path: rootFile, data: fs.readFileSync(path.join(ROOT, rootFile)) });
  }
  walk(path.join(ROOT, "dist"), "dist/");
  // Runtime schema files: the CLI resolves them relative to the repo
  // root (src/io/index.ts loadSchema: REPO_ROOT is two levels above
  // dist/io/), and tsc does not copy .json into dist/. A dist.zip
  // without them crashes on the first audit (ENOENT), which the
  // first T014 build caught in its own smoke run. Include the whole
  // schemas/ directory plus the one schema JSON that lives under
  // src/ (OpenMausBot snapshot schema, also loaded via loadSchema).
  walk(path.join(ROOT, "schemas"), "schemas/");
  // FIX-R3 (P2-R3-01): the README links docs/quickstart.md,
  // docs/host-rules.md and docs/images/scope-matrix.png, so the
  // docs/ directory ships with dist.zip instead of dangling.
  walk(path.join(ROOT, "docs"), "docs/");
  entries.push({
    path: "src/adapters/openmausbot/openmausbot-snapshot-v1.json",
    data: fs.readFileSync(path.join(ROOT, "src", "adapters", "openmausbot", "openmausbot-snapshot-v1.json")),
  });
  return entries;
}

function main() {
  const startedUtc = new Date().toISOString();
  note(`release:build started ${startedUtc}`);

  // 0. Resolve + guard the frozen commit.
  let frozen;
  try {
    frozen = resolveFrozenCommit();
  } catch (err) {
    check("resolve frozen commit", false, err.message);
    process.exit(1);
  }
  const frozenCommit = frozen.commit;
  note(`frozen commit: ${frozenCommit}${frozen.pinned ? " (pinned by existing manifest)" : " (HEAD)"}`);
  check("frozen commit exists in git", git(["cat-file", "-t", frozenCommit]).stdout.trim() === "commit");

  const status = gitOut(["status", "--short"]).trim();
  const dirtyTracked = status
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith("??"));
  check("tracked tree clean at freeze", dirtyTracked.length === 0, dirtyTracked.join("; "));

  const diff = git(["diff", "--quiet", frozenCommit, "--", ".", ":!release", ":!03_evidence/T014", ":!00_control/TASK_BOARD.csv", ":!00_control/PROJECT_STATE.json"]);
  check("working tree matches frozen commit (except release/, T014 report, freeze-outcome bookkeeping)", diff.exitCode === 0);

  // Frozen-commit gates: S0 gate, T013 review, no LICENSE.
  let gateSha = null;
  let review = null;
  try {
    const gateJson = JSON.parse(gitOut(["show", `${frozenCommit}:03_evidence/S0/S0_GATE.json`]));
    gateSha = gateJson.gate_sha256;
    check("frozen S0 gate status PASS", gateJson.status === "PASS", `status ${gateJson.status}`);
    check("frozen S0 gate hash is the known value", gateSha === EXPECTED_GATE_SHA256, gateSha);
  } catch (err) {
    check("read frozen S0 gate", false, err.message);
  }
  try {
    const report = gitOut(["show", `${frozenCommit}:03_evidence/T013/T013_REPORT.md`]);
    const m = report.match(/P0=(\d+)，P1=(\d+)，P2=(\d+)/);
    if (!m) throw new Error("P0/P1/P2 counts not found in T013 report");
    review = { p0: Number(m[1]), p1: Number(m[2]), p2: Number(m[3]) };
    check("frozen T013 review P0=0", review.p0 === 0, `P0=${review.p0}`);
    check("frozen T013 review P1=0", review.p1 === 0, `P1=${review.p1}`);
    note(`frozen T013 review: P0=${review.p0} P1=${review.p1} P2=${review.p2} (non-blocking)`);
  } catch (err) {
    check("read frozen T013 review", false, err.message);
  }
  const treeNames = gitOut(["ls-tree", "-r", "--name-only", frozenCommit])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  check(
    "MIT LICENSE exists in frozen commit with the canonical content hash",
    treeNames.includes("LICENSE") && licenseSha256FromCommit(frozenCommit) === EXPECTED_LICENSE_SHA256,
    `LICENSE present: ${treeNames.includes("LICENSE")}, sha256 ${licenseSha256FromCommit(frozenCommit)}`,
  );
  check("release scripts exist in frozen commit", treeNames.includes("scripts/release-build.mjs") && treeNames.includes("scripts/release-verify.mjs"));

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-freeze-"));
  const sourceZipTmp = path.join(work, "source.zip");
  const distZipTmp = path.join(work, "dist.zip");
  let sourceSize = 0;
  let distSize = 0;
  let sourceSha = "";
  let distSha = "";
  let cleanAuditSha = null;
  let repoAuditSha = null;
  let distAuditSha = null;
  let fileList = [];
  try {
    // FIX-R2 (P1-R2-01): fail BEFORE archiving if any empty directory
    // in the frozen tree lacks .gitkeep — git archive drops empty
    // dirs, and the file-SHA manifest cannot see them. A fixture
    // directory a test needs to EXIST (empty skills dir: missing vs
    // empty changes scanSkillsDir's outcome) would silently vanish
    // from source.zip, exactly as the R2 regression fixtures did.
    const emptyNoKeep = emptyDirsMissingGitkeep();
    check(
      "no empty directory without .gitkeep (git archive drops empty dirs)",
      emptyNoKeep.length === 0,
      emptyNoKeep.join("; "),
    );

    // 1. Source zip from the frozen commit.
    const archive = git([
      "archive",
      "--format=zip",
      "--prefix=skillscope/",
      "-o",
      sourceZipTmp,
      frozenCommit,
    ]);
    check("git archive frozen commit → source.zip", archive.exitCode === 0, archive.stderr.slice(0, 300));
    if (fs.existsSync(sourceZipTmp)) {
      sourceSize = fs.statSync(sourceZipTmp).size;
      sourceSha = sha256File(sourceZipTmp);
    }
    check("source.zip non-empty", sourceSize > 0, `${sourceSize} bytes`);

    // File list from the frozen commit (also the source.zip oracle).
    fileList = fileListFromCommit(frozenCommit);
    check("file list covers every frozen-commit file", fileList.length === treeNames.length, `${fileList.length} files`);
    const sizeMismatch = fileList.filter((f) => f.bytes !== f.lsSize);
    check("file list sizes match git ls-tree sizes", sizeMismatch.length === 0, sizeMismatch.map((f) => f.path).join("; "));

    // 2. Fresh build → deterministic dist zip.
    const build = run("npm", ["run", "build"]);
    check("npm run build (fresh)", build.exitCode === 0, build.stderr.slice(0, 300));
    const distEntries = collectDistEntries();
    check("dist.zip entries include CLI bin", distEntries.some((e) => e.path === "dist/cli/index.js"));
    check("dist.zip entries include package files", ["package.json", "package-lock.json", "README.md"].every((f) => distEntries.some((e) => e.path === f)));
    check(
      "dist.zip entries include runtime schemas (CLI reads them via REPO_ROOT)",
      ["schemas/skillscope-profile-v1.json", "schemas/skillscope-report-v1.json", "schemas/skillscope-audit-result-v1.json", "src/adapters/openmausbot/openmausbot-snapshot-v1.json"].every((f) =>
        distEntries.some((e) => e.path === f),
      ),
    );
    fs.writeFileSync(distZipTmp, writeZip(distEntries));
    distSize = fs.statSync(distZipTmp).size;
    distSha = sha256File(distZipTmp);
    check("dist.zip non-empty", distSize > 0, `${distSize} bytes, ${distEntries.length} entries`);
    // FIX-R3 (P1-R3-01): dist.zip is a standalone distribution, so
    // the MIT LICENSE must travel with it — presence AND content
    // hash, never just the manifest's word for it. The README's
    // License section and package.json must agree with MIT too.
    const distLicense = distEntries.find((e) => e.path === "LICENSE");
    check(
      "dist.zip contains MIT LICENSE with the canonical content hash",
      distLicense !== undefined && sha256Hex(distLicense.data) === EXPECTED_LICENSE_SHA256,
      distLicense ? `sha256 ${sha256Hex(distLicense.data)}` : "LICENSE entry missing",
    );
    const distPkg = JSON.parse(distEntries.find((e) => e.path === "package.json").data.toString("utf8"));
    check('dist package.json claims "license": "MIT"', distPkg.license === "MIT", `license ${distPkg.license}`);
    const distReadme = distEntries.find((e) => e.path === "README.md").data.toString("utf8");
    check(
      "dist README License section states MIT (no Pending Sam claim)",
      /^## License\n\nMIT/m.test(distReadme) && !/Pending Sam/.test(distReadme),
      distReadme.match(/^## License\n\n.*$/m)?.[0] ?? "no License section",
    );
    // FIX-R3 (P2-R3-01): every file the README links under docs/
    // must actually ship in dist.zip.
    check(
      "dist.zip contains the docs/ files the README links",
      ["docs/quickstart.md", "docs/host-rules.md", "docs/images/scope-matrix.png"].every((f) =>
        distEntries.some((e) => e.path === f),
      ),
    );

    // 3. Clean-room rebuild + smoke audit from source.zip.
    const cleanDir = path.join(work, "clean");
    fs.mkdirSync(cleanDir, { recursive: true });
    const extract = run("unzip", ["-q", sourceZipTmp, "-d", cleanDir]);
    check("extract source.zip to clean dir", extract.exitCode === 0, extract.stderr.slice(0, 300));
    const cleanRoot = path.join(cleanDir, "skillscope");
    check(
      "clean tree has package.json + src + tests",
      fs.existsSync(path.join(cleanRoot, "package.json")) &&
        fs.existsSync(path.join(cleanRoot, "src")) &&
        fs.existsSync(path.join(cleanRoot, "tests")),
    );
    const gitkeeps = gitOut(["ls-files", "**/.gitkeep"])
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
    // LICENSE must be present in the extracted tree (MIT, canonical text).
    check(
      "MIT LICENSE present in extracted source tree",
      fs.existsSync(path.join(cleanRoot, "LICENSE")) &&
        sha256File(path.join(cleanRoot, "LICENSE")) === EXPECTED_LICENSE_SHA256,
    );
    // No node_modules / .git / dist sneaked into the archive.
    const forbiddenInZip = ["node_modules/", ".git/", "dist/", "release/"].filter((p) =>
      fs.existsSync(path.join(cleanRoot, p)),
    );
    check("no node_modules/.git/dist/release in source.zip", forbiddenInZip.length === 0, forbiddenInZip.join("; "));
    // No network: link the repo's node_modules instead of `npm ci`.
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(cleanRoot, "node_modules"), "dir");
    const cleanBuild = run("npm", ["run", "build"], { cwd: cleanRoot });
    check("clean-room npm run build (linked node_modules)", cleanBuild.exitCode === 0, cleanBuild.stderr.slice(0, 300));
    const cleanOut = path.join(work, "clean-smoke.json");
    const cleanAudit = smokeAudit(
      path.join(cleanRoot, "dist", "cli", "index.js"),
      path.join(cleanRoot, DEMO_PROFILE),
      cleanOut,
      cleanRoot,
    );
    check("clean-room smoke audit exits 1 (codex-fail)", cleanAudit.exitCode === 1, `exit ${cleanAudit.exitCode}; ${cleanAudit.stderr.slice(0, 200)}`);
    cleanAuditSha = cleanAudit.auditSha256;

    // Repo smoke audit (same profile, repo dist).
    const repoOut = path.join(work, "repo-smoke.json");
    const repoAudit = smokeAudit(
      path.join(ROOT, "dist", "cli", "index.js"),
      path.join(ROOT, DEMO_PROFILE),
      repoOut,
      ROOT,
    );
    check("repo smoke audit exits 1 (codex-fail)", repoAudit.exitCode === 1, `exit ${repoAudit.exitCode}`);
    repoAuditSha = repoAudit.auditSha256;
    check(
      "clean-room audit_sha256 == repo audit_sha256 (path-independent redaction)",
      cleanAuditSha !== null && cleanAuditSha === repoAuditSha,
      `clean ${cleanAuditSha} vs repo ${repoAuditSha}`,
    );

    // 4. dist.zip smoke run: the distributed build itself must run.
    const distDir = path.join(work, "dist-test");
    fs.mkdirSync(distDir, { recursive: true });
    const distExtract = run("unzip", ["-q", distZipTmp, "-d", distDir]);
    check("extract dist.zip to temp dir", distExtract.exitCode === 0, distExtract.stderr.slice(0, 300));
    fs.symlinkSync(path.join(ROOT, "node_modules"), path.join(distDir, "node_modules"), "dir");
    const distOut = path.join(work, "dist-smoke.json");
    const distAudit = smokeAudit(
      path.join(distDir, "dist", "cli", "index.js"),
      path.join(ROOT, DEMO_PROFILE),
      distOut,
      distDir,
    );
    check("dist.zip smoke audit exits 1 (codex-fail)", distAudit.exitCode === 1, `exit ${distAudit.exitCode}; ${distAudit.stderr.slice(0, 200)}`);
    distAuditSha = distAudit.auditSha256;
    check(
      "dist.zip audit_sha256 == repo audit_sha256",
      distAuditSha !== null && distAuditSha === repoAuditSha,
      `dist ${distAuditSha} vs repo ${repoAuditSha}`,
    );
  } finally {
    // Publish the artifacts (even on partial failure, so the failure
    // is inspectable; the exit code still reports FAIL).
    fs.mkdirSync(RELEASE_DIR, { recursive: true });
    if (fs.existsSync(sourceZipTmp)) fs.copyFileSync(sourceZipTmp, path.join(RELEASE_DIR, "source.zip"));
    if (fs.existsSync(distZipTmp)) fs.copyFileSync(distZipTmp, path.join(RELEASE_DIR, "dist.zip"));
    fs.writeFileSync(path.join(RELEASE_DIR, "RELEASE_FILE_LIST.csv"), fileListCsv(fileList), "utf8");
    const frozenDate = gitOut(["show", "-s", "--format=%cI", frozenCommit]).trim();
    const manifest = {
      schema: "skillscope.release-manifest/v1",
      project: "P023 SkillScope",
      spec_version: "1.0.0",
      license: "MIT",
      frozen_commit: frozenCommit,
      frozen_commit_date: frozenDate,
      s0_gate: { status: "PASS", gate_sha256: gateSha, seed: "P023-SKILLSCOPE-S0-2026-11-13" },
      review: { task: "T013", p0: review ? review.p0 : null, p1: review ? review.p1 : null, p2: review ? review.p2 : null },
      generated_by: "npm run release:build (scripts/release-build.mjs)",
      generation: {
        source_zip: `git archive --format=zip --prefix=skillscope/ ${frozenCommit}`,
        dist_zip:
          "npm run build (fresh, immediately before packaging) + deterministic STORE zip " +
          "(scripts/release-zip.mjs: fixed 1980-01-01 timestamps, entries sorted by path); " +
          "entries are package.json, package-lock.json, README.md and LICENSE at the root, dist/<path>, " +
          "schemas/<path>, docs/<path> and src/adapters/openmausbot/openmausbot-snapshot-v1.json " +
          "(the CLI reads schemas relative to the repo root at runtime; tsc does not copy .json into dist/); " +
          "LICENSE content hash is pinned to 50b8b302… (FIX-R3, P1-R3-01) and the README links under docs/ ship with it (P2-R3-01)",
        note:
          "Re-running release:build re-freezes the manifest-pinned frozen commit and " +
          "regenerates byte-identical artifacts; delete release/ for a fresh freeze of HEAD. " +
          "The clean-room rebuild links the repo node_modules instead of `npm ci` (no network).",
      },
      source_zip: { file: "source.zip", bytes: sourceSize, sha256: sourceSha, file_count: fileList.length },
      dist_zip: { file: "dist.zip", bytes: distSize, sha256: distSha },
      clean_room_audit_sha256: cleanAuditSha,
      repo_audit_sha256: repoAuditSha,
      dist_zip_audit_sha256: distAuditSha,
      environment: environmentInfo(),
    };
    fs.writeFileSync(MANIFEST_FILE, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
    const manifestSha = sha256File(MANIFEST_FILE);
    fs.writeFileSync(
      path.join(RELEASE_DIR, "SHA256SUMS.txt"),
      `${sourceSha}  source.zip\n${distSha}  dist.zip\n${manifestSha}  RELEASE_MANIFEST.json\n`,
      "utf8",
    );
    // Basic integrity of what was just written.
    const testSource = run("unzip", ["-t", path.join(RELEASE_DIR, "source.zip")]);
    check("unzip -t release/source.zip", testSource.exitCode === 0, testSource.stdout.split("\n").slice(-2).join(" "));
    const testDist = run("unzip", ["-t", path.join(RELEASE_DIR, "dist.zip")]);
    check("unzip -t release/dist.zip", testDist.exitCode === 0, testDist.stdout.split("\n").slice(-2).join(" "));
    const sums = spawnSync("sha256sum", ["-c", "SHA256SUMS.txt"], { cwd: RELEASE_DIR, encoding: "utf8" });
    check("sha256sum -c release/SHA256SUMS.txt", sums.status === 0, (sums.stdout ?? "").trim());
    fs.rmSync(work, { recursive: true, force: true });
    note(`release:build ${failures.length === 0 ? "PASS" : "FAIL"} — frozen ${frozenCommit}`);
    note(`source.zip ${sourceSize} B sha256 ${sourceSha}`);
    note(`dist.zip ${distSize} B sha256 ${distSha}`);
    if (failures.length > 0) {
      console.error(`release:build FAILED — ${failures.join("; ")}`);
      process.exit(1);
    }
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`release:build FAILED with exception: ${err.message}`);
    process.exit(1);
  }
}
