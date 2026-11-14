# P023 SkillScope — FIX-R1 报告（终审 R1 返工）

- **基线 commit：** `d36480a`（树干净；冻结 commit `a4b83ab`）
- **输出 commit：** `98b06fd04b438f59494cd7b0636478606047e9d7`（FIX 代码提交；本报告与 TASK_BOARD 的 hash 字段由后续记录提交填入，见 git log）
- **日期：** 2026-11-13（~17:39–18:30 GMT）
- **背景：** 终审 R1 FINAL_VERDICT: FAIL（GPT-6 + Extra High，2026-11-13 ~17:27 GMT；裁决原文 `~/workspace/p023-R1-verdict.md`）；独立核实确认 4 P0 + 4 P1 全部属实（`~/workspace/p023-gpt-R1-verification-2026-11-13.md`，25,276 B）。P2-R1-13 核实为 FALSE（按原文表述），不列为修复项；其余 16 项 P2 非阻断，按原登记处理。
- **结果总览：** 4 P0 + 4 P1 全部修复 + 1 对齐项；回归 22/22；Oracle 53/53；全量测试 558/558；S0 gate PASS，**gate SHA 不变** `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`（见 §S0 gate SHA 说明）；全部验收命令退出码 0。
- **许可证：** Sam 2026-11-13 ~18:02 GMT 决定全部项目许可证为 MIT；本 FIX 加入仓库根目录 LICENSE（Copyright (c) 2026 dcz66614，1065 B，sha256 `50b8b302ffcb53aec1866ad4b94721c200400e6aac8cee12db03b85f24e39ed2`，与 P021 的 LICENSE 同哈希）。

## 逐项前后对照（核实方复现场景，冻结构建 vs 新构建）

复现驱动：核实方的 `~/workspace/r1-verification/repro/repro-poc.mjs`（旧输出 `repro-poc.log`，307 行）对新构建重跑，输出见本目录 `repro-after.log`（367 行，sha256 `1975e54977a9194a26af0d245b50367baecd5eea028df287b21a3764cd30d84c`）。重跑用新 dist 的世界可读副本（见 §环境说明）；r102a/r102b 的 OMB 配置在副本中由顶层迁为嵌套结构（值不变——旧顶层配置在新实现下读作默认关闭，会改变场景本意）；r103 的驱动副本补传新增的 `accountSyncDir` 输入（旧驱动无此输入，PoC 根本看不到 synced/ 目录）。

| 场景 | 冻结构建（前） | 新构建（后） |
|---|---|---|
| P0-R1-01 Codex PoC（REPO 根 chmod 000，内有 private-skill） | PASS，0 实例，coverage 5/5 | **INCOMPLETE**，unknownScopes [REPO] |
| P0-R1-01 Codex 内核（策略禁 REPO） | PASS | **INCOMPLETE** |
| P0-R1-02 Claude PoC（proj-skill/SKILL.md chmod 000） | PASS，0 实例，coverage 1/1 | **INCOMPLETE**，SOURCE_NOT_ENUMERATED(P1) |
| P0-R1-02 Claude 内核（策略禁 PROJECT） | PASS | **INCOMPLETE** |
| P0-R1-02 Claude 完整适配器 | PASS | **INCOMPLETE** |
| P0-R1-03 Claude PoC（synced/anthropic-skill 存在，无 ACCOUNT_SYNC 根） | PASS，2/2 | **INCOMPLETE**，unknownScopes [ACCOUNT_SYNC]，coverage 2/3 |
| P0-R1-03 Claude 内核 | PASS | **INCOMPLETE** |
| P0-R1-04 OMB 嵌套 features PoC（library ON，策略禁 SHARED_LIBRARY） | FAIL（SCOPE_LEAK） | FAIL（SCOPE_LEAK，实例为 ELIGIBLE） |
| P0-R1-04 OMB 嵌套 features 内核 | PASS（PoC 与内核分裂） | **FAIL**（对齐） |
| P0-R1-04 OMB 嵌套 features 完整适配器 | PASS | **FAIL** |
| P0-R1-04 对照：OMB 顶层 flags PoC / 内核 / 完整适配器 | FAIL / FAIL / FAIL | **PASS / PASS / PASS**（顶层键被忽略，读作默认关闭） |
| P1-R1-02a OMB PoC（config 目录 chmod 000） | FAIL（configSource "defaults"，误报为配置缺失） | **INCOMPLETE**，FAIL_OPEN_CONFIG(P1) |
| P1-R1-02a OMB 内核 / 完整适配器 | PASS / PASS | **INCOMPLETE / INCOMPLETE** |
| P1-R1-02b OMB PoC（opt-out 目录 chmod 000，策略允许 SHARED_LIBRARY） | PASS，实例 ELIGIBLE，无 finding | **INCOMPLETE**，实例仍 ELIGIBLE（宿主语义），FAIL_OPEN_CONFIG(P1) |
| P1-R1-02b OMB 内核 | PASS | **INCOMPLETE** |
| P1-R1-03 Claude 完整适配器（PERSONAL 根漏列，个人技能在磁盘上） | PASS，仅 PROJECT 实例 | **FAIL**，PERSONAL + PROJECT 两实例（派生后检出策略违例） |

CLI 契约项（P1-R1-01 / P1-R1-04）未包含在核实方的 PoC 驱动中，改由回归套件的 CLI 用例覆盖（见 §P1-R1-01、§P1-R1-04）。

## P0-R1-01 — Codex 技能根不可读静默返回空集合

**根因：** `src/adapters/codex/codex-poc.ts` 的 `listSkillDirs()` 捕获 `readdirSync()` 权限异常后返回 `[]`；上层 `scanSkillsDir()` 的失败未进 unknownSources。

**改动：**

- 新增共享模块 `src/fsutil/index.ts`：`classifyPath`（stat 一次：ENOENT/ENOTDIR → `missing`；EACCES/EPERM → `unreadable`；其他错误 fail-closed 判 `unreadable`）、`classifyError`（同映射，用于已捕获的错误）、`isContentUnknownSkip`（见 P0-R1-02）。
- `src/adapters/codex/codex-poc.ts`：`listSkillDirs` 返回 `{dirs} | {error: "unreadable"}`（任何 readdir 失败 → unreadable；子目录 stat ENOENT = 悬空符号链接，跳过；其他 stat 错误 → unreadable）；`hasSkillFile` 返回 `"yes" | "no" | "unreadable"`（ENOENT → no；其他 stat 错误 → unreadable）；`addSkillDir` 返回 boolean（realpath/read 失败 → false，不再抛错中断 PoC）；`scanSkillsDir` 返回 `"ok" | "missing" | "unreadable"`（基于 classifyPath；失败前已读到的技能仍保留，只标记来源未知）。REPO 循环：`"unreadable"` → `noteUnknown("REPO")`（missing = 已知无此来源，沿旧行为忽略）；USER/ADMIN：任何 ≠ `"ok"` → noteUnknown。`noteUnknown` 按 scope 去重。
- Oracle 同步镜像：`oracle/python/reference_resolver.py`（`errno_code` / `classify_error` / `classify_path` / `_codex_list_skill_dirs` / `add_skill_dir` → bool / `scan_skills_dir` 三态 / REPO/USER/ADMIN 调用点 / `note_unknown` 去重）。
- 单元测试：`tests/codex/codex-poc.test.ts` 新增“skills 路径是文件而非目录 = 已知无此来源”（tri-state 的 `missing` 分支；REPO 不进 unknownSources，PASS，coverage 5/5）。

**回归样本：** `tests/fixtures/regression/r1/r1-01-codex-repo-unreadable/`（REPO 技能根 `deny.json` 声明 chmod 000）+ 对照 `r1-01-codex-repo-readable/`；驱动 `tests/regression/r1-driver.mjs` 以 nobody 身份运行。

**复现前后：** 见上表 P0-R1-01 两行（PASS → INCOMPLETE）。

## P0-R1-02 — Claude 不可读 SKILL.md 被静默跳过

**根因：** `src/adapters/shared/skill-scan.ts` 已记录 SKILL_MD_UNREADABLE，但 Claude PoC 只特殊处理 ROOT_MISSING_OR_UNREADABLE；`src/resolver/index.ts` 的 `discoveryFindings()` 只把 SYMLINK_OUTSIDE_ROOT 转为 finding。其他跳过项静默消失。

**改动：**

- `src/adapters/shared/skill-scan.ts`：`SkippedEntry` 增可选 `code?: string`（errno）；SKILL.md 读失败时记录 errno；ROOT catch 同样记录 errno（见下方 bug）。
- `src/discovery/discovery.ts`：`SkippedEntry.code?`；ROOT_MISSING_OR_UNREADABLE / DIR_UNREADABLE / SKILL_MD_UNREADABLE（读失败）记录 errno；结构性跳过不记 code。现有 reason 字符串不变（symlink 测试钉住 SKILL_MD_UNREADABLE；`scripts/identity-evidence.mjs` 亦断言之）。
- `src/adapters/claude/claude-poc.ts`：内容未知的跳过项（`isContentUnknownSkip`）→ 该 scope 未知 + SOURCE_NOT_ENUMERATED，根不计入已枚举，已读技能仍上报；无论根是否 `required` 均适用（存在但不可读的技能仍可能被宿主加载）。ROOT_MISSING 处理不变（required 门控）。
- `src/resolver/index.ts`：`discoveryFindings()` 除 SYMLINK_OUTSIDE_ROOT 外，另将 `isContentUnknownSkip` 条目转为 SOURCE_NOT_ENUMERATED（P1，normalizeFinding 默认 UNKNOWN）。不转：ROOT_MISSING_OR_UNREADABLE（已通过 coverage 上报）、循环、悬空链接、深度/条目上限、路径逃逸、ENOENT SKILL.md（子目录不是技能）、目录名恰为 SKILL.md。
- `isContentUnknownSkip` 规则：SKILL_MD_TOO_LARGE 恒为未知；SKILL_MD_UNREADABLE / DIR_UNREADABLE 仅当 code 存在且 ≠ `"ENOENT"` 时为未知；ROOT_MISSING_OR_UNREADABLE 故意不覆盖（PoC/适配器已通过 coverage 上报，重复转会双报）。
- Oracle 同步镜像：`scan_skill_root` 在 SKILL.md 与 ROOT 跳过项上记 code；`_claude_shared_findings` 等。
- **修复期间抓到的 bug（2026-11-13 ~18:06 GMT）：** `scanSkillRoot` 的 ROOT catch 最初未记 `code`，导致 Claude PoC 的 accountSyncDir 检查把缺失的 synced/ 目录误判为不可读（全部 b 系列 fixture 误报 ACCOUNT_SYNC INCOMPLETE）。已在 `skill-scan.ts` 按 SKILL.md catch 的同模式补记 errno，并在 Oracle 的 `scan_skill_root` 中镜像。

**回归样本：** `tests/fixtures/regression/r1/r1-02-claude-skill-md-unreadable/`（SKILL.md `deny.json` 声明 chmod 000）+ 对照 `r1-02-claude-container-dir/`（PERSONAL 根含空 `synced/` 容器目录 + 可读技能，证明 ENOENT 跳过仍静默、PASS）；OMB 同类缺陷见 P1-R1-02（`scanSingleSkillDir`）。

**复现前后：** 见上表 P0-R1-02 三行（PASS → INCOMPLETE）。

**单元测试：** `tests/rules/resolver.test.ts` 的 discovery-skip describe 新增 2 测试（EACCES SKILL.md → P1/UNKNOWN finding，ENOENT 保持静默，ROOT 跳过不转；不可读 SKILL.md 经 resolver 使审计 INCOMPLETE）。

## P0-R1-03 — Claude `~/.claude/skills/synced/` 账号同步目录未识别

**根因：** 没有任何代码从 homeDir 派生 synced/ 目录。

**改动：**

- `src/adapters/claude/claude-poc.ts`：新增可选输入 `accountSyncDir?: string`（绝对路径 `~/.claude/skills/synced`）；仅当未声明 ACCOUNT_SYNC 根时检查：缺失（ENOENT/ENOTDIR）= 已知无此来源；目录含技能、或不可读、或根不可读 → 未知 ACCOUNT_SYNC + SOURCE_NOT_ENUMERATED，且 `requiredSources += 1`（未声明的标准来源不得悄悄缩小分母）。已声明 ACCOUNT_SYNC 根时以声明为准，不再查该目录。`resolveClaudeFixture` 将 accountSyncDir 透传。
- `src/adapters/claude/adapter.ts`：完整适配器在无 ACCOUNT_SYNC 根声明时把 `accountSyncDir` 传给 PoC。
- Oracle 同步镜像：`resolve_claude_native` 的 accountSyncDir 检查 + `resolve_claude_fixture` 透传。

**回归样本：** `tests/fixtures/regression/r1/r1-03-claude-synced-undeclared/`（synced/ 内有技能，无 ACCOUNT_SYNC 快照 → INCOMPLETE）+ 对照 `r1-03-claude-synced-absent/`（无 synced/ → PASS）与 `r1-03-claude-synced-declared/`（声明 ACCOUNT_SYNC 快照 → PASS）。

**复现前后：** 见上表 P0-R1-03 两行（PASS → INCOMPLETE，coverage 2/3，unknownScopes [ACCOUNT_SYNC]）。注意：核实方旧驱动未传 `accountSyncDir`，重跑时在驱动副本中补传（见表头说明）。

## P0-R1-04 — OpenMausBot 按顶层读 flags，官方真实结构是 `features.*`

**根因：** 实现与 Oracle 共用错误假设：从 config.json 顶层读 `skillsLibrary` / `claudeUserSkills`。官方 docs/feature-flags.md（main 分支，2026-11-13 核实）：“The server stores these options under `features` in its `config.json`”，两开关均标注 “Key under `features`”，默认 Off；默认配置 `~/.openmausbot/config.json` 或 OMB_DATA_DIR。

**改动：**

- `src/adapters/openmausbot/openmausbot-poc.ts`：只读 `features` 对象。`features` 缺失 → 默认值（顶层键被忽略——顶层-only 配置读作两开关关闭）；`features` 不是对象、或开关值不是布尔值 → 无效（FAIL_OPEN_CONFIG + CONFIG 未知）。Detail 字符串更新为指明 `features.claudeUserSkills` / `features.skillsLibrary`。Oracle 须用字节相同的 detail 字符串（parity 逐字段比较）。
- Oracle 同步镜像：`resolve_omb_native` 的 features 解析。
- **Fixture 迁移：** 全部顶层 flags 的 OMB config.json 改为嵌套 `{"features": {...}}`，布尔值逐个核对不变：S0 15 个（`tests/fixtures/s0/openmausbot/*/data/config.json`；o15 `{not json` 保持无效）、T007 15 个（`tests/fixtures/t007/openmausbot/*/…/config.json`；a11-corrupt-config 保持 `{not json`）、demo 1 个（`tests/fixtures/demo/openmausbot-incomplete/data/config.json`）。迁移脚本 `/tmp/migrate-omb-configs.py`（保留各文件原格式风格：pretty/单行、空格/紧凑分隔、有无尾换行；迁移前后核对开关值与 sha）：30 个迁移，2 个跳过。每个 fixture 的 `expected.json` 开关值不变，故无需改 expected 文件。另 `tests/openmausbot/openmausbot-poc.test.ts` 约 200 行的 scratch 配置 → 嵌套；Oracle 单元测试 `oracle/tests/test_reference_resolver.py:295` 的配置 → 嵌套。
- `scanSingleSkillDir`（P0-R1-02 同类缺陷）：现返回 `{scanned, unreadable}`；SKILL.md 缺失或不可读 → 该技能 scope 的 SOURCE_NOT_ENUMERATED，detail 与完整适配器的逐技能检查逐字相同（内核去重）；scope 压入时加 `includes` 守卫（canonical 形式排序但不去重）。导入原始技能扫描同理（scope IMPORTED，detail 指明原始路径）。**Parity 陷阱（2026-11-13 ~18:05 GMT）：** TS 侧缺失目录分支保留旧 detail；Oracle 初版误将两个分支都改成新措辞，已纠正为缺失目录分支同样保留旧 detail。
- 对齐项（见 §对齐项 ADR-023）：Claude 与 OMB 两个 PoC 的行内策略比较均由 ELIGIBLE-or-DISCOVERED 改为仅 ELIGIBLE，与内核一致。

**回归样本：** `tests/fixtures/regression/r1/r1-04-omb-features-nested/`（嵌套 features，library ON，策略禁 SHARED_LIBRARY → FAIL）+ 对照 `r1-04-omb-top-level/`（故意保留顶层配置 → 读作默认关闭，PASS）+ `r1-04-omb-features-nonboolean/` 与 `r1-04-omb-features-nonobject/`（→ INCOMPLETE）。

**复现前后：** 见上表 P0-R1-04 六行（嵌套：内核 PASS → FAIL；顶层对照：FAIL → PASS）。

## P1-R1-02 — OMB existsSync 无法区分权限拒绝与不存在

**根因：** 配置与 opt-out 的存在检查用 `existsSync`，EACCES 与 ENOENT 走同一分支；PoC 头部契约写明不可读配置 → FAIL_OPEN_CONFIG + INCOMPLETE，但 existsSync 路径永远到不了该分支。

**改动：**

- `src/adapters/openmausbot/openmausbot-poc.ts`：配置与 opt-out 的存在检查改用 `classifyPath`。配置不可读 → configSource `"invalid"` + CONFIG 未知 + FAIL_OPEN_CONFIG（detail：“exists but cannot be read”）。Opt-out 不可读 → FAIL_OPEN_CONFIG + SHARED_LIBRARY 未知 + INCOMPLETE，实例仍保持 ELIGIBLE（宿主语义：按官方文档，不可读的 opt-out 意味着 bot 保留技能）。快照技能路径检查用 `classifyPath(...) !== "present"`（缺失目录分支保留旧 detail “points at missing or unreadable directory <path>”）。
- 适配器自身的 `fs.existsSync(skillDir)` 检查（adapter.ts 约 369 行）**不是**本缺陷：它只区分缺失目录（PoC 已上报）与存在但不可读，且 detail 与 PoC 的逐字相同，内核去重（去重键见 `src/findings/index.ts` 的 `dedupeFindings`：id、sourceScope、status、detail、instanceIds、affectedCount；PoC finding 不带 `status` 字段，内核 `normalizeFinding` 对 SOURCE_NOT_ENUMERATED 赋 UNKNOWN）。
- Oracle 同步镜像：OMB `resolve_omb_native` 的 config/opt-out `classify_path` + 快照技能 classify + `scan_single_skill_dir` → `{"scanned", "unreadable"}` + 原始扫描处理。

**回归样本：** `tests/fixtures/regression/r1/r1-02a-omb-config-unreadable/`（data 目录 `deny.json` 声明 chmod 000）+ `r1-02b-omb-optout-unreadable/`（opt-out 目录 chmod 000）+ 对照 `r1-02b-omb-optout-listed/`（opt-out 列出该技能 → DISCOVERED）与 `r1-02b-omb-optout-missing/`（opt-out 缺失 → ELIGIBLE）。

**复现前后：** 见上表 P1-R1-02a / P1-R1-02b 各行（PASS → INCOMPLETE；opt-out 场景实例保持 ELIGIBLE）。

## P1-R1-03 — Claude 来源依赖手动列入 source_roots，无完整性门禁

**根因：** PERSONAL / Nested / ACCOUNT_SYNC 完全依赖 profile 手动列入 source_roots；漏列即静默缺失。

**改动：**

- `src/adapters/claude/adapter.ts`：step-0 派生（`deriveStandardRoot`、`accountSyncDir`），接入 pocRoots 与 PoC 输入。profile 漏列某 scope 且对应目录含 ≥1 技能、有不可验证的跳过项、或不可读时，自动派生该根；缺失/空目录不派生。派生 id 为 `personal` / `project`，冲突加后缀。NESTED 不派生（依赖会话实际访问的子目录；未访问 = 已知无此来源）；ENTERPRISE 不派生（来自 managed-settings 目录）。全部 T008 适配器 fixture 显式声明 PERSONAL+PROJECT，派生对它们是 no-op；b16 声明 ACCOUNT_SYNC，synced 检查对它是 no-op。
- 契约见 ADR-021；PROJECT_BOOK §4.4 已更新。

**回归样本：** `tests/fixtures/regression/r1/r1-03b-claude-personal-omitted/`（profile 只列 PROJECT，个人技能在磁盘上 → FAIL，PERSONAL + PROJECT 两实例）+ 对照 `r1-03b-claude-personal-absent/`（无个人技能 → PASS）。

**复现前后：** 见上表 P1-R1-03 行（PASS → FAIL）。

## P1-R1-01 — OMB profile 增加显式字段，不缩范围（契约决策已定）

**根因：** CLI 硬编码 `dataDir: "./data"`、`botId: profile_id`、`env: {}`（`src/cli/audit.ts` 约 195–197 行），绕过了适配器的 `resolveDataDir`（显式 > OMB_DATA_DIR > `<home>/.openmausbot`）。

**改动：**

- `schemas/skillscope-profile-v1.json`：新增可选字符串字段 `bot_id`、`config_path`、`data_dir`、`snapshot_path`（minLength 1），附 FIX-R1 描述（minified canonical JSON，无尾换行；验证为合法 JSON，12 个属性，格式保留）。
- `src/cli/audit.ts`（完整重写相关部分）：头部 docstring 重写；fsutil import；新增 `EngineDetails` 接口与 `AuditRunResult.engineDetails?`；`resolveCodexConfig`、`resolveOmbInputs`、`ResolvedEngineInputs` 辅助函数；`runAdapter` 重写为接受 `ResolvedEngineInputs` 并返回 `{audit, engineDetails}`；`runAudit` 在策略校验后解析引擎输入（输入错误 → 退出码 3）。
- `src/cli/index.ts`：`printAuditSummary` 在实例之前打印 engineDetails（config/bot/data dir/snapshot 的路径与来源行）；`RESULT: <status>` 与 `Report:` 行不变。
- 规则：engine=openmausbot 时 `bot_id` 必填（缺失 → 退出码 3；profile_id 永不默默用作 bot id）。`data_dir` 显式值传给适配器；否则适配器按 OMB_DATA_DIR（CLI 现传 `env: process.env`，不再强制 `env: {}`）或 `<home_root>/.openmausbot` 解析。`snapshot_path` 显式值传给适配器；否则用存在或不可读的 `./snapshot.json`；缺失 → INCOMPLETE（ADR-007）。显式 `data_dir` / `snapshot_path` 指向缺失路径 → 退出码 3。
- Demo fixture 更新：`tests/fixtures/demo/openmausbot-incomplete/profile.json` 补显式 `data_dir: "./data"` 与 `bot_id: "bot-1"`（minified 排序键格式，无尾换行，保留）。

**回归样本：** `tests/fixtures/regression/r1/cli-omb-env-data-dir/`（profile 无 `data_dir`，OMB_DATA_DIR 指向 library-ON 配置，`bot_id: "real-bot-7"`，策略禁 SHARED_LIBRARY → CLI 经 `runAudit` 检出；原核实场景 p101 的 CLI 版）。

**核实对照（p101，冻结 dist CLI）：** profile `./data/config.json` library OFF；OMB_DATA_DIR 指向 library-ON 配置；profile_id `real-bot-7`；策略禁 SHARED_LIBRARY → CLI PASS，`expected_count: 0`，`observed_count: 1`，findings `[]`。修复后 `runAudit` 按 OMB_DATA_DIR 解析，检出违例（回归用例通过）。

## P1-R1-04 — Codex CLI 默认读真实用户配置（契约决策已定）

**根因：** CLI 只读 `<profileDir>/config.toml`，从不读 `~/.codex/config.toml`。

**改动：**

- `src/cli/audit.ts`：Codex 配置优先级：显式 `config_path` > `<profileDir>/config.toml` > `<home_root>/.codex/config.toml` > 缺失。存在或不可读的配置文件视为已找到（传给 PoC，由 PoC 失败关闭）；显式路径缺失 → 退出码 3。解析到的路径与来源打印在控制台摘要中（`EngineDetails`：configPath/configSource）。`bundled.json` / `plugins.json` 仍只读 profile 目录（`exists()`）。
- 已知措辞局限（超出范围）：`loadSnapshotFile` 把不可读与缺失混为同一 reason "missing"——状态仍为 INCOMPLETE，仅措辞不精确。
- Demo fixture 更新：`tests/fixtures/demo/codex-fail/` 有 profile 目录 config.toml（优先级 "profile"，不变）；`tests/fixtures/demo/claude-pass/profile.json` 显式声明 PERSONAL+PROJECT（派生为 no-op）。

**回归样本：** `tests/fixtures/regression/r1/cli-codex-home-config/`（无 profile 目录 config，`home_root/.codex/config.toml` 含禁用 deploy 的 selector → CLI 经 `runAudit` 使 deploy 不可用）+ 对照 `cli-codex-profile-config/`（profile 目录 config.toml 启用 deploy → ELIGIBLE）。

**核实对照（p104 vs p104c，冻结 dist）：** 同一 `[[skills.config]] name = "deploy" enabled = false` selector 放在 `home/.codex/config.toml` 时被忽略（技能 ELIGIBLE，PASS）；放在 profile 目录 config.toml 时生效（不可用；inventory_sha256 `fa57eb46…` vs `04508eb2…`）。修复后 home 配置生效（回归用例通过）。

## 对齐项 — PoC 与内核对禁 scope 的 DISCOVERED 实例处理分裂（ADR-023）

**根因：** PoC 对禁 scope 的 DISCOVERED 实例报 SCOPE_LEAK FAIL，内核按 ADR-006（有效集 = ELIGIBLE）丢弃后 PASS；同一输入两种结论。

**改动：** `src/adapters/claude/claude-poc.ts` 与 `src/adapters/openmausbot/openmausbot-poc.ts` 的行内策略比较由 ELIGIBLE-or-DISCOVERED 改为仅 ELIGIBLE，与内核一致；Oracle `_claude_shared_findings` 镜像。`tests/rules/resolver.test.ts` 中钉住旧分裂行为的测试已按新规则重写（重命名为 “… (PoC and kernel agree, ADR-023)”：PoC 不得含 SCOPE_LEAK；实例仍为 2（release ELIGIBLE、every-docs DISCOVERED）；内核断言不变（PASS、effectiveCount 1、expectedCount 1））。这是行为变更，不是严重度调整。相邻测试 “without a policy the kernel emits no policy findings” 不变通过（c07 实例为 ELIGIBLE，PoC 仍标记，内核仍剥离重算）。

**复现对照：** 见上表 P0-R1-04 嵌套行（内核 PASS → FAIL）。

## 回归套件

- **位置：** `tests/fixtures/regression/r1/`（20 个 fixture 目录，64 个文件）+ `tests/regression/r1-fix.test.ts`（22 测试）+ `tests/regression/r1-driver.mjs`（nobody 驱动）。
- **fixture 来源：** 由核实方复现树 `~/workspace/r1-verification/repro/`（r101/r102/r102a/r102b/r103/r104/r104c/p101/p103/p104）复制改编；核实方原件未改动。OMB 配置已迁为嵌套 features，`r1-04-omb-top-level` 故意保留顶层配置作对照；`r1-03-claude-synced-absent` = r103 去掉 synced/；`r1-04-omb-features-nonboolean` / `-nonobject` = r104 改写配置；`r1-02b-omb-optout-missing` = r102b 去掉 opt-out 文件；`r1-03b-claude-personal-absent` = p103 去掉个人技能；`r1-02-claude-container-dir` 手工搭建（PERSONAL 根含空 `synced/` 容器 + 可读技能）；`cli-omb-env-data-dir` profile 补 `bot_id: "real-bot-7"` + `env-data/config.json`（嵌套，library ON）；`cli-codex-profile-config` 补 profile 目录 config.toml（启用 deploy）。
- **权限用例机制：** git 无法跟踪 000 权限，故每个权限 fixture 配 `deny.json` 声明测试时 chmod 000 的路径（5 个 deny.json 文件）；测试把树复制到世界可读暂存目录后 chmod，再以 nobody 身份经驱动脚本运行。
- **测试分布：** 6 个 nobody 权限用例（r1-01、r1-02、r1-03-unreadable、r1-02a、r1-02b + 对照）+ 12 个进程内用例 + 4 个 CLI 契约用例（`runAudit`）。
- **Oracle 回归：** `oracle/tests/test_reference_resolver.py` 新增 `TestFixR1Oracle`（11 测试：嵌套 features 生效、顶层被忽略、非布尔/非对象 features INCOMPLETE、不可读 config/opt-out（mocked PermissionError）、不可读 SKILL.md（mocked read_text）、不可读 Codex 技能目录（mocked scandir）、synced 未声明/缺失、DISCOVERED 不泄漏对齐）。mock 明确标注：root 下无法产生真实 EACCES，Python 测试亦然。
- **新增单元测试（回归套件之外）：** `tests/rules/resolver.test.ts` +2（discoveryFindings 转换）；`tests/codex/codex-poc.test.ts` +1（tri-state 的 missing 分支）；`tests/fsutil/fsutil.test.ts`（新建，随 fsutil 模块）。

## S0 gate SHA 说明

修复后 gate SHA **未变**：`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`。任务书称“S0 gate SHA 变化是预期的、正确的”，是基于旧值未知的推断；实测不变是正确结果，原因：

1. OMB fixture 迁移只改结构不改开关值，48/48 判定输出不变；
2. S0 无不可读文件、无 DISCOVERED+禁策略组合、无 synced/ 目录、无非技能子目录；
3. 全部 S0 fixture 的 expected.json 开关值与判定均未变（parity 48/48，golden 48/48，检出 24/24，误报 0）。

S0 gate 仍硬编码 48 个 fixture（`scripts/s0-gate.mjs` 要求 `production.length === 48`），回归样本不进 S0。PROJECT_STATE.json 未改（gate SHA 未变）。

## 验收命令结果（全部真实运行，退出码 0）

2026-11-13 ~18:22–18:30 GMT，Node v24.22.1，npm 10.9.4，Python 3.12.3：

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm run typecheck` | 0 | `tsc --noEmit` 无错误 |
| `npm test` | 0 | 30 文件，**558/558 通过**（533 基线 + 22 回归 + 3 新增单元） |
| `npm run test:oracle` | 0 | 53/53 通过（42 原有 + 11 新增 TestFixR1Oracle），0.059s |
| `npm run s0:gate` | 0 | PASS；48 fixture（24 控制，24 植入）；parity 48/48；golden 48/48；检出 24/24；误报 0；incomplete sources 11（10 fixture）；100 次重放 1 哈希；gate_sha256 `a11d2a4c…` 不变 |
| `npm run test:e2e` | 0 | PASS — 28/28 检查通过 |
| `npm run test:offline` | 0 | offline-check: PASS — no account, no LLM, no network, no real skills needed |
| `npm run test:performance` | 0 | PASS；scan 中位数 312 ms（目标 ≤5000）；HTML 中位数 689 ms（目标 ≤2000）；峰值 RSS 82.3 MiB（目标 ≤300）；500/500 实例，hash 稳定 |
| `npm run verify:all` | 0 | PASS — 8/8 步骤通过；42 包 inventoried |
| 回归套件单跑 `npx vitest run tests/regression/r1-fix.test.ts` | 0 | 22/22 通过（~18:15 GMT；全量 `npm test` 亦含该文件） |
| 核实方驱动对新构建重跑 | 0 | 15 个场景全部输出（见 `repro-after.log`；逐项对照见上表） |

说明：一次 `npm test` 经管道测得退出码 1 是测量伪影（`PIPESTATUS` 经 `tail` 管道读取）；直接运行 `npm test > log` 与 `npx vitest run` 均退出 0，558/558。gate 运行会改写 `03_evidence/S0/` 的 3 个文件（仅 base_commit 标签变化），已按惯例 `git checkout -- 03_evidence/S0/` 恢复；T012 的 5 个证据文件（e2e.json、licenses.json、performance.json、verify-all.json、verify-all.log）为本次验收运行的再生输出（时间戳、负载、耗时、head_commit），随 FIX 一并提交。

## 文档与决策记录

- `01_spec/PROJECT_BOOK.md`：§4.3（失败即未知三态）、§4.4（synced/ 门禁、标准来源派生、不可读 SKILL.md）、§4.5（`features.*` 结构、EACCES 区分）、§5.1（跳过项转 finding）、§5.2（SOURCE_NOT_ENUMERATED 扩展、SCOPE_LEAK 仅 ELIGIBLE）、§6.1（新增可选字段）、§6.4（CLI 解析规则）、§9 与页眉/状态行许可证 MIT。
- `01_spec/IMPLEMENTATION_PLAN.md`：新增 §5.5 FIX-R1 节（逐项表、回归说明、SHA 说明、许可证、验收命令）；§0 规则 13 与 §T014 禁止修改中的许可证措辞同步为 MIT。
- `00_control/TASK_BOARD.csv`：新增 FIX-R1 行（S5，PASS；owner_commit 为输出 commit）。
- `00_control/DECISION_LOG.md`：新增 ADR-019（枚举失败即未知）、ADR-020（OMB 只读 `features`）、ADR-021（Claude 派生与 ACCOUNT_SYNC 门禁）、ADR-022（CLI 契约字段与真实默认路径）、ADR-023（DISCOVERED 不触发 SCOPE_LEAK）。
- T014_FREEZE_REPORT 不由 FIX 更新（另派 T014）。

## 环境说明（复现本报告时需要）

- Shell 以 root 运行；`chmod 000` 对 root 无效，权限复现必须以无特权用户 `nobody`（uid 65534）经 `runuser -u nobody -- node …` 运行（核实方既定模式）。
- 本 VM 的权限模型（实测）：nobody **不能**读 2770 组权限目录（overlay fs 上组权限不生效）、**不能**读 `/tmp` 下任何内容（tmpfs 以 `uid=131072,gid=131072` 挂载，即使 755/644 也失败）、**能**读 `/home/hatch` 下世界可读（other r-x/r--）路径。后果：nobody 运行的暂存必须在 `~/workspace` 下，目录 755、文件 644，绝不在 `/tmp`、绝不在 2770 仓库树内。
- 仓库树模式为 2770 目录 / 660 文件；`cpSync` 保留模式，任何为 nobody 暂存的副本必须把模式归一化为 755/644（含根目录本身、文件、以及 `cpSync` 创建的 `node_modules` 父目录）。Node 对不可读的暂存文件报 ERR_MODULE_NOT_FOUND。
- `dist/` 约 304K；暂存副本需 `node_modules/smol-toml`（172K，零依赖）与 `node_modules/yaml`（1.3M，零依赖），因 dist 裸 import 它们（codex-poc.js → smol-toml；adapters → `manifest.js` → yaml）。
- EPERM 存储抖动自 ~2026-11-11 持续：每次写文件后验证大小 + sha256，失败重试；git 遇 index.lock 报错时重试。
- 3130 隧道代理故障 #6 已于 ~18:01 GMT 结束（WorkBuddy 恢复），但本 FIX 全程只用本机工具，未依赖任何远程模型路由。

## 已知局限

1. `loadSnapshotFile` 把不可读与缺失的 snapshot 混为同一 reason "missing"——状态仍为 INCOMPLETE，仅措辞不精确；超出 R1 范围，未修。
2. Oracle 回归的 EACCES 分支用 mocked PermissionError（root 下无法产生真实 EACCES，Python 测试亦然）；真实权限行为由 TS 侧 nobody 驱动覆盖。
3. `tests/regression/r1-fix.test.ts` 的 CLI 用例在进程内调 `runAudit`（未走真实 CLI 子进程）；真实 CLI 子进程行为由 `tests/cli/cli.test.ts` 覆盖（demo 三态 1/0/2）。
4. OMB 实例的 logicalName 取 snapshot 名（如 `shared-skill`），而非 frontmatter 名（如 `test-skill`）；Codex/Claude 实例取 frontmatter 名。这是既有行为，回归断言已按此写，未改。
5. 本 FIX 不更新 T014_FREEZE_REPORT（另派 T014）；新冻结后 source.zip / dist.zip 的 SHA 将变化，R2 终审包需用新冻结产物。
6. P2-R1-13 不列为修复项（核实 FALSE）；其余 16 项 P2 非阻断，按原登记处理。

## 交付文件清单

- 修复代码：`src/fsutil/index.ts`（新建）、`src/adapters/codex/codex-poc.ts`、`src/adapters/claude/claude-poc.ts`、`src/adapters/claude/adapter.ts`、`src/adapters/openmausbot/openmausbot-poc.ts`、`src/adapters/shared/skill-scan.ts`、`src/discovery/discovery.ts`、`src/resolver/index.ts`、`src/cli/audit.ts`、`src/cli/index.ts`、`schemas/skillscope-profile-v1.json`、`oracle/python/reference_resolver.py`、`LICENSE`（新建，MIT）。
- 回归：`tests/fixtures/regression/r1/`（20 目录，64 文件）、`tests/regression/r1-fix.test.ts`、`tests/regression/r1-driver.mjs`、`tests/fsutil/fsutil.test.ts`（新建）、`oracle/tests/test_reference_resolver.py`（+11 测试）、`tests/rules/resolver.test.ts`（+2）、`tests/codex/codex-poc.test.ts`（+1）。
- Fixture 迁移：S0 15 个 + T007 15 个 + demo 1 个 OMB config.json（顶层 → 嵌套 `features`，值不变）+ demo profile 更新（OMB `bot_id`/`data_dir`；Claude 显式 PERSONAL+PROJECT）+ `tests/openmausbot/openmausbot-poc.test.ts` scratch 配置。
- 文档：`01_spec/PROJECT_BOOK.md`、`01_spec/IMPLEMENTATION_PLAN.md`、`00_control/DECISION_LOG.md`（ADR-019–023）、`00_control/TASK_BOARD.csv`（FIX-R1 行）。
- 本报告：`03_evidence/FIX-R1/FIX_R1_REPORT.md`；复现后输出：`03_evidence/FIX-R1/repro-after.log`（367 行）。
- 再生证据（随 FIX 提交）：`03_evidence/T012/e2e.json`、`licenses.json`、`performance.json`、`verify-all.json`、`verify-all.log`。
