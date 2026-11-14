#!/usr/bin/env node
/**
 * T005 identity evidence generator (P023 S1).
 *
 * Builds a deterministic synthetic skill tree in a FIXED temp directory
 * (/tmp/skillscope-t005-evidence — fixed so instanceIds are reproducible
 * on this machine), runs the production discovery + manifest + identity
 * pipeline over it, and writes:
 *   03_evidence/T005/IDENTITY_REPORT.json
 *   03_evidence/T005/SOURCE_GRAPH.json
 *   03_evidence/T005/T005_REPORT.md
 *
 * The tree exercises every T005 acceptance property:
 *   - same logical name, different paths        -> two instances (deploy / Deploy)
 *   - symlink alias to the same file            -> one instance, alias kept
 *   - same content, different paths             -> two instances + DUPLICATE_CONTENT
 *   - symlink loop                              -> terminates, SYMLINK_LOOP recorded
 *   - symlink escaping the root                 -> never followed, content never appears
 *   - dangling symlink                          -> CANONICAL_PATH_UNRESOLVABLE
 *   - oversize SKILL.md                         -> SKILL_MD_TOO_LARGE
 *   - invalid frontmatter                       -> INVALID instance, kept in the registry
 *   - a directory named SKILL.md                -> SKILL_MD_UNREADABLE
 *
 * Read-only with respect to the repo: it writes only 03_evidence/T005/
 * and the temp tree (removed afterwards). Exits non-zero if any
 * invariant fails.
 */

import { execSync } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const EVIDENCE_DIR = path.join(REPO, "03_evidence", "T005");
const TREE = path.join(os.tmpdir(), "skillscope-t005-evidence");
const OUTSIDE = path.join(os.tmpdir(), "skillscope-t005-outside");

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function skill(name, body = "") {
  return `---\nname: ${name}\ndescription: Synthetic T005 skill ${name}.\n---\n${body}\n`;
}

function writeSkill(root, relDir, content) {
  const dir = path.join(root, relDir);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), content);
}

function buildTree() {
  fs.rmSync(TREE, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });

  // Outside the root: must never be read.
  writeSkill(OUTSIDE, "secret", skill("secret", "outside the authorised root"));

  // Inside the root.
  writeSkill(TREE, "deploy", skill("deploy", "Deploy things."));
  writeSkill(TREE, "Deploy", skill("deploy", "Same name, different folder."));
  writeSkill(TREE, "release", skill("release", "Release things."));
  const copyContent = skill("copy-shared", "Identical bytes, two paths.");
  writeSkill(TREE, "copy-a", copyContent);
  writeSkill(TREE, "copy-b", copyContent);
  writeSkill(TREE, "bad", "---\nname: Bad_Name\ndescription: x.\n---\n");
  // Symlink alias: alias -> release (same physical file).
  fs.symlinkSync(path.join(TREE, "release"), path.join(TREE, "alias"), "dir");
  // Symlink loop: loop/back -> TREE (the root itself).
  fs.mkdirSync(path.join(TREE, "loop"), { recursive: true });
  fs.symlinkSync(TREE, path.join(TREE, "loop", "back"), "dir");
  // Escape: esc -> OUTSIDE/secret.
  fs.symlinkSync(path.join(OUTSIDE, "secret"), path.join(TREE, "esc"), "dir");
  // Dangling symlink.
  fs.symlinkSync(path.join(TREE, "no-such-dir"), path.join(TREE, "ghost"), "dir");
  // Oversize SKILL.md (1 MiB + 1 byte of body).
  writeSkill(TREE, "big", skill("big", "x".repeat(1024 * 1024 + 1)));
  // A directory literally named SKILL.md.
  fs.mkdirSync(path.join(TREE, "weird", "SKILL.md"), { recursive: true });
  fs.writeFileSync(path.join(TREE, "weird", "SKILL.md", "inner.txt"), "not a skill");
}

async function main() {
  buildTree();

  // Build first so the evidence runs the compiled production code.
  execSync("npm run build", { cwd: REPO, stdio: "inherit" });
  const { discoverSkillRoot } = await import("../dist/discovery/discovery.js");
  const { IdentityRegistry } = await import("../dist/identity/identity.js");
  const { parseManifest } = await import("../dist/manifest/manifest.js");
  const { buildSourceGraph } = await import("../dist/identity/source-graph.js");

  const discovered = discoverSkillRoot(TREE);
  const registry = new IdentityRegistry();
  for (const s of discovered.skills) {
    const manifest = parseManifest(s.content);
    registry.register({
      engine: "codex",
      sourceRootId: "repo",
      sourceScope: "REPO",
      relativePath: s.relativePath,
      canonicalPath: s.canonicalPath,
      logicalName: manifest.name ?? s.folderName,
      folderName: s.folderName,
      ...(manifest.name !== undefined ? { manifestName: manifest.name } : {}),
      contentSha256: s.contentSha256,
      status: manifest.valid ? "ELIGIBLE" : "INVALID",
      evidenceLevel: "STATIC_RULE",
    });
  }
  const graph = buildSourceGraph(
    [{ sourceRootId: "repo", engine: "codex", sourceScope: "REPO" }],
    registry,
  );

  const invariants = [];
  const check = (label, ok) => {
    invariants.push({ label, ok });
    if (!ok) {
      console.error(`INVARIANT FAILED: ${label}`);
    }
  };

  const byName = (name) =>
    registry.instances().filter((i) => i.logicalName === name);
  check("discovered skills == 7 (deploy, Deploy, release, alias, copy-a, copy-b, bad)", discovered.skills.length === 7);
  check("instances == 6 (alias merges into release)", registry.size === 6);
  check("deploy vs Deploy are two instances", byName("deploy").length === 2);
  const releaseInst = byName("release")[0];
  check(
    "release instance has exactly the two access paths alias + release",
    releaseInst !== undefined &&
      releaseInst.aliases.length === 1 &&
      new Set([releaseInst.relativePath, ...releaseInst.aliases]).size === 2 &&
      releaseInst.relativePath === "alias/SKILL.md" &&
      releaseInst.aliases.includes("release/SKILL.md"),
  );
  check("copy-a/copy-b are two instances", registry.size === 6 && byName("copy-shared").length === 2);
  check("duplicate-content group == 1 (copy-a, copy-b)", registry.duplicateContentGroups().length === 1);
  // Two same-name groups: "deploy" (deploy/Deploy) and "copy-shared"
  // (copy-a/copy-b share the name AND the bytes — both rules apply).
  check(
    "same-name collisions == 2 (deploy, copy-shared)",
    registry.sameNameCollisions().length === 2 &&
      registry.sameNameCollisions().map((g) => g.logicalName).sort().join(",") === "copy-shared,deploy",
  );
  // The bad skill's manifest name is invalid, so its logical name falls
  // back to the folder name ("bad"); it must still be an INVALID instance.
  check("bad manifest is an INVALID instance, not dropped", byName("bad").length === 1 && byName("bad")[0]?.status === "INVALID");
  check("loop recorded SYMLINK_LOOP", discovered.skipped.some((s) => s.reason === "SYMLINK_LOOP"));
  check("escape recorded SYMLINK_OUTSIDE_ROOT", discovered.skipped.some((s) => s.reason === "SYMLINK_OUTSIDE_ROOT"));
  check("dangling link recorded CANONICAL_PATH_UNRESOLVABLE", discovered.skipped.some((s) => s.reason === "CANONICAL_PATH_UNRESOLVABLE"));
  check("oversize recorded SKILL_MD_TOO_LARGE", discovered.skipped.some((s) => s.reason === "SKILL_MD_TOO_LARGE"));
  check("dir named SKILL.md recorded SKILL_MD_UNREADABLE", discovered.skipped.some((s) => s.reason === "SKILL_MD_UNREADABLE"));
  check("outside secret never appears in any output", !JSON.stringify({ discovered, graph }).includes("secret"));
  check("no absolute path in the source graph", !JSON.stringify(graph).includes(TREE) && !JSON.stringify(graph).includes("/tmp/"));

  const graphJson = `${JSON.stringify(graph, null, 2)}\n`;
  const report = {
    schema: "skillscope.identity-report/v1",
    task: "T005",
    specVersion: "1.0.0",
    tree: "<EVIDENCE_ROOT>",
    summary: {
      discoveredSkills: discovered.skills.length,
      instances: registry.size,
      aliases: registry.instances().reduce((n, i) => n + i.aliases.length, 0),
      sameNameCollisions: registry.sameNameCollisions().length,
      duplicateContentGroups: registry.duplicateContentGroups().length,
      skipped: discovered.skipped.length,
      invalidInstances: registry.instances().filter((i) => i.status === "INVALID").length,
    },
    instances: registry.instances(),
    sameNameCollisions: registry.sameNameCollisions(),
    duplicateContentGroups: registry.duplicateContentGroups(),
    skipped: discovered.skipped,
    discoveryStats: discovered.stats,
    sourceGraphSha256: sha256Hex(graphJson),
    invariants,
  };
  const reportJson = `${JSON.stringify(report, null, 2)}\n`;

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  fs.writeFileSync(path.join(EVIDENCE_DIR, "IDENTITY_REPORT.json"), reportJson);
  fs.writeFileSync(path.join(EVIDENCE_DIR, "SOURCE_GRAPH.json"), graphJson);

  const failed = invariants.filter((i) => !i.ok);
  // Preserve an already-recorded OUTPUT_COMMIT across re-runs: the
  // script regenerates this report, and a re-run must not clobber the
  // committed hash with the pre-commit placeholder.
  let outputCommitLine = "- OUTPUT_COMMIT: （提交后填写）";
  const reportPath = path.join(EVIDENCE_DIR, "T005_REPORT.md");
  if (fs.existsSync(reportPath)) {
    const existing = fs.readFileSync(reportPath, "utf8");
    const match = existing.match(/^- OUTPUT_COMMIT: ([0-9a-f]{7,40})\b/m);
    if (match) {
      outputCommitLine = `- OUTPUT_COMMIT: ${match[1]}（P023 T005 PASS: skill instance identity, source graph, canonical path）`;
    }
  }
  const lines = [
    "# T005 验收报告 — 技能实例身份、来源图与 canonical path（S1）",
    "",
    "- TASK_ID: T005（S1）",
    `- STATUS: ${failed.length === 0 ? "PASS" : "FAIL"}`,
    "- BASE_COMMIT: 9232d10（S0 已通过，gate a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca）",
    outputCommitLine,
    "- SPEC_VERSION: 1.0.0",
    "- 规则依据：PROJECT_BOOK.md §4.2–§4.5、§5.2、§6；IMPLEMENTATION_PLAN.md §5 T005、§2.1",
    "",
    "## 合成证据树（固定路径 /tmp/skillscope-t005-evidence，脚本重建，运行后删除）",
    "",
    "| 路径 | 内容 | 预期 |",
    "|---|---|---|",
    "| deploy/SKILL.md | name: deploy | 实例 1 |",
    "| Deploy/SKILL.md | name: deploy | 实例 2（同名不同路径） |",
    "| release/SKILL.md | name: release | 实例 3 |",
    "| alias → release | symlink | 归并为实例 3 的 alias |",
    "| copy-a / copy-b | 相同字节 | 实例 4、5 + DUPLICATE_CONTENT |",
    "| bad/SKILL.md | name: Bad_Name | INVALID 实例，不丢弃 |",
    "| loop/back → 树根 | symlink loop | SYMLINK_LOOP，终止 |",
    "| esc → 树外 secret | symlink escape | SYMLINK_OUTSIDE_ROOT，永不读取 |",
    "| ghost → 不存在 | dangling | CANONICAL_PATH_UNRESOLVABLE |",
    "| big/SKILL.md | >1 MiB | SKILL_MD_TOO_LARGE |",
    "| weird/SKILL.md/ | 目录 | SKILL_MD_UNREADABLE |",
    "",
    "## 结果摘要",
    "",
    `- 发现技能：${discovered.skills.length} 个；实例：${registry.size} 个；alias：${report.summary.aliases} 个`,
    `- 同名冲突：${report.summary.sameNameCollisions} 组（deploy；copy-shared——copy-a/copy-b 既同名又同内容）；同内容组：${report.summary.duplicateContentGroups} 组（copy-a/copy-b）`,
    `- 跳过：${discovered.skipped.length} 条（${discovered.skipped.map((s) => s.reason).sort().join("、")}）`,
    `- INVALID 实例：${report.summary.invalidInstances} 个（bad，保留在 registry 中）`,
    `- source graph：${graph.nodes.length} 个节点（${graph.nodes.filter((n) => n.kind === "root").length} root + ${graph.nodes.filter((n) => n.kind === "instance").length} instance），${graph.edges.length} 条边；sha256 \`${report.sourceGraphSha256}\``,
    "",
    "## 不变量（全部通过才算 PASS）",
    "",
    ...invariants.map((i) => `- [${i.ok ? "x" : " "}] ${i.label}`),
    "",
    "## 验收命令（由协调员亲自跑，见主报告）",
    "",
    "- `npm run test:identity -- --run`",
    "- `npm run test:symlink -- --run`",
    "- `npm run test:oracle`",
    "- `npm run s0:gate`（gate hash 必须仍为 a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca）",
    "",
    "## 已知局限",
    "",
    "- 证据树是合成的；真实宿主目录的 identity 行为由 T006+ 的适配器集成验证。",
    "- 权限不可读（chmod 000）在 root 运行时无法复现，改用 dangling symlink 与目录型 SKILL.md 覆盖不可读分支。",
    "- instanceId 含本机 /tmp 固定路径，换机重跑会变；同一机器上重跑可复现。",
    "",
  ];
  fs.writeFileSync(path.join(EVIDENCE_DIR, "T005_REPORT.md"), `${lines.join("\n")}\n`);

  fs.rmSync(TREE, { recursive: true, force: true });
  fs.rmSync(OUTSIDE, { recursive: true, force: true });

  console.log(`T005 evidence: ${discovered.skills.length} skills, ${registry.size} instances, ${failed.length} failed invariants`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
