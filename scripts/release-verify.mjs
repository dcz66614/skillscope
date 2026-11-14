#!/usr/bin/env node
/**
 * Release verification (`npm run release:verify`, P023 T014, S5).
 *
 * Independently re-checks everything release:build produced, from
 * the artifacts on disk and the frozen commit — it never trusts the
 * manifest's word for a hash or a count. The working-tree check
 * excludes release/, 03_evidence/T014/ and the two freeze-outcome
 * bookkeeping files (00_control/TASK_BOARD.csv,
 * 00_control/PROJECT_STATE.json — the release commit itself flips
 * them to T014 PASS), so a post-freeze re-run passes:
 *
 *   1. release/ holds source.zip, dist.zip, SHA256SUMS.txt,
 *      RELEASE_MANIFEST.json, RELEASE_FILE_LIST.csv.
 *   2. The manifest parses; its frozen_commit exists in git; the
 *      manifest's recorded bytes/sha256 match the actual files;
 *      SHA256SUMS.txt matches too (`sha256sum -c`).
 *   3. `unzip -t` passes on both zips.
 *   4. source.zip parsed entry-by-entry (scripts/release-zip.mjs
 *      reader, CRC-verified): every file entry must match
 *      RELEASE_FILE_LIST.csv (path, bytes, SHA-256) exactly — no
 *      missing, extra or altered file; no release/, node_modules/,
 *      .git/ or dist/ entry. (LICENSE is expected in source.zip —
 *      it is part of the frozen tree, ADR-026.)
 *   4b. dist.zip entries: package.json, package-lock.json,
 *      README.md, LICENSE, dist/cli/index.js and the runtime
 *      schemas must be present, with no unexpected entry.
 *      FIX-R3 (P1-R3-01): the LICENSE entry's SHA-256 must equal
 *      the canonical MIT hash, package.json must claim
 *      `"license": "MIT"`, and the README License section must
 *      state MIT with no "Pending Sam" claim. FIX-R3 (P2-R3-01):
 *      the docs/ files the README links must ship in dist.zip.
 *   5. RELEASE_FILE_LIST.csv regenerated from the frozen commit
 *      must be byte-identical to the shipped one (the list really
 *      is the frozen commit's tree).
 *   6. The frozen commit's S0 gate is PASS with the known hash,
 *      T013 review is P0=0/P1=0, and the MIT LICENSE exists in the
 *      frozen tree with the canonical content hash (Sam decided
 *      2026-11-13 that ALL project licenses are MIT; ADR-026).
 *   7. Clean-room rebuild: extract source.zip, symlink node_modules
 *      (no network, same documented deviation as the build),
 *      `npm run build`, smoke audit on the demo codex-fail profile
 *      (exit 1); audit_sha256 must equal the manifest's
 *      clean_room_audit_sha256 and the repo's own audit. Every
 *      tracked .gitkeep directory must exist in the extracted tree.
 *   8. dist.zip smoke run: extract dist.zip, link node_modules,
 *      run the audit from the extracted dist/ (exit 1);
 *      audit_sha256 must equal the manifest's dist_zip_audit_sha256
 *      and the repo's audit.
 *   9. Secret scan of the extracted source tree: no GitHub/AWS/sk-
 *      style tokens; the only eyJ token allowed is the documented
 *      public jwt.io example in the T008b PII fixtures. Values that
 *      contain TEST or EXAMPLE are documented fakes (the T008b
 *      fixture says so in its own header, and AWS's published
 *      example key is AKIAIOSFODNN7EXAMPLE) and are allowlisted;
 *      anything else matching a credential shape fails.
 *
 * Exit 0 only when every check passes. This script never writes
 * release/ (except temp files under os.tmpdir()).
 */

import { execFileSync, spawnSync } from "node:child_process";
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { readZip } from "./release-zip.mjs";
import {
  ROOT,
  RELEASE_DIR,
  MANIFEST_FILE,
  EXPECTED_GATE_SHA256,
  EXPECTED_LICENSE_SHA256,
  DEMO_PROFILE,
  KNOWN_PUBLIC_JWT_EXAMPLE,
  sha256Hex,
  sha256File,
  run,
  fileListFromCommit,
  fileListCsv,
  resolveFrozenCommit,
  licenseSha256FromCommit,
} from "./release-build.mjs";

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
function gitOut(args, opts = {}) {
  const r = run("git", args, opts);
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.slice(0, 200)}`);
  return r.stdout;
}

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

function main() {
  note(`release:verify started ${new Date().toISOString()}`);

  // 0. Manifest + frozen commit.
  let manifest = null;
  let frozenCommit = null;
  if (!fs.existsSync(MANIFEST_FILE)) {
    check("release/RELEASE_MANIFEST.json exists", false);
    process.exit(1);
  }
  try {
    manifest = JSON.parse(fs.readFileSync(MANIFEST_FILE, "utf8"));
    frozenCommit = manifest.frozen_commit;
    check("manifest parses with a frozen_commit", typeof frozenCommit === "string" && /^[0-9a-f]{40}$/.test(frozenCommit), frozenCommit);
  } catch (err) {
    check("manifest parses", false, err.message);
    process.exit(1);
  }
  check(
    "manifest frozen_commit exists in git",
    run("git", ["cat-file", "-t", frozenCommit]).stdout.trim() === "commit",
  );
  try {
    const resolved = resolveFrozenCommit();
    check("build would resolve the same frozen commit", resolved.commit === frozenCommit, resolved.commit);
  } catch (err) {
    check("build resolves the same frozen commit", false, err.message);
  }
  check("manifest schema", manifest.schema === "skillscope.release-manifest/v1", manifest.schema);
  check("manifest license MIT", manifest.license === "MIT", manifest.license);
  check("manifest s0 gate hash is the known value", manifest.s0_gate && manifest.s0_gate.gate_sha256 === EXPECTED_GATE_SHA256);
  check("manifest review P0=0/P1=0", manifest.review && manifest.review.p0 === 0 && manifest.review.p1 === 0, JSON.stringify(manifest.review));

  // Frozen-commit gates, re-read from git (never trust the manifest).
  const gateJson = JSON.parse(gitOut(["show", `${frozenCommit}:03_evidence/S0/S0_GATE.json`]));
  check("frozen S0 gate status PASS", gateJson.status === "PASS", `status ${gateJson.status}`);
  check("frozen S0 gate hash matches manifest", gateJson.gate_sha256 === manifest.s0_gate.gate_sha256);
  const treeNames = gitOut(["ls-tree", "-r", "--name-only", frozenCommit])
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  check(
    "MIT LICENSE exists in frozen commit with the canonical content hash",
    treeNames.includes("LICENSE") && licenseSha256FromCommit(frozenCommit) === EXPECTED_LICENSE_SHA256,
    `LICENSE present: ${treeNames.includes("LICENSE")}, sha256 ${licenseSha256FromCommit(frozenCommit)}`,
  );

  // Tree must be clean (tracked) and match the frozen commit except
  // release/ + the T014 report.
  const status = gitOut(["status", "--short"]).trim();
  const dirtyTracked = status
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .filter((line) => !line.startsWith("??"));
  check("tracked tree clean at verify", dirtyTracked.length === 0, dirtyTracked.join("; "));
  const diff = run("git", ["diff", "--quiet", frozenCommit, "--", ".", ":!release", ":!03_evidence/T014", ":!00_control/TASK_BOARD.csv", ":!00_control/PROJECT_STATE.json"]);
  check("working tree matches frozen commit (except release/, T014 report, freeze-outcome bookkeeping)", diff.exitCode === 0);

  // 1. All release files exist; manifest numbers match disk.
  const sourceZip = path.join(RELEASE_DIR, "source.zip");
  const distZip = path.join(RELEASE_DIR, "dist.zip");
  const sumsFile = path.join(RELEASE_DIR, "SHA256SUMS.txt");
  const fileListFile = path.join(RELEASE_DIR, "RELEASE_FILE_LIST.csv");
  for (const [name, file] of [
    ["source.zip", sourceZip],
    ["dist.zip", distZip],
    ["SHA256SUMS.txt", sumsFile],
    ["RELEASE_MANIFEST.json", MANIFEST_FILE],
    ["RELEASE_FILE_LIST.csv", fileListFile],
  ]) {
    check(`release/${name} exists`, fs.existsSync(file));
  }
  const actualSourceSize = fs.existsSync(sourceZip) ? fs.statSync(sourceZip).size : -1;
  const actualSourceSha = fs.existsSync(sourceZip) ? sha256File(sourceZip) : "";
  const actualDistSize = fs.existsSync(distZip) ? fs.statSync(distZip).size : -1;
  const actualDistSha = fs.existsSync(distZip) ? sha256File(distZip) : "";
  const actualManifestSha = sha256File(MANIFEST_FILE);
  check("manifest source.zip bytes match disk", manifest.source_zip.bytes === actualSourceSize, `${manifest.source_zip.bytes} vs ${actualSourceSize}`);
  check("manifest source.zip sha256 matches disk", manifest.source_zip.sha256 === actualSourceSha);
  check("manifest dist.zip bytes match disk", manifest.dist_zip.bytes === actualDistSize, `${manifest.dist_zip.bytes} vs ${actualDistSize}`);
  check("manifest dist.zip sha256 matches disk", manifest.dist_zip.sha256 === actualDistSha);
  const sumsText = fs.existsSync(sumsFile) ? fs.readFileSync(sumsFile, "utf8") : "";
  const expectedSums =
    `${actualSourceSha}  source.zip\n${actualDistSha}  dist.zip\n${actualManifestSha}  RELEASE_MANIFEST.json\n`;
  check("SHA256SUMS.txt content matches actual hashes", sumsText === expectedSums, sumsText.trim().split("\n").join(" | "));
  const sums = spawnSync("sha256sum", ["-c", "SHA256SUMS.txt"], { cwd: RELEASE_DIR, encoding: "utf8" });
  check("sha256sum -c release/SHA256SUMS.txt", sums.status === 0, (sums.stdout ?? "").trim());

  // 2. unzip -t on both.
  const testSource = run("unzip", ["-t", sourceZip]);
  check("unzip -t release/source.zip", testSource.exitCode === 0, testSource.stdout.split("\n").slice(-2).join(" "));
  const testDist = run("unzip", ["-t", distZip]);
  check("unzip -t release/dist.zip", testDist.exitCode === 0, testDist.stdout.split("\n").slice(-2).join(" "));

  // 3. source.zip entry-by-entry vs RELEASE_FILE_LIST.csv.
  const shippedList = fs.existsSync(fileListFile) ? fs.readFileSync(fileListFile, "utf8") : "";
  const shippedRows = shippedList.split("\n").filter((l) => l.trim() && !l.startsWith("path,"));
  const shipped = new Map();
  for (const row of shippedRows) {
    const [p, bytes, sha, blob] = row.split(",");
    shipped.set(p, { bytes: Number(bytes), sha256: sha, blob });
  }
  let sourceEntries = null;
  try {
    sourceEntries = readZip(fs.readFileSync(sourceZip));
  } catch (err) {
    check("parse source.zip (CRC-verified read)", false, err.message);
  }
  if (sourceEntries) {
    const files = [...sourceEntries.entries()].filter(([p]) => !p.endsWith("/"));
    check("source.zip file count matches RELEASE_FILE_LIST.csv", files.length === shipped.size, `${files.length} vs ${shipped.size}`);
    const mismatched = [];
    for (const [zipPath, data] of files) {
      const rel = zipPath.startsWith("skillscope/") ? zipPath.slice("skillscope/".length) : null;
      if (rel === null) {
        mismatched.push(`${zipPath} (missing skillscope/ prefix)`);
        continue;
      }
      const row = shipped.get(rel);
      if (!row) {
        mismatched.push(`${rel} (not in file list)`);
      } else if (row.bytes !== data.length || row.sha256 !== sha256Hex(data)) {
        mismatched.push(`${rel} (bytes/sha differ)`);
      }
    }
    for (const rel of shipped.keys()) {
      if (![...files].some(([p]) => p === `skillscope/${rel}`)) mismatched.push(`${rel} (in file list, missing from zip)`);
    }
    check("source.zip entries match file list byte-for-byte", mismatched.length === 0, mismatched.slice(0, 5).join("; "));
    // FIX-R2 (P1-R2-01): file SHAs cannot see empty directories, and
    // `git archive` drops them. Compare the DIRECTORY set implied by
    // the frozen commit (every ancestor of every shipped file) with
    // the directory entries actually present in source.zip, so a
    // dropped empty dir fails the verify even though every file
    // matches.
    const expectedDirs = new Set();
    for (const rel of shipped.keys()) {
      let dir = path.posix.dirname(rel);
      while (dir !== "." && dir !== "") {
        expectedDirs.add(`skillscope/${dir}/`);
        dir = path.posix.dirname(dir);
      }
    }
    const zipDirs = new Set([...sourceEntries.keys()].filter((p) => p.endsWith("/")));
    const missingZipDirs = [...expectedDirs].filter((d) => !zipDirs.has(d));
    const extraZipDirs = [...zipDirs].filter((d) => d !== "skillscope/" && !expectedDirs.has(d));
    check(
      "source.zip directory set matches frozen commit (empty dirs included)",
      missingZipDirs.length === 0 && extraZipDirs.length === 0,
      `missing: ${missingZipDirs.slice(0, 5).join("; ")}; extra: ${extraZipDirs.slice(0, 5).join("; ")}`,
    );
    const forbidden = [...sourceEntries.keys()].filter(
      (p) => p.startsWith("skillscope/release/") || p.startsWith("skillscope/node_modules/") || p.startsWith("skillscope/.git/") || p.startsWith("skillscope/dist/") || /(^|\/)(node_modules|\.git)(?=\/)/.test(p),
    );
    check("no forbidden entries in source.zip", forbidden.length === 0, forbidden.slice(0, 5).join("; "));
  }
  // File list regenerated from the frozen commit must be identical.
  try {
    const regenerated = fileListCsv(fileListFromCommit(frozenCommit));
    check("RELEASE_FILE_LIST.csv is byte-identical to a fresh regeneration from the frozen commit", regenerated === shippedList);
    check("manifest source file_count matches file list", manifest.source_zip.file_count === shipped.size, `${manifest.source_zip.file_count} vs ${shipped.size}`);
  } catch (err) {
    check("regenerate file list from frozen commit", false, err.message);
  }

  // 4. dist.zip entries.
  let distEntries = null;
  try {
    distEntries = readZip(fs.readFileSync(distZip));
  } catch (err) {
    check("parse dist.zip (CRC-verified read)", false, err.message);
  }
  if (distEntries) {
    const names = [...distEntries.keys()].filter((p) => !p.endsWith("/"));
    check("dist.zip contains package.json + package-lock.json + README.md + LICENSE", ["package.json", "package-lock.json", "README.md", "LICENSE"].every((f) => names.includes(f)));
    check("dist.zip contains dist/cli/index.js", names.includes("dist/cli/index.js"));
    check(
      "dist.zip contains runtime schemas (CLI reads them via REPO_ROOT)",
      ["schemas/skillscope-profile-v1.json", "schemas/skillscope-report-v1.json", "schemas/skillscope-audit-result-v1.json", "src/adapters/openmausbot/openmausbot-snapshot-v1.json"].every((f) => names.includes(f)),
    );
    // FIX-R3 (P1-R3-01): dist.zip is a standalone distribution —
    // the MIT LICENSE must be inside it with the canonical content
    // hash, and the license metadata must agree with MIT.
    check(
      "dist.zip LICENSE has the canonical MIT content hash",
      names.includes("LICENSE") && sha256Hex(distEntries.get("LICENSE")) === EXPECTED_LICENSE_SHA256,
      names.includes("LICENSE") ? `sha256 ${sha256Hex(distEntries.get("LICENSE"))}` : "LICENSE entry missing",
    );
    let distPkgLicense = null;
    let distReadme = "";
    try {
      distPkgLicense = JSON.parse(distEntries.get("package.json").toString("utf8")).license;
      distReadme = distEntries.get("README.md").toString("utf8");
    } catch {
      // The presence checks above already failed; leave nulls.
    }
    check('dist.zip package.json claims "license": "MIT"', distPkgLicense === "MIT", `license ${distPkgLicense}`);
    check(
      "dist.zip README License section states MIT (no Pending Sam claim)",
      /^## License\n\nMIT/m.test(distReadme) && !/Pending Sam/.test(distReadme),
      distReadme.match(/^## License\n\n.*$/m)?.[0] ?? "no License section",
    );
    // FIX-R3 (P2-R3-01): the docs/ files the README links must ship.
    check(
      "dist.zip contains the docs/ files the README links",
      ["docs/quickstart.md", "docs/host-rules.md", "docs/images/scope-matrix.png"].every((f) => names.includes(f)),
    );
    const bad = names.filter(
      (p) => !/^(package\.json|package-lock\.json|README\.md|LICENSE|dist\/|schemas\/|docs\/|src\/adapters\/openmausbot\/openmausbot-snapshot-v1\.json$)/.test(p),
    );
    check("dist.zip has no unexpected entries", bad.length === 0, bad.slice(0, 5).join("; "));
    check("dist.zip entry count matches manifest expectation", names.length > 0, `${names.length} entries`);
  }

  const work = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-verify-"));
  try {
    // 5. Extract source.zip; .gitkeep dirs, LICENSE, secret scan.
    const cleanDir = path.join(work, "clean");
    fs.mkdirSync(cleanDir, { recursive: true });
    const extract = run("unzip", ["-q", sourceZip, "-d", cleanDir]);
    check("extract source.zip to temp dir", extract.exitCode === 0, extract.stderr.slice(0, 300));
    const cleanRoot = path.join(cleanDir, "skillscope");
    const gitkeeps = gitOut(["ls-files", "**/.gitkeep"])
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
    const missingDirs = gitkeeps
      .map((rel) => path.join(cleanRoot, path.dirname(rel)))
      .filter((dir) => !fs.existsSync(dir));
    check(`all ${gitkeeps.length} .gitkeep directories present in extracted tree`, missingDirs.length === 0, missingDirs.join("; "));
    check(
      "MIT LICENSE present in extracted source tree",
      fs.existsSync(path.join(cleanRoot, "LICENSE")) &&
        sha256File(path.join(cleanRoot, "LICENSE")) === EXPECTED_LICENSE_SHA256,
    );
    // Secret scan (text files only; skip binaries).
    const secretHits = [];
    const jwtHits = [];
    const scanWalk = (dir) => {
      for (const name of fs.readdirSync(dir)) {
        const abs = path.join(dir, name);
        const st = fs.statSync(abs);
        if (st.isDirectory()) {
          if (name === "node_modules" || name === ".git") continue;
          scanWalk(abs);
          continue;
        }
        if (/\.(png|zip|jpg|jpeg|gif|ico)$/i.test(name) || st.size > 2 * 1024 * 1024) continue;
        let text;
        try {
          text = fs.readFileSync(abs, "utf8");
        } catch {
          continue;
        }
        for (const m of text.matchAll(/ghp_[A-Za-z0-9]{20,}|gho_[A-Za-z0-9]{20,}|AKIA[0-9A-Z]{16}|sk-[A-Za-z0-9]{20,}/g)) {
          // Documented fakes only: the T008b PII fixture holds
          // well-known public examples / obviously fake test tokens
          // (values containing TEST or EXAMPLE, e.g. AWS's published
          // AKIAIOSFODNN7EXAMPLE). A real credential never contains
          // those words; anything else matching the shape fails.
          if (/TEST|EXAMPLE/i.test(m[0])) continue;
          secretHits.push(`${path.relative(cleanRoot, abs)}: ${m[0].slice(0, 12)}…`);
        }
        // Full JWT shape (three dot-separated segments); compare the
        // whole token — a segment-only match would never equal the
        // allowlisted example and would false-positive on it.
        for (const m of text.matchAll(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g)) {
          if (m[0] !== KNOWN_PUBLIC_JWT_EXAMPLE) jwtHits.push(`${path.relative(cleanRoot, abs)}: ${m[0].slice(0, 20)}…`);
        }
      }
    };
    scanWalk(cleanRoot);
    check("no GitHub/AWS/sk-style tokens in source tree", secretHits.length === 0, secretHits.slice(0, 3).join("; "));
    check("only the documented public JWT example present", jwtHits.length === 0, jwtHits.slice(0, 3).join("; "));

    // 6. Clean-room rebuild + smoke audit.
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

    // Repo smoke audit (fresh build first).
    const repoBuild = run("npm", ["run", "build"]);
    check("repo npm run build (fresh)", repoBuild.exitCode === 0, repoBuild.stderr.slice(0, 300));
    const repoOut = path.join(work, "repo-smoke.json");
    const repoAudit = smokeAudit(
      path.join(ROOT, "dist", "cli", "index.js"),
      path.join(ROOT, DEMO_PROFILE),
      repoOut,
      ROOT,
    );
    check("repo smoke audit exits 1 (codex-fail)", repoAudit.exitCode === 1, `exit ${repoAudit.exitCode}`);
    check(
      "clean-room audit_sha256 == manifest clean_room_audit_sha256",
      cleanAudit.auditSha256 !== null && cleanAudit.auditSha256 === manifest.clean_room_audit_sha256,
      `clean ${cleanAudit.auditSha256} vs manifest ${manifest.clean_room_audit_sha256}`,
    );
    check(
      "repo audit_sha256 == manifest repo_audit_sha256",
      repoAudit.auditSha256 !== null && repoAudit.auditSha256 === manifest.repo_audit_sha256,
      `repo ${repoAudit.auditSha256} vs manifest ${manifest.repo_audit_sha256}`,
    );
    check(
      "clean-room audit_sha256 == repo audit_sha256",
      cleanAudit.auditSha256 !== null && cleanAudit.auditSha256 === repoAudit.auditSha256,
      `clean ${cleanAudit.auditSha256} vs repo ${repoAudit.auditSha256}`,
    );

    // 7. dist.zip smoke run.
    const distDir = path.join(work, "dist-test");
    fs.mkdirSync(distDir, { recursive: true });
    const distExtract = run("unzip", ["-q", distZip, "-d", distDir]);
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
    check(
      "dist.zip audit_sha256 == manifest dist_zip_audit_sha256",
      distAudit.auditSha256 !== null && distAudit.auditSha256 === manifest.dist_zip_audit_sha256,
      `dist ${distAudit.auditSha256} vs manifest ${manifest.dist_zip_audit_sha256}`,
    );
    check(
      "dist.zip audit_sha256 == repo audit_sha256",
      distAudit.auditSha256 !== null && distAudit.auditSha256 === repoAudit.auditSha256,
      `dist ${distAudit.auditSha256} vs repo ${repoAudit.auditSha256}`,
    );
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }

  note(`release:verify ${failures.length === 0 ? "PASS" : "FAIL"} — frozen ${frozenCommit}`);
  if (failures.length > 0) {
    console.error(`release:verify FAILED — ${failures.join("; ")}`);
    process.exit(1);
  }
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  try {
    main();
  } catch (err) {
    console.error(`release:verify FAILED with exception: ${err.message}`);
    process.exit(1);
  }
}
