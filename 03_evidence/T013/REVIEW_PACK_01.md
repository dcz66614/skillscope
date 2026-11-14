# REVIEW_PACK_01 — 规格、控制与宿主规则（P023 T013 独立复核）

- 任务：P023 SkillScope T013（S5 独立复核）
- 审查者：独立审查会话（未参与 T001–T012 实现）
- 冻结候选：`8a7f736`（`P023: T012 control note`）；S0 gate `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`
- 日期（UTC）：2026-11-13
- 本包范围：规格书、实施计划、决策日志、控制文件、宿主规则文档、JSON Schema、README/quickstart、CI 工作流。
- 结论：本包范围内未发现 P0/P1。发现 2 项 P2（见 FINDINGS.md：P2-T013-05、P2-T013-08 的一部分）与若干备注。

## 1. 读过的文件（全部全文）

| 文件 | 字节 | 结论 |
|---|---|---|
| `01_spec/PROJECT_BOOK.md` | 31,870 | 与实现一致；§4.1/§4.2/§4.3/§4.4/§5.2/§6/§10.3 均在代码与测试中找到对应物 |
| `01_spec/IMPLEMENTATION_PLAN.md` | 34,795 | §5 T013 任务卡、§3.3 冻结脚本表、§6 S0 硬门、T014 卡均已核对；见 §2 的三处出入 |
| `00_control/DECISION_LOG.md` | 全文 | ADR-001–ADR-017 + 脚本补充记录；逐条与代码核对，见 §3 |
| `00_control/TASK_BOARD.csv` | 全文 | T001–T012 PASS，T013 READY，T014 BLOCKED；与 git 历史一致 |
| `00_control/PROJECT_STATE.json` | 全文 | `S4_T012_PASS`，s0_gate PASS，gate sha 与实测一致；T013 未更新该文件（控制状态由 Muse 在验收时更新，本审查不代写） |
| `00_control/ENVIRONMENT_REPORT.md` | 全文 | T001 实测环境；一处 mojibake（`probe.mjs���只读`）为历史证据文件原样，不改 |
| `00_control/P023_SPEC_VERIFICATION.md` | 已读（T013 立项时） | 规格验证记录；与 Drive 文件一致 |
| `docs/host-rules.md` | 全文 | 三宿主规则与 PoC/适配器行为逐条核对；见 §4 |
| `schemas/skillscope-profile-v1.json` | 全文 | 含 `forbidden_scopes`（T006 扩展）；与 `src/contracts/index.ts` 的 `ProfileV1` 有接口漂移，见 P2-T013-05 |
| `schemas/skillscope-report-v1.json` | 全文 | `$id skillscope.report/v1`，10 个 required 字段；与 `src/report` 输出一致 |
| `schemas/skillscope-audit-result-v1.json` | 全文 | `$id skillscope.audit-result/v1`，8 个 required 字段；与 kernel `AuditResult` 一致 |
| `schemas/README.md` | 全文 | 说明 schema 是 `src/io` 校验的唯一真源；OMB snapshot 不复制、只引用——与实现一致 |
| `src/adapters/openmausbot/openmausbot-snapshot-v1.json` | 全文（结构核对） | `$id openmausbot-snapshot/v1`；required `[version, skills, loadableRoots]`；skill kind 枚举 7 项；`emptyLists` 语义与 `snapshot.ts` 一致，测试 `tests/openmausbot/snapshot.test.ts:183` 断言两者一致 |
| `src/adapters/claude/claude-rules.json` | 全文 | `skillscope.claude-rules/v1`；7 scopes、4 层 precedence、disable mechanisms；测试 `tests/claude/rules.test.ts` 断言与 `rules.ts` 一致 |
| `README.md` | 全文 | 退出码表、finding 列表、边界声明均与实测一致 |
| `docs/quickstart.md` | 全文 | 首审计 INCOMPLETE 的说明与 Codex 探针实测一致（缺失 USER/ADMIN 目录 → 未枚举） |
| `.github/workflows/skillscope.yml` | 全文 | 只调用本地 CLI；`verify --fixtures s0` 步骤与 gate 一致；注释诚实说明 checkout/setup-node 是仅有的外部步骤 |
| `src/adapters/codex/README.md` | 全文 | 规则来源表与 `codex-poc.ts` 步骤对应；4 项“文档化简化”均为 PoC 范围声明，非缺陷 |

## 2. 实施计划的三处出入（均已记录，不构成 P0/P1）

1. **证据路径**：计划 §5 T013 写 `evidence/T013/...`，仓库实际证据目录为 `03_evidence/T013/`。T013 验收命令原文 `sha256sum -c evidence/T013/review-inputs.sha256` 在仓库中须为 `sha256sum -c 03_evidence/T013/review-inputs.sha256`。本审查按实际路径执行并通过（638 行全部 OK，见 T013_REPORT.md）。
2. **T014 脚本前向引用**：计划 §3.3 冻结脚本表与 T014 验收命令引用 `npm run release:build` / `npm run release:verify`，但 `scripts/release-build.mjs` 与 `scripts/release-verify.mjs` 在冻结候选 `8a7f736` 中**不存在**（只有 `release-rehearsal.mjs`）。T014 拥有这两个脚本的创建；现时调用会 ENOENT。记为 P2-T013-08（T014 自有，不开 FIX）。
3. **`test:property` 脚本改线**：计划 §3.3 写 `"test:property": "vitest run tests/property"`，实际 `package.json` 为 `node ./scripts/property-test.mjs`（vitest 无 `--seed` 选项）。T011 报告 §4 说明原因并记录在 DECISION_LOG；行为等价（默认仍为冻结 seed），接受。

## 3. ADR 逐条核对结果

| ADR | 内容 | 核对结果 |
|---|---|---|
| ADR-001 | 源码树在仓库根（不用 `02_source/` 嵌套） | 通过。`src/` 在根；计划 §10 的嵌套布局未使用，§3.3 冻结脚本优先 |
| ADR-002 | vitest 5.1.0 | 通过。`package-lock.json` 锁定 5.1.0 |
| ADR-003 | TOML 解析器 smol-toml 1.9.1 | 通过。`codex-poc.ts:55` 导入；lockfile 锁定；仅有的两个运行时依赖之一 |
| ADR-004 | YAML 解析器 yaml 2.9.1 | 通过。`manifest.ts` 使用；lockfile 锁定 |
| ADR-005 | kernel 拥有策略比较权 | 通过。`src/cli/audit.ts` 把 `policy` 传给 `resolveCodexAudit(native, policy)`；`src/adapters/claude/adapter.ts` 传 `input.policy`；`src/adapters/openmausbot/adapter.ts` 两分支均传 `input.policy`。实测：`resolveCodexAudit(poc, null)` 直接抛 `invalid policy: policy must be an object`（fail-closed，不静默丢 finding） |
| ADR-006 | 有效集 = ELIGIBLE，不是 DISCOVERED | 通过。`src/policy/index.ts` 的 `effectiveInstances` 只过滤 `status === "ELIGIBLE"`；PoC 内联策略检查（Claude/OMB）把 ELIGIBLE **或** DISCOVERED 计为有效是已记录的分歧，kernel 会剥离并重算；S0 夹具 o09 无 policy，不裁决该分歧。Property P8 覆盖 |
| ADR-007 | OMB 完整适配器需版本化 snapshot；缺失 → INCOMPLETE | 通过。`adapter.ts` 与 `snapshot.ts` 实现；S0 o13/o14 覆盖 |
| ADR-008 | 无 `pluginId` 的 plugin skill → UNKNOWN / INCOMPLETE（P1, PLUGIN） | 通过。S0 o08 覆盖 |
| ADR-009 | 不可读 settings 层 → INCOMPLETE，未知 scope 以层命名 | 通过。`settings.ts` 实现；S0 无直接夹具但 `tests/claude/settings.test.ts` 与 b03/b04 覆盖 |
| ADR-010 | plugin disable 只读官方 `enabledPlugins`，不用 `disabledPlugins`；仅 managed 层的 `strictKnownMarketplaces` 生效 | 通过。`settings.ts` 与 `rules.test.ts`（断言 mechanisms 不含 `disabledPlugins`） |
| ADR-011 | canonical JSON 规则 | 通过（实现层面见 REVIEW_PACK_02 §4；跨语言边角分歧见 P2-T013-02） |
| ADR-012 | redaction 规则 | 通过。`src/privacy/index.ts` 实现；CLI 在写报告前对整个 report 做 `redactReport`；demo HTML 实测 0 绝对路径 |
| ADR-013 | CLI 报告哈希 + profile→adapter 映射 | 通过。`src/cli/audit.ts` 与 `src/report/index.ts` 实现；`oracle_result_sha256` 诚实为 null（CLI 从不跑 Oracle）；INCOMPLETE 时 `observed_count` 为 null |
| ADR-014 | `--ci` 语义 + 离线检查（4 项独立检查） | 通过。`offline-check.mjs` 四项检查均实测通过；INCOMPLETE 永不弱化为 0（exit-code 矩阵 T010 实测） |
| ADR-015 | canonical 键先 NFC 再排序；NFC 碰撞键 fail-closed 抛错 | 通过。`src/canonical/index.ts` 实现；T011 回归测试锁定；Python 锚点 `e85a9a77…` 已验证；生产与 Oracle 在碰撞键上的分歧只影响病态输入（见 REVIEW_PACK_03 §3） |
| ADR-016 | T011 三层回归（golden/property/mutation） | 通过。`tests/golden`、`tests/property`、`tests/mutation` 均在套件内；mutation 20/20（T011 证据；本轮未重跑全量 mutation，见局限） |
| ADR-017 | E2E 是文件级，非浏览器驱动；headless Chromium 只渲染截图，无缓存时跳过不失败 | 通过。`scripts/e2e.mjs` 实现；本轮截图成功（136,209 B）；OPEN-003 已关闭 |

OPEN-001/002/003/004 全部 CLOSED；DECISION_LOG 无待决项。

## 4. 宿主规则逐条核对（docs/host-rules.md vs 行为）

- **共享语义**：实例身份 = source root + canonical path + content hash（T005 证据）；有效集 = ELIGIBLE（ADR-006）；未知 = INCOMPLETE 永不为空（gate 11 个未枚举源跨 10 个夹具）；策略比较归规则引擎（ADR-005）；未知宿主版本 INCOMPLETE（o13）。
- **Codex**：REPO/USER/ADMIN/SYSTEM/PLUGIN 五源；name selector 跨根命中多实例 → NAME_SELECTOR_BLAST_RADIUS（c04/c14）；**实测**：`config.toml` 非法 → PoC INCOMPLETE，`unknownSources [USER, ADMIN, SYSTEM, PLUGIN]`，finding `FAIL_OPEN_CONFIG/GLOBAL` + 4× `SOURCE_NOT_ENUMERATED`，REPO 实例 UNKNOWN；kernel 承接为 `unknownScopes [ADMIN, PLUGIN, SYSTEM, USER]`。文档“SYSTEM / PLUGIN 报告 unknown”成立。ADMIN 根为 profile 中 ADMIN 源路径的 dirname、无则默认 `<profileDir>/admin`——代码与文档一致。
- **Claude Code**：四层 precedence managed > user > project > local；`enabledPlugins`（含 bare 名）与 `skillOverrides`（命名空间不压平）；USER 覆盖确定性（`diagnostics.overriddenByUser`）；git-source marketplace 离线 INCOMPLETE；`strictKnownMarketplaces` 仅 managed 层；trust gating（ADD_DIR 与 marketplace 根）；account sync 无 snapshot → INCOMPLETE；extra plugin 目录冲突 → DISABLE_MISMATCH（P1）。以上均在 `adapter.ts`/`settings.ts`/`marketplace.ts`/`rules.ts` 中实现，S0 c01–c16 与 T008 夹具 b01–b18 覆盖。
- **OpenMausBot**：snapshot 必需（缺失/非 JSON/形状非法 → INCOMPLETE + unknown scope `SNAPSHOT`）；`emptyLists` 声明空列表；`disabledPluginIds`；无 `pluginId` → UNKNOWN；snapshot 与磁盘对账（磁盘有、列表无 → INCOMPLETE）；不写 `config.json`/`library-opt-out.json`，不调私有 API。均在 `adapter.ts`/`snapshot.ts`/`openmausbot-poc.ts` 中实现，S0 o01–o16 覆盖。
- **未覆盖声明**：新于冻结规则矩阵的宿主版本、仅存于未公开存储的技能、未来 flag 翻转——文档明确列为不覆盖，与实现一致。

## 5. 本包未发现的问题之外的备注

- `00_control/ENVIRONMENT_REPORT.md` 有一处历史 mojibake（`probe.mjs���只读`）；历史证据文件，审查不改。
- Codex README 引用 OpenMausBot issue #5449 作为 Codex 规则来源之一：该 issue 是“每 bot 技能开关泄漏”的真实故障模式引用，不是 Codex 官方文档；文档中已说明是故障模式来源，可接受。
- `docs/images/scope-matrix.png` 为二进制图片，未做代码级审查；README 引用它仅作示意。
