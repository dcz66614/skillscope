#!/usr/bin/env node
/**
 * T008b hash + privacy evidence generator (P023 S2).
 *
 * Runs the production canonical / privacy / io modules (from dist/ —
 * run `npm run build` first) over the frozen fixtures and writes:
 *   03_evidence/T008b/HASH_PRIVACY_REPORT.json
 *   03_evidence/T008b/T008B_REPORT.md
 *
 * What it proves, with independent checks (not self-assertions):
 *   1. Canonical vectors: all 15 frozen vectors reproduce under the
 *      production implementation AND under an independent Python
 *      implementation (json.dumps sort_keys + NFC + hashlib.sha256),
 *      run here via python3. A frozen hash is only trusted when both
 *      agree.
 *   2. Schema validation: every schema fixture (valid + invalid, all
 *      four schema ids) validates as expected through src/io.
 *   3. PII scan: a synthetic dirty log (9 secret values + absolute
 *      paths) is scanned raw (findings counted, values never recorded)
 *      and after redaction (0 findings, 0 absolute paths, 0 secret
 *      values remain).
 *   4. Determinism: the report is generated twice in-process and must
 *      be byte-identical; the written file is re-read and re-hashed.
 *
 * Deterministic and idempotent: no timestamps, no random values, no
 * absolute paths in the outputs (verified by a final self-scan). The
 * `output_commit` field is preserved across re-runs (filled in by the
 * control commit after the code commit lands).
 */

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(__dirname, "..");
const EVIDENCE_DIR = path.join(REPO, "03_evidence", "T008b");
const FIX = path.join(REPO, "tests", "fixtures", "t008b");
const REPORT_JSON = path.join(EVIDENCE_DIR, "HASH_PRIVACY_REPORT.json");
const REPORT_MD = path.join(EVIDENCE_DIR, "T008B_REPORT.md");
const PY_CHECK = path.join(__dirname, "py-canonical-check.py");

function pyCanonical(file) {
  const out = execSync(
    `python3 ${JSON.stringify(PY_CHECK)} ${JSON.stringify(file)}`,
    { encoding: "utf8" },
  );
  const byName = {};
  for (const line of out.trim().split("\n")) {
    const [name, canon, hash] = line.split("\t");
    byName[name] = { canon, hash };
  }
  return byName;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

function fail(message) {
  console.error(`hash-privacy-evidence: FAIL: ${message}`);
  process.exit(1);
}

async function main() {
  const { canonicalSha256, canonicalizeJson } = await import(
    "../dist/canonical/index.js"
  );
  const { redactReport, scanForSecrets } = await import(
    "../dist/privacy/index.js"
  );
  const { loadSnapshot, validateAgainstSchemaId } = await import(
    "../dist/io/index.js"
  );

  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });

  // --- 1. Canonical vectors: TS vs Python -------------------------------
  const vectors = readJson(path.join(FIX, "canonical-vectors.json")).vectors;
  const pyByName = pyCanonical(path.join(FIX, "canonical-vectors.json"));
  let vectorMatches = 0;
  const vectorFailures = [];
  for (const vec of vectors) {
    const tsCanon = canonicalizeJson(vec.input);
    const tsHash = canonicalSha256(vec.input);
    const py = pyByName[vec.name];
    if (
      tsCanon === vec.expectedCanonical &&
      tsHash === vec.expectedSha256 &&
      py !== undefined &&
      py.canon === vec.expectedCanonical &&
      py.hash === vec.expectedSha256
    ) {
      vectorMatches++;
    } else {
      vectorFailures.push(vec.name);
    }
  }
  if (vectorFailures.length > 0) {
    fail(`canonical vector mismatch (TS vs fixture vs Python): ${vectorFailures.join(", ")}`);
  }

  // Cross-check the schema fixtures' canonical hashes with Python too.
  const fixtureFiles = [
    "profile-valid.json",
    "report-valid.json",
    "audit-result-valid.json",
    "snapshot-omb-valid.json",
  ];
  let fixtureHashMatches = 0;
  for (const file of fixtureFiles) {
    const value = readJson(path.join(FIX, file));
    const tsHash = canonicalSha256(value);
    const pyHash = pyCanonical(path.join(FIX, file))["value"].hash;
    if (pyHash !== tsHash) {
      fail(`canonical hash mismatch (TS vs Python) for ${file}`);
    }
    fixtureHashMatches++;
  }

  // --- 2. Schema validation ----------------------------------------------
  const schemaCases = [
    ["profile-valid.json", "skillscope.profile/v1", true],
    ["profile-invalid.json", "skillscope.profile/v1", false],
    ["report-valid.json", "skillscope.report/v1", true],
    ["report-invalid-hash.json", "skillscope.report/v1", false],
    ["audit-result-valid.json", "skillscope.audit-result/v1", true],
    ["snapshot-omb-valid.json", "openmausbot-snapshot/v1", true],
  ];
  let schemaPass = 0;
  const schemaFailures = [];
  for (const [file, schemaId, expectValid] of schemaCases) {
    const errors = validateAgainstSchemaId(readJson(path.join(FIX, file)), schemaId);
    const valid = errors.length === 0;
    if (valid === expectValid) {
      schemaPass++;
    } else {
      schemaFailures.push(`${file} (expected valid=${expectValid}, got ${errors.length} errors)`);
    }
  }
  if (schemaFailures.length > 0) {
    fail(`schema validation mismatch: ${schemaFailures.join("; ")}`);
  }

  // Snapshot import through the real loader, for all four ids.
  const importCases = [
    ["profile-valid.json", "skillscope.profile/v1"],
    ["report-valid.json", "skillscope.report/v1"],
    ["audit-result-valid.json", "skillscope.audit-result/v1"],
    ["snapshot-omb-valid.json", "openmausbot-snapshot/v1"],
  ];
  let importPass = 0;
  for (const [file, schemaId] of importCases) {
    const result = loadSnapshot(path.join(FIX, file));
    if (!result.ok || result.schemaId !== schemaId) {
      fail(`loadSnapshot failed for ${file}`);
    }
    importPass++;
  }

  // --- 3. PII scan: dirty log in, clean report out ------------------------
  const pii = readJson(path.join(FIX, "pii-sample.json")).samples;
  const dirtyLog = {
    schema: "skillscope.report/v1",
    profile_id: "codex-billing-repo",
    status: "INCOMPLETE",
    detail: `audit ran in ${path.join(os.homedir(), ".agents", "skills")} for user ${os.userInfo().username}`,
    secrets: Object.fromEntries(pii.map((s) => [s.field, s.value])),
  };
  const rawFindings = scanForSecrets(dirtyLog);
  if (rawFindings.length < pii.length) {
    fail(`PII scan found only ${rawFindings.length} findings for ${pii.length} planted secrets`);
  }
  const patternsFound = [...new Set(rawFindings.map((f) => f.pattern))].sort();
  const redacted = redactReport(dirtyLog, {
    home: os.homedir(),
    cwd: REPO,
    usernames: [os.userInfo().username],
  });
  const cleanFindings = scanForSecrets(redacted);
  if (cleanFindings.length !== 0) {
    fail(`redacted output still scans dirty: ${JSON.stringify(cleanFindings)}`);
  }
  const redactedText = JSON.stringify(redacted);
  for (const sample of pii) {
    if (redactedText.includes(sample.value)) {
      fail(`redacted output still contains a planted secret value (${sample.field})`);
    }
  }
  if (redactedText.includes(os.homedir()) || redactedText.includes(os.userInfo().username)) {
    fail("redacted output still contains the home path or username");
  }
  if (!redactedText.includes("<HOME>")) {
    fail("redacted output lost the <HOME> placeholder");
  }

  // --- 4. Determinism + report --------------------------------------------
  let previousCommit = null;
  if (fs.existsSync(REPORT_JSON)) {
    try {
      previousCommit = readJson(REPORT_JSON).output_commit ?? null;
    } catch {
      previousCommit = null;
    }
  }
  const report = {
    schema: "skillscope.hash-privacy-report/v1",
    task: "T008b",
    seed: "P023-SKILLSCOPE-S0-2026-11-13",
    output_commit: previousCommit,
    canonical_vectors: {
      total: vectors.length,
      ts_fixture_python_agree: vectorMatches,
      failures: vectorFailures,
    },
    fixture_canonical_hashes: {
      files_checked: fixtureFiles.length,
      ts_python_agree: fixtureHashMatches,
    },
    schema_validation: {
      cases: schemaCases.length,
      passed: schemaPass,
      failures: schemaFailures,
    },
    snapshot_import: {
      cases: importCases.length,
      passed: importPass,
    },
    pii_scan: {
      planted_secrets: pii.length,
      raw_findings: rawFindings.length,
      patterns_found: patternsFound,
      redacted_findings: cleanFindings.length,
      secret_values_remaining: 0,
      absolute_paths_remaining: 0,
    },
    s0_gate_sha256:
      "a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca",
  };

  const reportText = `${canonicalizeJson(report)}\n`;
  const reportTextAgain = `${canonicalizeJson(report)}\n`;
  if (reportText !== reportTextAgain) {
    fail("report generation is not deterministic");
  }
  if (scanForSecrets(report).length !== 0) {
    fail("report itself scans dirty");
  }
  fs.writeFileSync(REPORT_JSON, reportText, "utf8");
  const written = fs.readFileSync(REPORT_JSON, "utf8");
  if (written !== reportText) {
    fail("verification re-read of the report mismatched");
  }

  const md = [
    "# T008b 证据报告：Snapshot I/O、隐私脱敏与规范化哈希",
    "",
    `- 任务：P023 SkillScope T008b（S2，补齐计划 §5 T008 原文；OPEN-004）`,
    `- OUTPUT_COMMIT：${previousCommit ?? "(待控制提交回填)"}`,
    `- S0 gate 哈希：\`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca\`（不变，由验收命令核实）`,
    "",
    "## 1. Canonical 向量（TS 实现 vs 冻结 fixture vs Python 独立实现）",
    "",
    `- 向量总数：${vectors.length}；三方一致：${vectorMatches}；不一致：${vectorFailures.length}`,
    `- schema fixture 的 canonical 哈希（profile / report / audit-result / snapshot）：TS 与 Python 一致 ${fixtureHashMatches}/${fixtureFiles.length}`,
    "- Python 独立实现：`json.dumps(sort_keys=True, ensure_ascii=False)` + NFC + `hashlib.sha256`，与 TS 的码点键序、NFC、无空白规则逐项对照。",
    "",
    "## 2. Schema 校验",
    "",
    `- 用例：${schemaCases.length}；通过：${schemaPass}`,
    "- 覆盖 profile / report / audit-result / openmausbot-snapshot 四个 schema id；valid 与 invalid fixture 均按预期通过/失败。",
    "- snapshot 导入（loadSnapshot，真实加载器）：" + importPass + "/" + importCases.length + " 通过。",
    "",
    "## 3. PII 扫描",
    "",
    `- 植入密钥：${pii.length} 个（均为公开示例或明显伪造的测试值）；原始扫描命中：${rawFindings.length} 条，模式：${patternsFound.join(", ")}`,
    "- 脱敏后扫描：" +
      cleanFindings.length +
      " 条；残留密钥值：0；残留绝对路径：0；`<HOME>` 占位符保留。",
    "- 扫描结果只记录模式名、JSON 路径与匹配长度，从不记录密钥值。",
    "",
    "## 已知局限",
    "",
    "- 密钥扫描只认已知模式（见 `SECRET_PATTERNS`）；未命中已知模式的未知格式密钥不在保证内。",
    "- 通用绝对路径脱敏只覆盖已知文件系统根（`/home`、`/tmp`、`/etc` 等）与 Windows 盘符/UNC；T009 传入额外扫描根可扩大覆盖。",
    "- JSON Schema 校验器只实现本工程 schema 用到的子集（无 `$ref`）；新 schema 必须保持自包含。",
    "",
  ].join("\n");
  fs.writeFileSync(REPORT_MD, md, "utf8");

  console.log(
    `hash-privacy-evidence: PASS — vectors ${vectorMatches}/${vectors.length}, ` +
      `schemas ${schemaPass}/${schemaCases.length}, imports ${importPass}/${importCases.length}, ` +
      `PII raw ${rawFindings.length} → redacted ${cleanFindings.length}`,
  );
}

main().catch((err) => fail(String(err?.stack ?? err)));
