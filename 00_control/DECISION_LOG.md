# DECISION_LOG.md — P023 SkillScope

## ADR-001：源码树置于仓库根（2026-11-13，T001）

- 决定：`src/`、`oracle/`、`tests/`、`scripts/`、`docs/` 置于仓库根；实施计划 §10 的 `02_source/` 嵌套布局不采用，空目录 `02_source/` 已删除。
- 原因：实施计划 §3.3 冻结的 npm scripts 使用根相对路径（`node ./scripts/s0-gate.mjs`、`vitest run tests/codex` 等）；嵌套进 `02_source/` 会使脚本路径与 §3.3 冲突。§3.3 为冻结合同，§10 为布局示意，前者优先。
- 影响：`00_control/`、`01_spec/`、`03_evidence/`、`04_review/`、`05_release/` 仍按 §10 承担控制 / 规格 / 证据 / 审查 / 发布角色。

## ADR-002：测试框架选用 Vitest（2026-11-13，T001）

- 决定：采用 Vitest 5.1.0（`npm test` = `vitest run`），与 §3.3 默认脚本形式一致。
- 原因：npm registry 可达（实测），Vitest 可正常安装；无需改写 §3.3 的 `vitest run tests/<dir>` 形式。
- 备选：Node 内置 test runner；仅当 Vitest 在后续任务中无法运行时才切换，切换须另立 ADR，不得静默改脚本名。

## 版本锁定（2026-11-13，T001）

- typescript 5.9.3（规格要求 5.x；registry 最新 7.0.2 未采用）。
- vitest 5.1.0。
- @types/node 24.19.2（与 Node v24.22.1 运行时对应）。
- 运行时依赖：smol-toml 1.9.1（ADR-003）+ yaml 2.9.1（ADR-004）；仅 Node 标准库 + Python 标准库之外两者。
- 不使用 latest / 浮动依赖；后续任务不得擅自升级主版本。

## ADR-003：TOML 解析依赖选用 smol-toml（2026-11-13，T002）

- 决定：采用 smol-toml 1.9.1（精确版本，BSD-3-Clause，零依赖，integrity 已锁定入 lockfile），关闭 OPEN-001。
- 原因：Node 24.22.1 标准库无 TOML 解析器；Codex `config.toml`（skills.config、`[skills.bundled]`）解析需要它。
- 影响：package.json / package-lock.json 新增该依赖；无 license 字段改动。

## ADR-004：YAML 解析依赖选用 yaml（2026-11-13，T005）

- 决定：采用 yaml 2.9.1（精确版本，ISC，零依赖，integrity 已锁定入 lockfile），关闭 OPEN-002。
- 原因：Node 24.22.1 标准库无 YAML 解析器；SKILL.md frontmatter 完整解析（PROJECT_BOOK §1.4：name / description 必填、name 格式与保留词、重复键拒绝）需要它。实测：重复键报错（linePos 精确到行列）、时间戳标量保持字符串、嵌套映射 / 数字 / 布尔正常。
- 影响：package.json / package-lock.json 新增该依赖；`src/manifest/manifest.ts` 为唯一使用方；T001 的“运行时依赖：无”记录更新为 smol-toml 1.9.1 + yaml 2.9.1（均精确版本、零依赖）。

## ADR-005：内核拥有策略比较，PoC 的行内 SCOPE_LEAK 不继承（2026-11-13，T006）

- 决定：src/resolver 剥离三个 PoC 的行内 SCOPE_LEAK 判定，统一由 src/policy 重算；调用方必须把 profile policy 传给内核，无 policy 参数时内核不产生任何策略 Finding（c07 实测：无 policy → PASS）。
- 原因：三份行内实现语义不一致（见 ADR-006），且 Codex PoC 根本没有 policy 输入；单一策略源是 T009/T013 可消费同一 AuditResult 的前提。
- 影响：T009 必须加载 profile policy 并透传；否则漏报泄漏。已在 RULE_ENGINE_REPORT.json 与 resolver 测试中写明。

## ADR-006：策略有效集 = ELIGIBLE（2026-11-13，T006）

- 决定：策略比较只看 ELIGIBLE 实例。DISCOVERED（宿主 flag 关掉、未加载，如 OpenMausBot skillsLibrary/claudeUserSkills off）不产生 SCOPE_LEAK / DISABLE_MISMATCH。
- 原因：DISCOVERED 的技能宿主不会加载，报泄漏是误报——正是 SkillScope 要消除的错误类别。S0 夹具未裁决此问题（o09 无 policy），故由内核定义并记录。
- 影响：与 Claude/OpenMausBot PoC 的行内判定不同（它们把 DISCOVERED 计入有效集）；o09 + forbiddenScopes [SHARED_LIBRARY] 实测：PoC 报 SCOPE_LEAK，内核不报、PASS。S0 gate 不受影响（gate 直接调 PoC，不经过内核）。

## ADR-007：完整适配器要求版本化 snapshot，缺失按未枚举处理（2026-11-13，T007）

- 决定：`auditOpenMausBot` 中无 snapshot、snapshot 文件缺失/非 JSON/形状非法 → INCOMPLETE（SOURCE_NOT_ENUMERATED，unknownScopes `[SNAPSHOT]`）。未知版本仍走 PoC 的版本门（同样 INCOMPLETE）。
- 原因：PoC 把缺失 snapshot 当空清单（S0 夹具需要这一默认），完整适配器不能继承——没有清单就无法证明清单完整。`emptyLists` 用于显式声明某 per-bot 清单为空；缺席≠空。
- 影响：T009 调适配器时必须提供 snapshot（inline 或 snapshotPath），否则审计恒为 INCOMPLETE；S0 gate 不受影响（gate 直接调 PoC）。

## ADR-008：无 pluginId 的插件技能是 UNKNOWN / INCOMPLETE（2026-11-13，T007）

- 决定：snapshot 中 kind 为 plugin 但无 `pluginId` 的技能，实例状态改为 UNKNOWN，并报 SOURCE_NOT_ENUMERATED（P1，sourceScope PLUGIN），审计 INCOMPLETE。
- 原因：`disabledPluginIds` 永远覆盖不了它（#5449 item 8 的核心问题）；静默当作可开关会在无 policy 时悄悄 PASS。UNKNOWN 使其退出有效集（ADR-006），失败关闭为 INCOMPLETE 而非泄漏。
- 影响：T009/T013 遇到此类技能时看到的是 INCOMPLETE 而不是 PASS；修复方式是补 snapshot 的 pluginId，不是改适配器。

## ADR-009：不可读的 settings 层按层名报 UNKNOWN scope（2026-11-13，T008）

- 决定：某层 settings 文件存在但不可读 / 非 JSON / 形状非法 → 该层的影响无法确定 → INCOMPLETE，unknownScopes 为按层名的 scope（MANAGED_SETTINGS / USER_SETTINGS / PROJECT_SETTINGS / LOCAL_SETTINGS）。缺失的层文件不是错误。用户层文件不可读时尤其关键：它可能覆盖项目层的禁用，读不到就无法证明有效集。反之，用户层可读的禁用是确定性的：被禁用的实例改为 DISABLED，并记入 `diagnostics.overriddenByUser`，不是 INCOMPLETE。
- 原因：settings 层是有效集的输入；某一层未知 = 有效集未知。按层名区分 scope 让 INCOMPLETE 的原因可定位。
- 影响：T009 调适配器时必须提供可读的 settings 层（或接受 INCOMPLETE）；S0 gate 不受影响（gate 直接调 PoC，不经过适配器）。

## ADR-010：插件禁用读 enabledPlugins，不用 disabledPlugins（2026-11-13，T008）

- 决定：适配器读官方文档的 `enabledPlugins`（`"plugin@marketplace": boolean`，`false` 禁用；裸插件名匹配全部 marketplace）与 `skillOverrides`（name → `"off"`）。`disabledPlugins` 不是 Claude Code 的文档键，不读。只有 managed 层的 `strictKnownMarketplaces` 生效；此时未注册的额外 plugin 目录被宿主拒绝 → 其技能为 DISCOVERED，不产生 DISABLE_MISMATCH。
- 原因：按官方文档的键名，避免凭空发明 settings 键；`disableSideloadFlags` / `prependPlugins` / `appendPlugins` / `pluginConfigs` 已记入 `claude-rules.json` 的 `known_but_not_enforced`，本任务不执行。
- 影响：T009/T013 遇到插件禁用问题时以 `enabledPlugins` 为准；strict 模式下的额外目录技能在报告里是 DISCOVERED，不是 ELIGIBLE。

## T006：npm 脚本 test:rules（2026-11-13，T006）

- package.json 增加 `"test:rules": "vitest run tests/rules"`，沿用 T001/T005 向 §3.3 之外加 test:identity / test:symlink / test:manifest 的先例；无依赖与 license 字段改动。

## ADR-011：Canonical JSON 规则（2026-11-13，T008b）

- 决定：规范 JSON 为 UTF-8、LF、无空白分隔符（`,` / `:`）；对象键按 Unicode 码点序排列（不是 UTF-16 码元序，与 Python `sort_keys=True` 一致，星号平面键也不例外）；数组序保留；全部字符串（键与值）NFC 归一化；`-0` 序列化为 `0`；非有限数、undefined、函数、symbol、bigint、Date/Map/Set/类实例、循环结构一律抛错，不静默转换。
- 原因：报告与 snapshot 的哈希必须跨机器、跨时间可复现；码点序让 TS 实现与独立 Python Oracle 的 canonical 形式逐字符一致（15 个冻结向量三方对照通过）。拒绝非 JSON 值，避免不可 JSON 往返的值悄悄获得哈希。
- 影响：T009 写 JSON 报告必须经 `canonicalizeJson` / `writeJsonFile`；哈希输入含绝对路径、时钟、UUID、PID 时须先经 `redactReport` 脱敏，否则哈希不可移植。

## ADR-012：报告脱敏规则（2026-11-13，T008b）

- 决定：敏感键按展平键名判定（小写、去 `-_ ` 后）：等于 KEY / AUTH / PWD / PASS / TOKEN / SECRET，或包含 TOKEN / SECRET / PASSWORD / PASSWD / CREDENTIAL / COOKIE / AUTHORIZATION / PRIVATEKEY / APIKEY / SESSIONID / BEARER，或以 ACCESSKEY / AUTHKEY / APIKEY / PRIVATEKEY / SECRETKEY / PUBLICKEY 结尾——值替换为 `[REDACTED]`。`author` 不是敏感键（`auth` 只做精确匹配）。密钥形值（sk-…、GitHub PAT、AKIA…、Google API key、Slack token、JWT、PEM 私钥、`Bearer …`、`password=…` 赋值）即使在普通键下也替换。绝对路径：已知根（home → `<HOME>`、cwd → `<CWD>`、扫描根 → `<ROOT>`，最长优先）替换，其余已知文件系统根 / Windows 盘符 / UNC → `<ABS_PATH>`；相对路径与 URL 不动。调用方传入的用户名 → `<USER>`。
- 原因：PROJECT_BOOK §9 / §7.4 要求报告默认可分享；键名判定必须覆盖 camelCase / snake_case / kebab-case 三种写法，又不能把 `author`、`monkey` 这类词误杀。
- 影响：T009 写报告前必须调 `redactReport`；扫描只认 `SECRET_PATTERNS` 中的已知模式，未知格式密钥不在保证内（证据脚本 PII 扫描有记录）。

## T008b：npm 脚本 test:io / test:privacy / test:hash（2026-11-13，T008b）

- package.json 增加 `"test:io": "vitest run tests/io"`、`"test:privacy": "vitest run tests/privacy"`、`"test:hash": "vitest run tests/hash"`，沿用 T001/T005/T006 向 §3.3 之外加脚本的先例；无依赖与 license 字段改动（零新增依赖，全部用 Node 内置模块）。

## ADR-013：CLI 报告哈希与 profile→适配器映射约定（2026-11-13，T009）

- 决定：inventory_sha256 = canonicalSha256(audit.instances)；audit_sha256 = canonicalSha256（audit_sha256 字段为 null 的报告其余部分——报告不能哈希自身）；oracle_result_sha256 = null（CLI 从不运行 Python Oracle，null 是诚实值）；observed_count 在 INCOMPLETE 时为 null（§6.3 schema 原文）。报告先经 `redactReport` 再哈希、写盘，并过 frozen schema 校验；HTML 内嵌的 canonical ReportV1 JSON 与 JSON 报告文件逐值相等。
- 决定：全部 profile 路径相对 profile 文件所在目录解析。codex：cwd/repo_root/home_root 取自 profile；ADMIN 根取 ADMIN source root 路径的 dirname（该路径命名 skills 目录，如 `./admin/skills`），无 ADMIN 根时默认 `<profileDir>/admin`；config.toml / bundled.json / plugins.json 在 profile 目录存在时读取、不存在时缺席（SYSTEM/PLUGIN 按 PoC 规则报 unknown，绝不静默当空）。claude：profile source_roots 直通完整适配器（fixtureDir = profile 目录），settings 层按 home_root / repo_root 默认解析。openmausbot：dataDir `./data`、snapshot `./snapshot.json`（缺席即 INCOMPLETE，ADR-007），botId = profile_id，env 强制 `{}`（调用方真实 OMB_DATA_DIR 绝不参与），scan roots 取 profile 的 BOT_ASSIGNED / SHARED_LIBRARY / IMPORTED 根。
- 决定：`verify --fixtures s0` 委托冻结的 `scripts/s0-gate.mjs`，不另写一份 gate（避免第二份实现漂移）。`--engine/--cwd` 形式读 `<cwd>/skillscope.json`，无 profile 时退出 3 并提示先 `init`；CLI 从不猜测宿主根目录。`--ci` 属于 T010，本任务拒绝。
- 原因：报告哈希必须可从共享产物重算（先脱敏再哈希）；profile schema 是冻结的、没有宿主专属字段（OMB dataDir/snapshot、codex config/bundled/plugins），映射约定必须显式冻结在 ADR 而不是藏在代码里；verify 的权威是 gate 脚本本身。
- 影响：T010 的 CI 模式复用同一 audit 入口与退出码；T013 复核 ADR-013 的约定与实现是否一致；OPEN-003 备注：T009 演示已用 Playwright 缓存的 headless Chromium（chromium_headless_shell-1254）真实生成 1280×1100 截图，证明 headless 浏览器可运行——完整浏览器 E2E 仍由 T012 决定，OPEN-003 不在本任务关闭。

## T009：npm 脚本 test:cli / demo 与 bin（2026-11-13，T009）

- package.json 增加 `"bin": {"skillscope": "dist/cli/index.js"}`、`"test:cli": "vitest run tests/cli"`、`"demo": "node ./scripts/demo.mjs"`，沿用 T001/T005/T006/T008b 向 §3.3 之外加脚本的先例；无依赖与 license 字段改动（零新增依赖，全部用 Node 内置模块）。

## ADR-014：`--ci` 模式语义与离线检查（2026-11-13，T010）

- 决定：`--ci` 为 `audit` 专用的布尔标志（不取值）；CI 模式抑制多行 §0.1 控制台摘要，stdout 恰好一行机读输出 `skillscope: RESULT=<STATUS|ERROR> exit=<code>[ report=<path>]`，报告文件照常写盘，退出码不变（0 PASS / 1 FAIL / 2 INCOMPLETE / 3 输入错误 / 4 内部错误）。INCOMPLETE 在 CI 模式下仍为 2，绝不弱化为 0。`RESULT=` 一词只在报告成功写盘时取审计状态；写盘失败（exit 4）时印 `RESULT=ERROR`，审计本身 PASS 也如此——CI 解析器绝不能从一个退出 4 的运行读到 `RESULT=PASS`。`--ci` 用于 `init` / `verify` 时为输入错误（exit 3）。
- 决定：离线检查（`npm run test:offline`，`scripts/offline-check.mjs`）四重独立验证：静态扫描 `src/`、`scripts/*.mjs`、`dist/` 的网络调用点与 `dist/` 的 `https://` 字符串；死代理（127.0.0.1:9）下三演示审计仍返回冻结退出码 1/0/2；产出报告零 URL 且 HTML 外部资源 0 命中；`README.md`、`docs/`、`.github/workflows/` 零 `https://` 字符串。扫描排除检查脚本自身——其模式列表本身含有 `axios`、`undici`、`XMLHttpRequest` 字面词。
- 原因：CI 信号必须是退出码与一行可解析输出，而不是多行人类摘要；INCOMPLETE 弱化为 0 会让漏枚举的流水线悄悄变绿；离线是产品承诺（无账号、无 LLM、无网络），必须由测试证明而不是文档宣称。
- 影响：T011 起的回归测试沿用同一退出码合同；T013 复核 ADR-014 与实现是否一致；README 的退出码表与本 ADR 一致。

## T010：npm 脚本 test:ci（2026-11-13，T010）

- package.json 增加 `"test:ci": "vitest run tests/ci"`，沿用 T001/T005/T006/T008b/T009 向 §3.3 之外加脚本的先例；无依赖与 license 字段改动（零新增依赖）。`test:offline` 脚本（`node ./scripts/offline-check.mjs`）在 T001 时已写入 package.json，本任务交付其实现文件。
- T009 测试的 1 行改动：`tests/cli/cli.test.ts` 曾断言 `audit … --ci` 退出 3（T009 时 `--ci` 明确属于 T010 且被拒绝）；T010 实现 `--ci` 后改为断言退出 1，并补显式 `--out` 到临时目录（无 `--out` 时默认报告路径落在夹具树内——该问题在全量测试中真实出现并修复）与未知选项仍退出 3 的断言。其余测试未动。

## ADR-015：Canonical JSON 键按 NFC 形式排序（2026-11-13，T011）

- 决定：`canonicalizeJson` 先把对象键 NFC 规范化，再按码点排序（原为先排序后 NFC）；两个不同原始键 NFC 碰撞为同一键时 fail-closed 抛 `TypeError`，不静默丢弃其一。
- 原因：T011 性质测试发现原实现不是不动点——分解键 `"e"+U+0301` 首码点 U+0065 排在 `n` 之前，其 NFC 形式 `"é"`（U+00E9）应排在之后；`canonicalizeJson(JSON.parse(canonicalizeJson(v))) !== canonicalizeJson(v)`，且两种拼写哈希不同，违背 ADR-011 的"等价拼写同哈希"。独立 Oracle（`oracle/python/canonical.py`）本就是先 NFC 再排序，原实现与之分歧（S0 夹具全 ASCII，故 gate 未触及）。
- 影响：冻结 hash 向量（含 astral 键向量）全部仍通过；S0 gate 哈希不变；T012 回放沿用此规则；T013 复核本 ADR 与实现是否一致。唯一有意分歧：NFC 碰撞键输入上 Oracle 静默取后者，生产抛错（现实输入无碰撞键）。

## ADR-016：T011 三层回归约定（2026-11-13，T011）

- 决定：回归分三层，各司其职——（1）golden：kernel vs 冻结 S0 golden 全字段比较（48 夹具；`canonicalPath`/`extra` 是 PoC 层字段，由 gate 比较；策略 finding 的 detail 措辞不逐字比较，另断言非空且点名违规实例）+ 现场 spawn Oracle 的 parity + 13 个手工推导 extended 用例（期望值手算，绝不由 resolver 生成）；（2）property：10 条性质，mulberry32 + FNV-1a，默认冻结 seed，可 `--seed` 覆盖；`vitest` 无 `--seed` 选项，故 `test:property` 走 `scripts/property-test.mjs` 包装器（经 `SKILLSCOPE_PROPERTY_SEED` 传入）；（3）mutation：20 个手工变异、8 类，先跑 control 再逐个作用于临时副本（node_modules 符号链接），score = killed / (total − equivalent)，目标 ≥95%。
- 原因：单层测试只能证明"当前实现与当前期望一致"；三层分别钉住"与独立 Oracle 一致"、"对随机输入满足规格"与"测试本身能杀死规则级改动"。
- 影响：T012 沿用三层（E2E 不得绕过 golden/property/mutation）；变异存活即测试缺口，每个存活变异单独开 FIX 任务，不得调 golden 迎合实现；T013 复核三层与实现是否一致。

## T011：npm 脚本 test:property / test:mutation（2026-11-13，T011）

- package.json 增加 `"test:mutation": "node ./scripts/mutation-test.mjs"`；`"test:property"` 由 `"vitest run tests/property"` 改为 `"node ./scripts/property-test.mjs"`（解析 `--seed`；裸跑仍用冻结 seed），沿用 T001/T005/T006/T008b/T009/T010 向 §3.3 之外加脚本的先例；无依赖改动（零新增依赖，全部用 Node 内置模块）。

## ADR-017：E2E 不用浏览器驱动产品，headless Chromium 只做 HTML 渲染截图（2026-11-13，T012）

- 决定：产品是 CLI + 静态 HTML 输出，没有浏览器界面，故不存在“浏览器驱动产品”的 E2E。E2E 断言全部在文件级完成（真实 CLI 进程、JSON schema、内嵌 JSON 逐字节比对、外部资源扫描、夹具树哈希前后比对）；本地缓存的 headless Chromium（`~/.cache/ms-playwright`）只用来渲染截图 HTML 报告；缓存不存在时截图跳过（记 skipped，不失败），测试过程永不下载浏览器或外部依赖。
- 原因：T001 留下的 OPEN-003 问的是“E2E 浏览器来源待定”——系统 PATH 无浏览器，只有 Playwright 缓存。浏览器驱动只对有界面的产品有意义；对静态 HTML 输出，文件级断言比浏览器驱动更强（逐字节相等），截图只是渲染能力的辅助证据。
- 影响：OPEN-003 关闭；T013 复核本 ADR 与 e2e.mjs 实现是否一致；README 不得宣称产品经过“浏览器 E2E”。

## ADR-018：T014 冻结以 manifest 钉住冻结 commit，release/ 提交进 git（2026-11-13，T014）

- 决定：冻结 commit 由 release/RELEASE_MANIFEST.json 的 `frozen_commit` 钉住——首次构建钉住当时 HEAD，之后重跑 release:build 始终重冻同一 commit，产物字节相同；删除 release/ 才对当前 HEAD 做一次新冻结。钉住的原因是 release/ 本身要提交进 git（P022 先例：release/ 含 source.zip、dist.zip、SHA256SUMS.txt、RELEASE_MANIFEST.json、T014_FREEZE_REPORT.md 全部入 git），若 build 每次取 HEAD，release 提交后重跑 `git archive` 会把旧 release/ 吞进 source.zip 造成循环打包。
- source.zip = `git archive --format=zip --prefix=skillscope/ <frozen>` 的完整树（含 03_evidence/ 全部证据与环境报告——P022 先例与 T012 预演一致；证据里的构建机绝对路径是来源记录，不是产品输出，产品审计报告本身仍按 ADR-012 脱敏）；dist.zip = 确定性 STORE zip（1980-01-01 固定时间戳、按路径排序、无压缩），含 package.json、package-lock.json、README.md 与整个 dist/，解压后 `npm ci` 即可运行；manifest 不含墙上时钟时间（时间戳取冻结 commit 的 committer date），故重跑产物字节相同。
- 首次构建即抓到真实打包缺陷（打包脚本自查，非业务源码问题）：dist.zip 初版只含 package 文件 + dist/，烟囱审计报 ENOENT——CLI 在运行时经 REPO_ROOT 读 schema（src/io/index.ts loadSchema，REPO_ROOT 为 dist/io/ 上两级），而 tsc 不把 .json 拷进 dist/。修复为 dist.zip 另含整个 schemas/ 目录与 src/adapters/openmausbot/openmausbot-snapshot-v1.json（OpenMausBot 快照 schema 同样经 loadSchema 加载），只改打包脚本，不动业务源码（T014 失败回退允许的范围）。
- 交付物位置按 T014 验收命令为准：`release/`（source.zip、dist.zip、SHA256SUMS.txt、RELEASE_MANIFEST.json、RELEASE_FILE_LIST.csv），冻结报告在 03_evidence/T014/T014_FREEZE_REPORT.md；计划 §10 布局草图里的 `05_release/` 只是空占位目录，不用。
- 影响：T013 的 P2-T013-08 关闭（release:build / release:verify 脚本由 T014 交付）；冻结后工作树 clean 靠“release/ + 冻结报告一起提交”达成。

## T012：verify:all 与发布预演（2026-11-13，T012）

- 新增 npm 脚本实现（package.json 脚本名在 T001 时已冻结，本任务交付实现文件；零新增依赖）：`test:e2e`（scripts/e2e.mjs）、`test:performance`（scripts/performance.mjs + perf-fixture.mjs）、`verify:all`（scripts/verify-all.mjs，8 步聚合 + 许可证清单）。`test:offline` 的实现（scripts/offline-check.mjs）为 T010 交付，本任务新增 vitest 离线测试（tests/offline/）作为 `npm test` 内的一层。
- 性能基线（本 VM 实测，§10.3 目标全部达成，无需 ADR 调整）：500 实例扫描中位数 208 ms（目标 ≤5,000）、HTML 中位数 302 ms（目标 ≤2,000）、峰值 RSS 81.9 MiB（目标 ≤300）；见 03_evidence/T012/performance.json。
- 许可证清单（实查 lockfile + 各包 package.json）：已安装 42 包（MIT / Apache-2.0 / BSD-3-Clause / ISC / MPL-2.0）；30 个 lockfile 包未安装，全部为 `optional: true` 平台专属包（npm 在 linux x64 正确跳过），单列记录，不算缺失；产品 LICENSE 仍 PENDING_SAM_DECISION。
- 发布预演发现真实问题并修复（commit 495890d）：`git archive` 丢空目录，致打包树丢失 23 个空 skills 目录，干净目录烟囱审计退出 2（INCOMPLETE）而仓库内退出 1（FAIL）。修复为 23 个空 skills 目录加 `.gitkeep` 占位；PoC 与 Oracle 只认含 SKILL.md 的目录，审计结果零变化（S0 gate 哈希不变、codex-fail audit_sha256 不变）。预演脚本新增检查：每个被跟踪的 `.gitkeep` 所在目录必须在解出的干净树里存在。预演产物只在 03_evidence/T012/rehearsal/，不写 release/；T014 从冻结 commit 重做。
- TypeScript 说明：NodeNext 下 `.mjs` 的声明文件须为 `.d.mts`（`.d.ts` 不被识别，TS7016），故新增 scripts/perf-fixture.d.mts。

## ADR-019：枚举失败即未知，不得转为空集合（2026-11-13，FIX-R1，P0-R1-01 / P0-R1-02 / P1-R1-02）

- 决定：任何来源的枚举结果是三态——`ok`（已枚举）、`missing`（路径不存在或不是目录，已知无此来源）、`unreadable`（存在但因权限或 I/O 错误无法读取）。`unreadable` 必须进入 unknownSources 并使审计 INCOMPLETE；绝不能把读取失败转换为空集合后 PASS。同一来源内已读到的技能仍保留，但来源整体标记未知。
- 实现：新增共享模块 `src/fsutil/index.ts`（`classifyPath` / `classifyError`，stat 一次：ENOENT/ENOTDIR → missing，EACCES/EPERM → unreadable，其他错误 fail-closed 判 unreadable）与 `isContentUnknownSkip(reason, code)`（SKILL_MD_TOO_LARGE 恒为未知；SKILL_MD_UNREADABLE / DIR_UNREADABLE 仅当 code 存在且 ≠ ENOENT 时为未知）。`SkippedEntry` 增可选 `code` 字段（errno）；现有 reason 字符串不变（symlink 测试与 identity-evidence 脚本钉住 SKILL_MD_UNREADABLE）。
- 适用范围：Codex `scanSkillsDir` 三态（REPO / USER / ADMIN）；Claude PoC 的不可读 SKILL.md；OMB 配置与 opt-out 的 stat 区分（existsSync 无法区分 EACCES 与 ENOENT，见 P1-R1-02）；`discoveryFindings` 将内容未知的跳过项转为 SOURCE_NOT_ENUMERATED（P1/UNKNOWN），ROOT_MISSING_OR_UNREADABLE 不重复转（已通过 coverage 上报），ENOENT SKILL.md 不转（子目录不是技能）。
- 边界：ENOENT 的 SKILL.md 读失败表示“子目录不是技能”（如 Claude 的 `synced/` 容器目录），只记录不转 finding；`scanSkillRoot` 的 ROOT catch 必须同样记录 errno，否则缺失的 synced/ 目录会被误判为不可读（FIX 期间实测抓到的回归，已修）。

## ADR-020：OpenMausBot 功能开关只读 `features` 对象（2026-11-13，FIX-R1，P0-R1-04）

- 决定：只解析 `config.json` 的 `features.skillsLibrary` 与 `features.claudeUserSkills`；顶层同名键一律忽略。`features` 缺失时两开关均为默认关闭；`features` 不是对象、或开关值不是布尔值时，配置无效（FAIL_OPEN_CONFIG + INCOMPLETE）。依据：官方 docs/feature-flags.md（main 分支，2026-11-13 核实）——“The server stores these options under `features` in its `config.json`”，两开关均标注 “Key under `features`”，默认 Off。
- 影响：Python Oracle 同步修正（同一错误假设）；S0 的 15 个 OMB config.json、T007 的 15 个、demo 的 1 个，共 30 个文件由顶层迁为嵌套结构，开关布尔值逐个核对不变，故 expected.json 无需改动；S0 gate SHA 实测不变（`a11d2a4c…`）。旧版“顶层读 flags”是错误假设，不是兼容行为——顶层-only 配置读作默认关闭。
- 关联：opt-out 不可读时实例仍按宿主语义保持 ELIGIBLE（官方文档：bot keeps every every-bot skill），但审计标记 INCOMPLETE，不得 PASS。

## ADR-021：Claude 标准来源自动派生与 ACCOUNT_SYNC 门禁（2026-11-13，FIX-R1，P0-R1-03 / P1-R1-03）

- 决定：PERSONAL（`~/.claude/skills`）与 PROJECT（仓库 `.claude/skills`）是标准来源，profile 漏列时适配器自动派生——目录含技能、或有不可验证的跳过项、或不可读时派生；目录缺失或为空时不派生。派生根 id 为 `personal` / `project`，冲突时加后缀。NESTED 不派生（依赖会话实际访问的子目录；未访问等于已知无此来源）；ENTERPRISE 不派生（来自 managed-settings 目录）。
- 账号同步：`~/.claude/skills/synced/` 是 ACCOUNT_SYNC 标准位置。未声明 ACCOUNT_SYNC 根时，PoC 以 `accountSyncDir` 输入检查该目录：缺失（ENOENT/ENOTDIR）是已知无此来源；存在且含技能、或不可读，则 ACCOUNT_SYNC 未知（SOURCE_NOT_ENUMERATED），requiredSources 计入该来源，审计 INCOMPLETE。已声明 ACCOUNT_SYNC 根时以声明为准，不再另查 synced/。
- 原因：手动 source_roots 漏列标准来源时，旧实现静默 PASS；派生 + 门禁使“漏列”与“不可读”都无法再静默通过。

## ADR-022：CLI 契约字段与真实默认路径（2026-11-13，FIX-R1，P1-R1-01 / P1-R1-04）

- 决定：schema 新增可选字符串字段 `bot_id`、`data_dir`、`snapshot_path`、`config_path`（minLength 1）。engine=openmausbot 时 `bot_id` 必填（缺失 → 退出码 3）；CLI 不再默默用 profile_id 作 bot id。`data_dir` 显式值优先于 OMB_DATA_DIR，缺省时按 OMB_DATA_DIR → `<home>/.openmausbot` 解析（CLI 不再强制 `env: {}`，改传 `process.env`）。`snapshot_path` 显式值优先于 profile 目录 `./snapshot.json`，缺失则 INCOMPLETE（ADR-007）。Codex 配置优先级：显式 `config_path` → profile 目录 `config.toml` → 用户真实 `~/.codex/config.toml`；存在但不可读的配置文件视为已找到（交由 PoC 失败关闭），不回退到下一级；显式路径缺失 → 退出码 3。解析结果（config/bot/data dir/snapshot 的路径与来源）打印在审计摘要中。
- 原因：旧 CLI 对 OMB 硬编码 `dataDir: "./data"`、`botId: profile_id`、`env: {}`，绕过了适配器自身的 resolveDataDir；对 Codex 只读 profile 旁的 config.toml，忽略了用户真实配置。两者都是“默默用错误默认值”，与“不得把未发现当作不存在”相悖。
- 影响：demo 的 openmausbot-incomplete profile 补显式 `data_dir: "./data"` 与 `bot_id: "bot-1"`；claude-pass demo profile 显式声明 PERSONAL+PROJECT（派生为 no-op）；codex-fail demo 有 profile 目录 config.toml（优先级 profile，不变）。

## ADR-023：PoC 与内核只比较 ELIGIBLE 实例，DISCOVERED 不触发 SCOPE_LEAK（2026-11-13，FIX-R1，对齐项）

- 决定：PoC 的行内策略比较与内核一致，只比较 ELIGIBLE 实例（ADR-006 的有效集定义）；DISCOVERED 实例（宿主可见但未启用）不触发 SCOPE_LEAK。内核继续剥离 PoC 的行内 SCOPE_LEAK 并重新计算；PoC 与内核的判定现在一致。
- 原因：旧实现分裂——PoC 对禁 scope 的 DISCOVERED 实例报 SCOPE_LEAK FAIL，内核按 ADR-006 丢弃后 PASS；同一输入两种结论。`tests/rules/resolver.test.ts` 中钉住旧分裂行为的测试已按新规则重写（重命名并注明 ADR-023），这是行为变更，不是严重度调整。
- 影响：S0 无 DISCOVERED+禁策略组合的 fixture，gate SHA 不变。

## ADR-024：Codex 符号链接逃逸守卫测解析后路径，逃逸即 SYMLINK_OUTSIDE_ROOT（2026-11-13，FIX-T013R，P1-T013R-01）

- 决定：`addSkillDir` 的逃逸守卫改为测解析后路径（`relativePosix(rootDir, realSkillPath)`，Oracle 同理）。解析后路径落在来源根之外时：产生 SYMLINK_OUTSIDE_ROOT（P1，status UNKNOWN，sourceScope 为发现它的 scope），审计 INCOMPLETE；技能不归属到包含它的 scope、不读逃逸目标内容、不静默丢弃。PoC 状态推导与内核 `deriveAuditStatus` 对齐：任一 UNKNOWN 状态 finding 即 INCOMPLETE，即使全部来源都已枚举。根内符号链接仍跟随并按别名归并。
- 原因：旧守卫测的是未解析路径 `skillMdAbs`，按构造恒在根内——死代码。逃逸技能被跟随并归属到包含它的 scope，禁 USER 策略可经仓库符号链接完整绕过（false PASS，复审与 Muse 各自独立复现）。冻结版本即有的旧缺陷，FIX-R1 未引入，R1 与原 T013 均未发现。
- 影响：TS 与 Oracle 同步修正（detail 逐字相同）；回归 5+5（TS r2 套件 5 项含 nobody 1 项，Oracle TestFixT013ROracle 5 项）；S0 无逃逸 Codex 符号链接夹具，gate SHA 实测不变。

## ADR-025：Oracle accountSyncDir 检查与 TS 的 hasUnverifiable 对齐（2026-11-13，FIX-T013R，P2-T013R-02）

- 决定：Oracle 的 accountSyncDir 检查中，`_codex_list_skill_dirs` 返回 error、或某技能子目录的 SKILL.md stat 以非 ENOENT 失败时，视为未知（ACCOUNT_SYNC 未知 + SOURCE_NOT_ENUMERATED），与 TS `scanSkillRoot` → `hasUnverifiable` 的判定一致。TS 侧该分支本就正确（`hasUnverifiable` 已覆盖），本次只补两侧的回归样本。
- 原因：旧 Oracle 代码把这两类失败都吞掉（`has_skill` 保持 False → 无 finding），与 TS 在“synced/ 内仅有不可读技能子目录”这一窄边上分歧。TS 侧 fail-closed 正确，Oracle 侧补齐。
- 影响：窄边 parity 差异消除；不影响任何现有结论。

## ADR-026：T014 冻结钉住 MIT LICENSE 内容哈希（2026-11-13，第二轮 T014 冻结）

- 决定：release-build / release-verify 的 LICENSE 门禁由“冻结树中不得有 LICENSE（PENDING_SAM_DECISION）”改为“冻结树根须有 MIT LICENSE 且内容哈希为 `50b8b302…`（与 P021 的 LICENSE 字节一致）”；manifest 的 `license` 字段由 `PENDING_SAM_DECISION` 改为 `MIT`；`skillscope/LICENSE` 不再是 source.zip 的禁入条目（它是冻结树的一部分，由 file list 逐字节覆盖）；提取树中同样核对 LICENSE 存在与哈希。
- 原因：Sam 于 2026-11-13 ~18:02 GMT 决定全部项目许可证均为 MIT；FIX-R1 已把 MIT LICENSE（Copyright (c) 2026 dcz66614）加入仓库根。旧门禁写的是决定前的状态，在新冻结 commit 上必然失败——这是打包脚本滞后于已决定的许可证决策，不是业务缺陷。只改打包脚本，不动业务源码，沿用上一轮 T014 的三处脚本修复先例（ADR-018）。
- 影响：第二轮冻结的 source.zip / dist.zip 均含 LICENSE；R2 终审须用新冻结产物。

## ADR-027：Codex 跨来源物理文件按 scope 分实例，禁止先扫描者决定归属（2026-11-13，FIX-R2，P1-R2-02）

- 决定：`resolveCodexSkills` 的 `addSkillDir` 增加按 (realpath, sourceScope) 索引的 `byRealPathAndScope` 表（Oracle 的 `add_skill_dir` 增加 `by_real_path_and_scope` 字典，独立推导、同行为）。同一物理文件同一 scope 内多路径到达仍归并为别名（c06 不变）；经第二 scope 到达时新建第二实例（各自的 sourceRootId / sourceScope / relativePath / instanceId；contentSha256 与 canonicalPathHash 相同）；`byRealPath` 只保留首个实例作为同 scope 归并锚点，不再决定 scope。内核对两个实例分别做策略比较，禁 USER 时 SCOPE_LEAK 命中 USER 实例、审计 FAIL。按 realpath 匹配的 path selector 同时命中两个实例；同名实例的 NAME_SELECTOR_BLAST_RADIUS 计入两个实例。不新增 finding id——违规由内核 SCOPE_LEAK 覆盖。
- 原因：旧的全局 byRealPath 去重使第二 scope 只加 alias、不保留 sourceScope；repo_root == home_root 时 REPO 与 USER 同指 `./.agents/skills`，禁 USER 的技能只显示 REPO 实例、内核 PASS、findings []（R2 终审新 P1，Muse 用冻结 dist 亲自复现；原 P2-T013-06 升级）。IdentityRegistry 身份键本就是 (sourceRootId, canonicalPath)，Claude 的 scanSkillRoot 按根新建去重表——两者经检查均无同款 first-wins 归并，不改。
- 影响：TS 与 Oracle 同步修正；回归 r3 套件 TS 4 项 + Oracle TestFixR2Oracle 4 项（home==repo、重叠根、不相交对照、同名 selector 命中双实例）；S0 无跨 scope 同物理文件夹具，gate SHA 实测不变。

## ADR-028：冻结打包以目录集核对防空目录丢失（2026-11-13，FIX-R2，P1-R2-01）

- 决定：`git archive` 不打包空目录，而文件 SHA 清单看不见目录——R1/R2 回归夹具的 25 个必需空目录（GPT 点名 7 个；全量审计：22 个回归夹具目录 + 顶层 02_source / 04_review / 05_release）因此从 source.zip 丢失，解压树跑 r2 回归 4 失败 / 1 通过。修复分三层：(1) 全部 25 个空目录加空 `.gitkeep`；(2) release-build 在打包前失败 fast：工作树中任一叶空目录缺 `.gitkeep` 即 FAIL（`emptyDirsMissingGitkeep`，仅顶层跳过 .git / node_modules / dist / release——夹具技能目录可名为 release，逐层跳过会误报）；(3) release-verify 比对冻结 commit 的目录集与 source.zip 的目录条目（逐祖先展开），文件全对但目录缺失仍 FAIL。新增 `scripts/verify-extracted-tree.mjs`（`npm run verify:extracted-tree`）：解压 source.zip、比对解压树与工作区目录集、链接 node_modules 现场 build、解压树内跑 r1+r2 回归与全量 npm test。
- 原因：T012 只给 S0 夹具加了 23 个 .gitkeep，R1/R2 回归夹具漏了；既有门禁只核对“已跟踪的 .gitkeep 目录在解压树中存在”，发现不了“缺失的 .gitkeep 文件”。缺失与存在空目录在扫描语义上不同（USER/ADMIN 来源 missing → 未知 → INCOMPLETE，空目录 → ok），所以空目录丢失会改变审计结果，不只是 cosmetic。
- 影响：冻结脚本新增两道门禁 + 一个解压树重现脚本；旧版 source.zip 对旧冻结 commit 的核对仍通过（两边同缺新目录），门禁向后兼容；新冻结的 source.zip 须经 verify-extracted-tree 全绿才算可重现。

## 待定事项

- OPEN-001：已关闭（见 ADR-003，smol-toml 1.9.1）。
- OPEN-002：已关闭（见 ADR-004，yaml 2.9.1）。
- OPEN-003：已关闭（见 ADR-017，2026-11-13，T012）。
- OPEN-004：已关闭（见 T008b，2026-11-13）。计划 §5 T008 原文内容（Snapshot I/O、隐私脱敏与规范化哈希）已由 T008b 交付：src/io、src/privacy、src/canonical、schemas、HASH_PRIVACY_REPORT.json；验收 test:io 24/24、test:privacy 53/53、test:hash 39/39，S0 gate 哈希不变。T009 可以启动。
