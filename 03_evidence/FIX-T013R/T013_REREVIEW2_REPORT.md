# P023 SkillScope — T013 独立复审报告（第三轮，FIX-T013R 后）

- **复审人：** Muse（独立复审子代理，只读复审，未修改任何源码、fixture、spec 或证据文件；验收运行改写的 `03_evidence/T012/` 5 个文件已用 `git checkout --` 恢复，`03_evidence/S0/` 无改动）
- **复审时间：** 2026-11-13 ~19:06–19:12 GMT
- **复审对象：** FIX-T013R 输出 commit `4469d4c`（记录提交 `a617832`），基线 `8fec944`（T013 复审第二轮：STATUS = FAIL，新 P1-T013R-01 + 新 P2-T013R-02）
- **依据：** 第二轮复审报告 `03_evidence/FIX-R1/T013_REREVIEW_REPORT.md` §7；FIX 报告 `03_evidence/FIX-T013R/FIX_T013R_REPORT.md`（10,597 B，sha256 `215dfb54…`，已全文读完）；Muse 核实记录 `~/workspace/coordinator-logs/muse-t013r-p1-verify.md` 与 `~/workspace/coordinator-logs/muse-fix-t013r-verify.md`（仅供参考，本报告全部结论均为自己重跑、自己复现得出）
- **环境：** Node v24.22.1（项目要求 >=24），npm 10.9.4，Python 3.12.3；root 会话，权限复现以 `nobody`（uid 65534）运行（r2-02 用例内含 nobody 驱动）

## 总判定

| 类别 | 数量 | 结论 |
|---|---|---|
| P0 | **0** | 无新 P0 |
| P1 | **0** | **P1-T013R-01 已修复并验证通过（§1）**：逃逸与 laundering 两场景均由 PASS 翻转为 INCOMPLETE + SYMLINK_OUTSIDE_ROOT，策略绕过已堵住 |
| P2 | **14** | **P2-T013R-02 已关闭（§2）**；其余 14 项仍登记（§6）。注：第二轮报告表头写“P2 16”，其 §6 表格逐项相加实为 15 项仍登记（R1 的 17 项中 2 关闭 + 1 FALSE = 14 仍登记，+ 新增 T013R-02 = 15），表头数字多算 1 项——本轮按逐项表为准：承接 15 项，本轮关闭 T013R-02 后余 **14** 项 |

**结论：STATUS = PASS。** P1-T013R-01 与 P2-T013R-02 均已修复属实，全部验收命令退出码 0，S0 gate 通过且 SHA 不变是正确结果（§8），未发现本轮修复引入的新缺陷（§7）。可进入新 T014 冻结与 R2（第 2/5 轮）。

## §1 P1-T013R-01 修复确认（阻断项已消除）

### 1.1 改动核对（diff 全文已读）

`src/adapters/codex/codex-poc.ts` `addSkillDir`：

- 守卫改为测解析后路径：`relativePosix(rootDir, realSkillPath)`（新增变量 `relRealFromRoot`）；`relFromRoot`（发现路径）仍供 `relativePath` 与别名归并——双变量分离，第一版曾破坏 c06 别名的教训已落实在代码与注释中。
- 逃逸时产生 SYMLINK_OUTSIDE_ROOT（P1，status UNKNOWN，sourceScope 为发现它的 scope），detail 为 `symlink '<layout 相对路径>' resolves outside its source root (<scope>); its target content was never enumerated as this scope`；不归属、不静默丢弃。
- **读操作在守卫之后**：亲查 `addSkillDir` 本体——`readFileSync(realSkillPath, "utf8")` 位于守卫 `return true` 与 `existing` 归并分支之后，逃逸目标内容确实不被读取。
- **守卫在归并之前**：`existing`（byRealPath）检查在守卫之后，故无论扫描顺序如何（USER 先扫或 REPO 先扫），逃逸发现都先产生 finding，不会把已归并实例的 scope 洗掉。
- PoC 状态推导新增 `findings.some((f) => f.status === "UNKNOWN") → INCOMPLETE`，与内核 `deriveAuditStatus`（`src/findings/index.ts:235–247`，UNKNOWN → INCOMPLETE 优先于 P1 → FAIL）逐行对齐，亲查属实。

Oracle `oracle/python/reference_resolver.py` `add_skill_dir`：同款守卫；`read_text` 移到守卫与归并之后；Codex 状态推导同步加 UNKNOWN 规则；detail 与 TS **逐字相同**（本轮实测核对，见 §1.2）。

### 1.2 复现（亲自跑，新构建 dist，Node 24.22.1；复现树原件未改动，跑完符号链接仍在原位）

复现树 `~/workspace/t013-rereview-logs/symlink-escape/` 与 `symlink-launder/`，驱动 `ts-run.mjs` / `ts-run2.mjs`；Oracle 用 `resolve_codex_native` 在同一树上重算（驱动 `/tmp/t013r2-oracle-run.py`，复审工作区脚本，不入仓库）。

**逃逸场景（`repo/.agents/skills/evil` → 仓库外 `outside/real-skill`）：**

| | 修复前（第二轮复审 + Muse 各自复现） | 修复后（本轮亲自跑） |
|---|---|---|
| TS PoC | PASS，`secret` ELIGIBLE，0 finding | **INCOMPLETE**，SYMLINK_OUTSIDE_ROOT（P1/UNKNOWN/REPO），`secret` 不再出现，`real` 仍 ELIGIBLE，coverage 5/5，unknownSources [] |
| Oracle | PASS，`secret` ELIGIBLE | **INCOMPLETE**，同款 finding，`secret` 不再出现，`real` 仍 ELIGIBLE，detail 与 TS 逐字相同 |

**Laundering 场景（`home/.agents/skills/evil-skill` 经 `repo/.agents/skills/link` 引入，策略禁 USER）：**

| | 修复前 | 修复后（本轮亲自跑） |
|---|---|---|
| TS PoC | PASS，`evil-skill` REPO ELIGIBLE | **INCOMPLETE**，`evil-skill` 归属 **USER ELIGIBLE**，aliases []，SYMLINK_OUTSIDE_ROOT |
| TS kernel（禁 USER） | PASS，无 finding | **INCOMPLETE**，SCOPE_LEAK + SYMLINK_OUTSIDE_ROOT |
| Oracle | PASS，REPO ELIGIBLE | **INCOMPLETE**，USER ELIGIBLE，SYMLINK_OUTSIDE_ROOT，detail 与 TS 逐字相同 |

对照（r2-01c，无符号链接）仍为 USER ELIGIBLE + kernel FAIL（SCOPE_LEAK），见 §2 回归。禁 USER 策略不再能经符号链接绕过。

### 1.3 规格对齐

`01_spec/PROJECT_BOOK.md` §4.3 新增逃逸段（行 214，亲查）：守卫测解析后路径；逃逸 → SYMLINK_OUTSIDE_ROOT（P1/UNKNOWN）+ INCOMPLETE，不归属、不读内容、不静默丢弃；根内符号链接仍跟随归并。§5.2 表格（行 285）本就要求 SYMLINK_OUTSIDE_ROOT 为 P1/INCOMPLETE，§12 风险表（行 568）要求 symlink loop / path escape 限界扫描、不越权读取——本次是实现向规格对齐。`00_control/DECISION_LOG.md` 新增 ADR-024，全文已读，内容与实现一致。

## §2 P2-T013R-02 修复确认（已关闭）

**改动核对（diff 全文已读）：** Oracle `resolve_claude_native` 的 account_sync 检查新增 `has_unverifiable`：`_codex_list_skill_dirs` 返回 error 时为真；某子目录 SKILL.md 的 stat 以非 ENOENT 失败时为真（`e.errno != errno.ENOENT`——errno 为 None 的通用 OSError 也落入未知，fail-closed；`errno` 已 import，行 60）。`has_skill or has_unverifiable` 时 ACCOUNT_SYNC 未知 + SOURCE_NOT_ENUMERATED（detail 与原 has_skill 分支逐字相同）。TS 侧无代码改动（本就正确）。

**回归验证（亲自跑）：**

- `npx vitest run tests/regression/r2-fix.test.ts tests/regression/r1-fix.test.ts`：**27/27 通过**（r1 22 + r2 5；r2 含 nobody 用例 r2-02：synced/ 可读、仅 `anthropic-skill/` 子目录 chmod 000 → PoC 与 kernel 均为 INCOMPLETE，unknownScopes [ACCOUNT_SYNC]，SOURCE_NOT_ENUMERATED detail 含 "account-synced skills exist on disk under"，可读的 `project-skill` 仍 ELIGIBLE）。夹具 `deny.json` 仅列 `home/.claude/skills/synced/anthropic-skill`，与断言一致。
- Oracle `TestFixT013ROracle.test_claude_synced_unreadable_skill_subdir_is_incomplete`（mocked PermissionError）：在 `npm run test:oracle` 58/58 内通过。Oracle 侧用 mocked EACCES 是已接受的既定模式（root 下无法产生真实 EACCES；真实权限行为由 TS 侧 nobody 用例覆盖）。

**结论：P2-T013R-02 已关闭。** 窄边 parity 差异消除，不影响任何现有结论。

## §3 验收命令（全部亲自跑，退出码 0）

2026-11-13 ~19:06–19:10 GMT，Node v24.22.1；完整日志 `~/workspace/t013-rereview2-logs/`（`typecheck.log`、`npm-test.log`、`oracle.log`、`s0-gate.log`、`e2e.log`、`offline.log`、`performance.log`、`verify-all.log`、`r1-r2-regression.log`）。

| 命令 | 退出码 | 亲自看到的关键输出 |
|---|---|---|
| `npm run typecheck` | 0 | `tsc --noEmit` 无错误 |
| `npm test` | 0 | 31 文件，**563/563 通过**（558 基线 + 5 新增 r2） |
| `npm run test:oracle` | 0 | **58/58 通过**（53 原有 + 5 新增 TestFixT013ROracle） |
| `npm run s0:gate` | 0 | PASS；48 fixture；parity 48/48；golden 48/48；检出 24/24；误报 0；incomplete sources 11；100 次重放 1 哈希；gate_sha256 `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca` **不变** |
| `npm run test:e2e` | 0 | PASS — **28/28** 检查通过；fixture 树跑前后字节一致（0 源码写） |
| `npm run test:offline` | 0 | offline-check: PASS — no account, no LLM, no network, no real skills needed |
| `npm run test:performance` | 0 | PASS；scan 中位数 288 ms（目标 ≤5000）；峰值 RSS 82.1 MiB（目标 ≤300）；500/500 实例，hash 稳定 |
| `npm run verify:all` | 0 | PASS — **8/8** 步骤通过；42 包 inventoried |
| `npx vitest run tests/regression/r2-fix.test.ts tests/regression/r1-fix.test.ts`（单独重跑，针对自己刚构建的 dist） | 0 | **27/27 通过**（r1 22 + r2 5，含 nobody 用例） |

注：性能数字三轮实测均有波动（FIX 报告 218/322/82.3；Muse 验收 421/525/83.2；本轮 288/—/82.1），均在目标内，属正常运行间波动。

## §4 覆盖矩阵与 review-inputs 验算

### 4.1 覆盖矩阵（本轮实际阅读情况）

复审范围是 FIX-T013R 变更集（28 个文件，812 行插入、13 行删除），阅读情况如下：

| 类别 | 文件 | 状态 |
|---|---|---|
| 核心（FIX 改动） | `src/adapters/codex/codex-poc.ts`（diff 全文 52 行 + `addSkillDir` 本体全文）、`src/findings/index.ts`（`deriveAuditStatus` 全文，状态对齐核对） | **READ** |
| Oracle | `oracle/python/reference_resolver.py`（diff 全文 51 行）、`oracle/tests/test_reference_resolver.py`（`TestFixT013ROracle` 全文 5 项 + `make_codex_layout`） | **READ** |
| 回归 | `tests/regression/r2-fix.test.ts`（全文 319 行）、`tests/regression/r2-driver.mjs`（未全文读；行为由 27/27 与 nobody 用例覆盖） | **READ**（驱动除外） |
| 文档 | `01_spec/PROJECT_BOOK.md`（§4.3 逃逸段、§5.2 findings 表、§12 风险表相关行）、`00_control/DECISION_LOG.md`（ADR-024、ADR-025 全文） | **READ**（相关章节） |
| 证据 | `03_evidence/FIX-T013R/FIX_T013R_REPORT.md`（全文）、第二轮复审报告（全文）、Muse 两份核实记录（全文） | **READ** |
| 夹具 | `tests/fixtures/regression/r2/`（5 个夹具；3 条符号链接经 `git ls-files -s` 核对为 mode 120000 入库；`deny.json` 已读） | **READ**（结构 + 关键文件） |
| 未全文读 | 其余 FIX-R1 变更文件（沿用第二轮复审的 READ 记录；本次未改动，行为由 563/563 与 58/58 覆盖） | **NOT_READ**——非本轮判定路径 |

### 4.2 review-inputs.sha256 重新验算（针对新 HEAD `a617832`）

`sha256sum -c 03_evidence/T013/review-inputs.sha256`（旧清单，638 项，冻结基线）：**587 OK / 51 FAILED**——与第二轮验算（针对 `24a5883`）计数完全相同，文件清单逐项一致。

51 个 FAILED 全部分解，无意外项：

- **50 个是 FIX-R1 改动文件**（与第二轮分解一致：3 个控制记录 + 2 个 spec + Oracle 2 个 + schema 1 个 + src 9 个 + 测试 3 个 + S0 OMB config 14 个 + T007 OMB config 15 个 + demo 2 个）。FIX-T013R 改动的文件中在清单内的（DECISION_LOG、PROJECT_BOOK、reference_resolver、test_reference_resolver、codex-poc、TASK_BOARD.csv）均已在该 50 个内，无新增 FAILED 项。
- **1 个是冻结时已有的差异**（`00_control/PROJECT_STATE.json`）：FIX-T013R 未改它；它是 R1 已确认的 T014 回填文件之一。属预期内。
- 新文件（r2 夹具、r2-fix.test.ts、r2-driver.mjs、`03_evidence/FIX-T013R/FIX_T013R_REPORT.md` 等）不在旧清单内，不计入 FAILED；T012 再生证据文件不在清单内（0 命中）。

**结论：** 与冻结基线的差异只应是 FIX 相关文件 + 记录文件——成立。新 T014 冻结时须重新生成 review-inputs 清单。

## §5 P2 登记（逐项确认）

承接第二轮的 15 项（见总判定注），本轮关闭 P2-T013R-02，余 14 项仍登记：

| 项 | 状态 |
|---|---|
| P2-T013-01 localeCompare 排序 | **仍登记**（FIX-T013R 未改） |
| P2-T013-02 三实现 canonical/哈希约定分裂 | **仍登记**（FIX-T013R 未改） |
| P2-T013-03 OMB finding detail 含绝对路径 | **仍登记**（FIX-T013R 未改；新 finding 的 detail 用 layout 相对路径，不含绝对路径） |
| P2-T013-04 OMB `unknownScopes` 可重复计数 | **仍登记**（FIX-T013R 未改） |
| P2-T013-05 ProfileV1 接口与 schema 漂移 | **仍登记**（FIX-T013R 未改） |
| P2-T013-06 Codex 跨来源 realpath 归并丢 scope | **仍登记**（FIX-T013R 未改行为：别名归并仍用发现路径 `relFromRoot`；S0 c06 golden 48/48 吻合，未受影响） |
| P2-T013-07 PoC frontmatter 无保留词规则 | **仍登记**（FIX-T013R 未改） |
| P2-T013-09 未使用的 marketplace/dedupeRootIds 代码 | **仍登记**（FIX-T013R 未改） |
| P2-T013-10 build-lock stale-steal TOCTOU | **仍登记**（FIX-T013R 未改） |
| P2-R1-11 PROJECT_BOOK/PLAN 仍写 NOT_IMPLEMENTED / READY_FOR_S0_ONLY | **仍登记**（FIX-T013R 未改） |
| P2-R1-12 review-inputs 635/638 | **仍登记**（冻结时控制文件漂移是机制使然；新冻结须重验，见 §4.2） |
| P2-R1-13 Drive T014 报告旧冻结 | **FALSE（按原文表述），不列为修复项**（沿用第二轮结论） |
| P2-R1-14 PROJECT_BOOK 示例用 `id` 而接口要求 `sourceRootId` | **仍登记**（FIX-T013R 未改） |
| P2-R1-15 干净目录重建未验证 `npm ci` | **仍登记**（FIX-T013R 未改） |
| P2-R1-16 Windows 未真机验证 | **仍登记**（FIX-T013R 未改） |
| **P2-T013R-02 Oracle accountSyncDir 窄边漏检** | **已关闭**（本轮，§2） |

## §6 新缺陷搜寻（本轮修复引入的问题与仍漏掉的边）

通读本次改动（`git diff 8fec944..HEAD`，两个实现各 50 行上下）并针对性核查，未发现新的 P0/P1/P2。核查项与结论：

1. **逃逸目标内容不被读取**：TS 侧 `readFileSync` 在守卫与归并之后、Oracle 侧 `read_text` 在守卫与归并之后——两侧均亲查代码确认，且复现输出中逃逸技能无 `contentSha256` 派生实例佐证。**无问题。**
2. **扫描顺序无关性**：守卫在 `existing` 归并检查之前——无论 USER 先扫还是 REPO 先扫，逃逸发现都先产生 finding，实例 scope 不会被后扫的根洗掉；laundering 场景实测 USER ELIGIBLE 佐证。**无问题。**
3. **重复 finding**：同一逃逸路径每个根只枚举一次，每条逃逸符号链接恰好产生 1 个 finding（两场景实测均为 1 个）；多条不同逃逸链接各产生自己的 finding，是正确的逐项记录。**无问题。**
4. **状态推导对齐**：PoC 的 UNKNOWN → INCOMPLETE 规则与 `deriveAuditStatus` 逐行一致（UNKNOWN 优先于 P1 → FAIL）；kernel 实测 INCOMPLETE 携带 SCOPE_LEAK + SYMLINK_OUTSIDE_ROOT 佐证。**无问题。**
5. **根内符号链接**：r2-01d 对照（`alias` → `real`，根内）仍归并为 1 个实例、aliases 为发现路径、PASS——第一版修复曾破坏的 c06 别名已由双变量设计保住，S0 golden 48/48 佐证。**无问题。**
6. **Oracle `errno` 处理**：`errno` 已 import；stat 失败时 errno 为 None 的通用 OSError 也落入未知（fail-closed）；mocked PermissionError 用例与 TS 侧 nobody 真实 EACCES 用例互补。**无问题。**
7. **P2-T013-06 是否被本次改动影响**：否。别名归并仍用发现路径，跨根归并行为未变；S0 c06 golden 吻合。仍登记，不扩大范围。**无问题。**
8. **第二轮报告 §8 补充观察**（Claude 多根同 scope 不可读时 `unknownScopes` 可能重复计入）：与已登记 P2-T013-04 同族，不新立项。**无问题。**

## §7 S0 gate SHA 不变——核实为正确

FIX 报告与 Muse 验收均称 gate SHA 不变（`a11d2a4c…`）是正确结果，本轮亲自重跑证实：S0 无逃逸 Codex 符号链接夹具（48 个 fixture 中无一含跨根符号链接），FIX-T013R 的守卫在 S0 输入上永不触发；48/48 判定输出全未变；OMB 迁移只改结构不改开关值（第二轮已验算 30/30）。gate SHA 是 48 个审计结论的哈希，结论未变则 SHA 不变。

## §8 已知局限裁定（FIX 报告列出的 3 项）

| # | 局限 | 裁定 |
|---|---|---|
| 1 | P2-T013-06（跨根归并丢 scope，同族）仍登记 | **接受。** 不在本次范围；本次改动未触碰其行为（§6 项 7）。 |
| 2 | 第二轮报告 §8 补充观察（Claude `unknownScopes` 可能重复计入） | **接受。** 与已登记 P2-T013-04 同族，不新立项。 |
| 3 | FIX 不更新 T014_FREEZE_REPORT（另派 T014） | **接受。** 属 T014 职责；新冻结将重新生成报告与发布包，R2 须用新冻结产物。 |

## 交付文件清单

- 本报告：`03_evidence/FIX-T013R/T013_REREVIEW2_REPORT.md`（本文件）
- 复审工作区（不在仓库内）：`~/workspace/t013-rereview2-logs/`（验收日志 `typecheck.log`、`npm-test.log`、`oracle.log`、`s0-gate.log`、`e2e.log`、`offline.log`、`performance.log`、`verify-all.log`、`r1-r2-regression.log`、review-inputs 验算 `review-inputs-check.txt` / `review-inputs-failed.txt` / `fix-t013r-changed.txt`）；Oracle 复现驱动 `/tmp/t013r2-oracle-run.py`（临时脚本，不入仓库）；复审复现树沿用 `~/workspace/t013-rereview-logs/symlink-escape/` 与 `symlink-launder/`（原件未改动）
- 仓库内无其他改动：复审结束时 `git status` 为空（除本报告文件外；T012 再生证据已恢复）

## 复审结论重申

- **P1-T013R-01 已修复属实（§1）**：守卫改测解析后路径，逃逸与 laundering 两场景均翻转为 INCOMPLETE + SYMLINK_OUTSIDE_ROOT，逃逸技能不再出现，laundering 技能归属 USER 且 kernel 不再 PASS；TS 与 Oracle 两侧输出一致，finding detail 逐字相同；回归 5+5。
- **P2-T013R-02 已关闭（§2）**：Oracle accountSyncDir 检查与 TS 的 `hasUnverifiable` 对齐，TS 侧 nobody 真实 EACCES 用例 + Oracle mocked 用例均通过。
- 全量验收全部退出码 0：typecheck、npm test 563/563、Oracle 58/58、s0:gate PASS（SHA 不变正确，§7）、e2e 28/28、offline、performance、verify:all 8/8；回归 r1+r2 27/27。
- review-inputs 587/51 与第二轮完全一致，分解无意外项；P2 余 14 项仍登记，无新 findings。
- **STATUS = PASS。** 可进入新 T014 冻结与 R2（第 2/5 轮）。
