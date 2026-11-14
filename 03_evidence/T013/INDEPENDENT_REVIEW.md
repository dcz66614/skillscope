# INDEPENDENT_REVIEW.md — P023 SkillScope T013 独立复核

- 任务：P023 SkillScope T013（S5 独立复核）
- 审查者：独立审查会话（未参与 T001–T012 的设计与实现；未修改任何源码、fixture、golden、Oracle 或 release 文件）
- 冻结候选：`8a7f736`（`P023: T012 control note`）
- S0 gate 哈希：`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`（本轮重跑，不变）
- 日期（UTC）：2026-11-13
- 结论：**PASS**。P0 = 0，P1 = 0，P2 = 10（全部登记于 FINDINGS.md，非阻塞）。S0 48/48 parity、24/24 检出、0/24 误报持续通过；六条验收命令真实退出码均为 0。

## 1. 审查方法

- **不信任测试全绿**：全量套件 525/525、Oracle 42/42、e2e 28/28 全部亲自重跑并记录退出码与关键输出；同时逐文件读源码、规则与脚本（核心生产文件 + 配置 100% 全文读过，见 COVERAGE_MATRIX.csv）。
- **逐条核对冻结语义决策**：ADR-001–ADR-017 每条对照代码（见 §3）；三宿主规则逐条对照 `docs/host-rules.md` 与行为；Python Oracle 的独立性从导入与实现两方面核查。
- **实测探针**（合成输入、只读、/tmp 内）：Codex 非法 `config.toml`、OMB 缺失 snapshot skill（同 scope 两个）、canonical 跨语言边角（U+2028、emoji、astral 键、-0.0、孤 surrogate）、OMB 适配器绝对路径、demo HTML 脱敏。所有探针结论均写入 REVIEW_PACK_02/03，不凭印象断言。
- **不接受实现者自评**：T001–T012 的报告与 `coordinator-logs/muse-t00*-verify.md` 只作线索；每条关键结论（gate hash、测试数、修复有效性）均由本轮亲自重跑或重读验证。
- **证据恢复**：验收命令重写的 `03_evidence/T012/`（5 个文件）与 `03_evidence/S0/` 已按惯例 `git checkout --` 恢复；本轮的输出只写在 `03_evidence/T013/` 与 `00_control/REVIEW_INDEX.md`。

## 2. 审查范围

| 包 | 内容 | 结论 |
|---|---|---|
| REVIEW_PACK_01 | 规格、控制、宿主规则、Schema、README/quickstart、CI 工作流 | 无 P0/P1；2 项 P2 相关 |
| REVIEW_PACK_02 | `src/` 全部 29 个代码/配置文件 + Codex README | 无 P0/P1；7 项 P2 |
| REVIEW_PACK_03 | Oracle、S0 gate、全部 scripts、golden/property/mutation 基建、T012 两处修复 | 无 P0/P1；2 项 P2 |
| COVERAGE_MATRIX.csv | 逐文件 READ / NOT_READ / RUN / GATE_VALIDATED | 核心生产文件 + 配置 100% READ；见 §5 的诚实边界 |
| FINDINGS.md | P0/P1/P2 清单 | P0=0，P1=0，P2=10 |

## 3. 冻结语义决策核对（任务书点名项）

1. **ADR-005（kernel 拥有策略比较权）**：通过。CLI（`src/cli/audit.ts`）与两完整适配器（Claude、OMB，两分支）均把 profile policy 传进 kernel；实测 `resolveCodexAudit(poc, null)` 直接抛错，不静默丢 finding。
2. **ADR-006（有效集 = ELIGIBLE）**：通过。`src/policy/index.ts` 只取 ELIGIBLE；PoC 内联检查把 DISCOVERED 计为有效是已记录的分歧，kernel 剥离重算；S0 o09 无 policy，不裁决。
3. **ADR-015（T011 修复：先 NFC 再排序；碰撞 fail-closed）**：通过。`src/canonical/index.ts` 实现与 Oracle 一致（Python 锚点 `e85a9a77…` 已验证）；生产与 Oracle 在 NFC 碰撞键上的分歧（生产抛错、Oracle 静默取后者）只影响病态输入。
4. **ADR-011/ADR-012（canonical 与 redaction）后续遵守**：通过。`report`/`io` 均经 canonical 函数写盘；CLI 在写报告前对整个 report 做 `redactReport`；demo HTML 实测 0 绝对路径。但发现跨语言边角分歧（P2-T013-02）与 OMB 适配器未 sanitize（P2-T013-03）。
5. **T012 两处修复**：通过。23 个 `.gitkeep`（`git ls-files "**/.gitkeep"` 本轮仍为 23 个；`release-rehearsal.mjs` 逐一核查；gate hash 不变；codex-fail audit_sha256 不变 `948f9414…`）；并行竞态三轮修复（globalSetup 一次构建 + 共享锁 + `SKILLSCOPE_GATE_NO_REBUILD=1` 仅测试用；本轮两次全量 525/525 无 flake）。**两处修复均未降低正确性门槛**：缺失 skills 目录仍 fail-closed（本轮 Codex 探针复证）；修复删除的是重复构建与重复 gate 测试，断言未动。

## 4. 三宿主规则核对

- **Codex**：五源、path/name selector、last-match-wins、bundled 开关、symlink 归并、失效配置 fail-closed——与 host-rules.md 一致，失效配置已实测（PoC INCOMPLETE，`unknownSources [USER,ADMIN,SYSTEM,PLUGIN]`，kernel 承接）。
- **Claude Code**：四层 precedence、enabledPlugins/skillOverrides、命名空间不压平、USER 覆盖确定性、git marketplace 离线 INCOMPLETE、strictKnownMarketplaces 仅 managed、trust gating、account sync、extra 目录冲突——与 host-rules.md 一致，S0 c01–c16 与 T008 b01–b18 覆盖。
- **OpenMausBot**：snapshot 必需、emptyLists、disabledPluginIds、无 pluginId → UNKNOWN、磁盘对账——与 host-rules.md 一致，S0 o01–o16 覆盖。

## 5. 覆盖率与诚实边界

- **核心生产文件 + 配置 100% 全文读过**：`src/` 29 个文件、`package.json`、`package-lock.json`（结构）、`tsconfig.json`、`tsconfig.build.json`、`vitest.config.ts`、全部 4 个 schema 文件、全部 scripts（22 个 .mjs/.py + 2 个 .d.mts）。见 COVERAGE_MATRIX.csv。
- **未逐行读、但经运行验证**：其余测试文件（全量套件 525/525 通过）；S0 48 夹具（gate 三方验证）；demo/T007/T008/T008b 夹具（经各自路径验证）；`tests/mutation/mutations.json`（T011 证据 20/20；本轮未重跑全量 mutation，见 §6）。
- **NOT_READ**：`scripts/release-build.mjs`、`scripts/release-verify.mjs`（文件不存在，T014 交付物；P2-T013-08）；`docs/images/scope-matrix.png`（二进制图片）。

## 6. 已知局限

1. 全量 mutation（20 变异 × 副本构建）本轮未重跑；T011 证据（20/20 = 100%）完整，且 gate/全量套件已重跑通过。mutation 只覆盖 kernel 规则，不覆盖适配器、CLI、IO 与隐私模块（T011 报告局限 2）。
2. Property 测试是对固定 seed 的有限随机抽样（每条性质 60–200 用例），不是穷举（T011 报告局限 1）。
3. Windows 未实测：本 VM 为 Linux；Windows 路径语义只用合成 fixture 测试（与 T001 环境报告一致）。
4. 性能基线只适用于本 VM（1.5 共享 CPU；T012 报告局限 1）。本轮 verify:all 内的 performance 步骤通过，未单独记录三次测量的中位数。
5. 审查在冻结候选 `8a7f736` 上进行；T013 审查文件本身的提交（OUTPUT_COMMIT）不改变任何源码、fixture、golden 或 Oracle 文件。
6. `review-inputs.sha256` 覆盖 638 个常规文件；2 个 git 跟踪的 symlink fixture（`alpha-alias` → `alpha`；`escape` → `../shared/secret`）因 `sha256sum` 无法哈希目录 symlink 而排除，其 git blob hash 记在 T013_REPORT.md §4。

## 7. 结论

冻结候选 `8a7f736` 通过 T013 独立复核：规格覆盖完整，核心实现与冻结规则一致，Python Oracle 独立，S0 门持续通过，P0/P1 为零。10 项 P2 已登记，均不阻塞发布；其中 P2-T013-08（`release:build`/`release:verify`）由 T014 自行创建脚本时解决，其余建议后续任务处理。**T014 可以解除 BLOCKED。**
