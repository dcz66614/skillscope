# P023 SkillScope — FIX-T013R 返工报告

- **任务：** FIX-T013R（独立 T013 复审第二轮的返工）
- **基线：** `8fec944`（T013 re-review：STATUS = FAIL，新 P1-T013R-01 + 新 P2-T013R-02）
- **依据：** `03_evidence/FIX-R1/T013_REREVIEW_REPORT.md` §7；Muse 核实记录 `~/workspace/coordinator-logs/muse-t013r-p1-verify.md`（P1-T013R-01 = TRUE，亲自复现）
- **时间：** 2026-11-13 ~18:52–19:05 GMT
- **环境：** Node v24.22.1，npm 10.9.4，Python 3.12.3

## 总判定

| 项 | 结论 |
|---|---|
| P1-T013R-01 Codex symlink 逃逸守卫死代码 | **已修复**：TS 与 Oracle 同步改测解析后路径；逃逸 → SYMLINK_OUTSIDE_ROOT（P1/UNKNOWN）+ INCOMPLETE；复现两场景全部翻转为预期值；回归 5+5 |
| P2-T013R-02 Oracle accountSyncDir 窄边漏检 | **已修复**：Oracle 对齐 TS 的 `hasUnverifiable` 判定；回归 1+1 |
| P2-T013-06 跨根归并丢 scope | 仍登记，不列入本次修复（任务范围） |
| 其余 P2 / P2-R1-13 | 按原登记处理；P2-R1-13 仍 FALSE，不列为修复项 |
| 全量验收 | 全部退出码 0：typecheck、npm test 563/563、Oracle 58/58、s0:gate PASS（SHA 不变）、e2e 28/28、offline、performance、verify:all 8/8 |

## 1. P1-T013R-01 —— Codex symlink 逃逸守卫是死代码

### 根因

`src/adapters/codex/codex-poc.ts` 的 `addSkillDir` 先解析出 `realSkillPath = realpathSync(skillMdAbs)`，守卫却测未解析路径 `relativePosix(rootDir, skillMdAbs)`。`skillMdAbs` 按构造恒在根内词法，故守卫永不触发；逃逸技能被跟随、读取并归属到包含它的 scope。Oracle `reference_resolver.py` 的 `add_skill_dir` 镜像同一写法（且先读了逃逸目标内容才到守卫）。旧缺陷，冻结版本即有，FIX-R1 未引入，R1 与原 T013 均未发现。

### 修复（TS + Oracle 同步，detail 逐字相同）

- `src/adapters/codex/codex-poc.ts` `addSkillDir`：守卫改为测解析后路径；逃逸时产生 SYMLINK_OUTSIDE_ROOT（P1，status UNKNOWN，sourceScope 为发现它的 scope），不归属、不读目标内容、不静默丢弃；扫描本身仍为 "ok"（目录已完整枚举）。
- PoC 状态推导与内核 `deriveAuditStatus` 对齐：任一 UNKNOWN 状态 finding 即 INCOMPLETE，即使全部来源都已枚举。
- `oracle/python/reference_resolver.py` `add_skill_dir`：同款守卫；`read_text` 移到守卫与别名归并之后（逃逸目标不再被读取）；状态推导同步加 UNKNOWN 规则。
- **关键修正（验收中发现，见 §4）：** 发现路径与解析后路径分开为两个变量——`relFromRoot`（发现路径）仍供 `relativePath` 与别名归并，`relRealFromRoot`（解析后路径）只供守卫。第一版曾用解析后路径同时供别名归并，破坏了 S0 c06 的 golden。

### 复现前后（复审留下的复现树，原件未改动）

复现树 `~/workspace/t013-rereview-logs/symlink-escape/` 与 `symlink-launder/`，驱动 `ts-run.mjs` / `ts-run2.mjs`，新构建 dist，Node 24.22.1。Oracle 用 `resolve_codex_native` 在同一树上重算。

**逃逸场景（`repo/.agents/skills/evil` → 仓库外 `outside/real-skill`）：**

| | 修复前 | 修复后 |
|---|---|---|
| TS PoC | PASS，`secret` ELIGIBLE，0 finding | **INCOMPLETE**，SYMLINK_OUTSIDE_ROOT（P1/UNKNOWN/REPO），`secret` 不再出现，`real` 仍 ELIGIBLE，coverage 5/5，unknownSources [] |
| Oracle | PASS，`secret` ELIGIBLE | **INCOMPLETE**，同款 finding，`secret` 不再出现，`real` 仍 ELIGIBLE |

**Laundering 场景（`home/.agents/skills/evil-skill` 经 `repo/.agents/skills/link` 引入，策略禁 USER）：**

| | 修复前 | 修复后 |
|---|---|---|
| TS PoC | PASS，`evil-skill` REPO ELIGIBLE（别名含 USER 路径） | **INCOMPLETE**，`evil-skill` USER ELIGIBLE，aliases []，SYMLINK_OUTSIDE_ROOT |
| TS kernel（禁 USER） | PASS，无 finding | **INCOMPLETE**，SCOPE_LEAK + SYMLINK_OUTSIDE_ROOT |
| Oracle | PASS，REPO ELIGIBLE | **INCOMPLETE**，USER ELIGIBLE，SYMLINK_OUTSIDE_ROOT |

**detail 逐字核对（TS vs Oracle）：** `symlink 'repo/.agents/skills/evil/SKILL.md' resolves outside its source root (REPO); its target content was never enumerated as this scope`——两侧逐字相同。

### 回归样本

- `tests/fixtures/regression/r2/r2-01-codex-symlink-escape/`（逃逸：`evil` → `../../../outside/real-skill`，`secret` 在根外）
- `tests/fixtures/regression/r2/r2-01b-codex-symlink-launder/`（laundering：`link` → `../../../home/.agents/skills/evil-skill`）
- `tests/fixtures/regression/r2/r2-01c-codex-launder-control/`（对照：同一技能，无符号链接）
- `tests/fixtures/regression/r2/r2-01d-codex-symlink-alias-in-root/`（对照：根内别名 `alias` → `real`，仍归并、仍 PASS）
- `tests/regression/r2-fix.test.ts`（4 项进程内：逃逸、laundering、laundering 对照、根内别名对照）——5/5 通过
- `oracle/tests/test_reference_resolver.py` 新增 `TestFixT013ROracle`（逃逸、laundering、laundering 对照、根内别名对照）——5/5 通过

## 2. P2-T013R-02 —— Oracle accountSyncDir 漏掉 synced/ 内仅有的不可读技能子目录

### 根因

Oracle `resolve_claude_native` 的 account_sync 检查：`_codex_list_skill_dirs` 返回 error 时 `has_skill` 保持 False；某子目录 SKILL.md 的 stat 以非 ENOENT 失败时 `except OSError: continue` 直接吞掉。两种情况都无 finding。TS 侧经 `scanSkillRoot` 得 SKILL_MD_UNREADABLE/EACCES → `hasUnverifiable` → UNKNOWN，本就正确。

### 修复

Oracle 该检查改为：listing error 或 SKILL.md stat 非 ENOENT 失败时 `has_unverifiable = True`；`has_skill or has_unverifiable` 时 ACCOUNT_SYNC 未知 + SOURCE_NOT_ENUMERATED（detail 与原 has_skill 分支逐字相同）。TS 侧无代码改动。

### 回归样本

- `tests/fixtures/regression/r2/r2-02-claude-synced-unreadable-skill/` + `tests/regression/r2-driver.mjs`（`r2-02` 场景）+ `tests/regression/r2-fix.test.ts` nobody 用例：synced/ 可读、仅 `anthropic-skill/` 子目录 chmod 000 → PoC 与 kernel 均为 INCOMPLETE，unknownScopes [ACCOUNT_SYNC]，SOURCE_NOT_ENUMERATED（detail 含 "account-synced skills exist on disk under"）；可读的 `project-skill` 仍 ELIGIBLE。
- Oracle `TestFixT013ROracle.test_claude_synced_unreadable_skill_subdir_is_incomplete`（mocked PermissionError）：INCOMPLETE，ACCOUNT_SYNC 未知，实例仅剩 `project-skill`。

## 3. 规格与决策同步

- `01_spec/PROJECT_BOOK.md` §4.3 新增“符号链接逃逸（FIX-T013R，P1-T013R-01）”段：守卫测解析后路径；逃逸 → SYMLINK_OUTSIDE_ROOT（P1/UNKNOWN）+ INCOMPLETE，不归属、不读内容、不静默丢弃；根内符号链接仍跟随归并。§5.2 表格本就要求 SYMLINK_OUTSIDE_ROOT 为 P1/INCOMPLETE，本次是实现向规格对齐，表格无改动。
- `00_control/DECISION_LOG.md` 新增 ADR-024（逃逸守卫测解析后路径）与 ADR-025（Oracle accountSyncDir 对齐 TS hasUnverifiable）。

## 4. 验收中发现并已修复的回归（c06 别名）

第一版修复把 `relFromRoot` 直接改为解析后路径并复用于别名归并，全量测试 4 项失败：S0 gate `codex/c06-symlink-alias` production/oracle 与 golden 均 47/48（别名被写成真实路径 `.agents/skills/alpha/SKILL.md`，golden 为 `.agents/skills/alpha-alias/SKILL.md`），连带 `tests/codex/codex-poc.test.ts`、`tests/golden/oracle-parity.test.ts`、`tests/cli/cli.test.ts`（verify --fixtures s0）各 1 项失败。根因：别名归并必须用发现路径，只有守卫用解析后路径。修正为双变量（`relFromRoot` / `relRealFromRoot`，Oracle 同理）后全量重跑 563/563，S0 gate 48/48 golden 吻合。本节如实记录：该回归由验收套件捕获，非上线后发现。

## 5. 验收命令（全部亲自跑，退出码 0）

2026-11-13 ~18:58–19:04 GMT，Node v24.22.1；日志 `/tmp/fix-t013r-*.log`。

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm run typecheck` | 0 | `tsc --noEmit` 无错误 |
| `npm test` | 0 | 31 文件，**563/563 通过**（558 基线 + 5 新增 r2） |
| `npm run test:oracle` | 0 | **58/58 通过**（53 原有 + 5 新增 TestFixT013ROracle） |
| `npm run s0:gate` | 0 | PASS；48 fixture；parity 48/48；golden 48/48；检出 24/24；误报 0；incomplete sources 11；100 次重放 1 哈希；gate_sha256 `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca` **不变** |
| `npm run test:e2e` | 0 | PASS — **28/28** 检查通过 |
| `npm run test:offline` | 0 | offline-check: PASS |
| `npm run test:performance` | 0 | PASS；scan 中位数 218 ms（目标 ≤5000）；HTML 中位数 322 ms（目标 ≤2000）；峰值 RSS 82.3 MiB（目标 ≤300）；500/500 实例，hash 稳定 |
| `npm run verify:all` | 0 | PASS — **8/8** 步骤通过；42 包 inventoried |

注：验收运行改写的 `03_evidence/T012/` 5 个文件（仅时间戳/耗时）已用 `git checkout --` 恢复；`03_evidence/S0/` 无改动。

## 6. 改动文件清单

| 文件 | 改动 |
|---|---|
| `src/adapters/codex/codex-poc.ts` | 逃逸守卫改测解析后路径（双变量）+ SYMLINK_OUTSIDE_ROOT finding + 状态推导对齐 deriveAuditStatus；模块头与 `addSkillDir` 注释同步 |
| `oracle/python/reference_resolver.py` | `add_skill_dir` 同款守卫（`read_text` 移到守卫后）+ Codex 状态推导 UNKNOWN 规则 + accountSyncDir `has_unverifiable` 对齐 |
| `oracle/tests/test_reference_resolver.py` | 新增 `TestFixT013ROracle`（5 项） |
| `tests/regression/r2-fix.test.ts` | 新增（5 项：4 进程内 + 1 nobody） |
| `tests/regression/r2-driver.mjs` | 新增（`r2-02` nobody 场景） |
| `tests/fixtures/regression/r2/` | 新增 5 个夹具（4 Codex + 1 Claude；含 3 条相对符号链接） |
| `01_spec/PROJECT_BOOK.md` | §4.3 新增逃逸段 |
| `00_control/DECISION_LOG.md` | 新增 ADR-024、ADR-025 |
| `03_evidence/FIX-T013R/FIX_T013R_REPORT.md` | 本文件 |

## 7. 已知局限

- P2-T013-06（Codex 跨根归并丢 scope，与 P1-T013R-01 同族）仍登记，不在本次范围。
- 复审报告 §8 补充观察（Claude PoC 多根同 scope 不可读时 `unknownScopes` 可能重复计入）与已登记 P2-T013-04 同族，不新立项。
- 验收日志在 `/tmp/fix-t013r-*.log`（临时位置，不入仓库）；复现驱动与复现树在复审工作区 `~/workspace/t013-rereview-logs/`（原件未改动）。

## 下一步

Muse 亲自验收 → 新的独立 T013 复核 → 新 T014 冻结 → R2（第 2/5 轮）。
