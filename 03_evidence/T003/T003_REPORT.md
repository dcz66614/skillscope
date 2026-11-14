# T003 验收报告 — Claude Code 与 OpenMausBot 来源 PoC

- TASK_ID: T003
- STATUS: PASS
- BASE_COMMIT: b0d3d4f（T001 PASS）
- SPEC_VERSION: 1.0.0（PROJECT_BOOK.md / IMPLEMENTATION_PLAN.md，01_spec/）
- 日期：2026-11-13
- 规则依据：PROJECT_BOOK.md §4.4（Claude Code）、§4.5（OpenMausBot）、§5.2（Finding 分类）；Issue #5449 仅作真实故障模式来源，不声称九项全部未修复。

## 交付物

| 文件 | 说明 |
|---|---|
| `src/adapters/shared/skill-scan.ts` | 共享只读扫描：单层技能目录扫描、最小 frontmatter 解析（仅 name/description）、规范路径 + 内容 SHA-256 身份、同 realpath 归并 alias、不可读项记入 skipped 不静默丢弃 |
| `src/adapters/claude/claude-poc.ts` | Claude Code PoC：ENTERPRISE / PERSONAL / PROJECT / NESTED / ADD_DIR / PLUGIN / ACCOUNT_SYNC 七来源；插件命名空间；name-based skillOverrides（无 path selector）；未知来源 => INCOMPLETE |
| `src/adapters/openmausbot/openmausbot-poc.ts` | OpenMausBot PoC：config.json flags（缺失 =>  documented defaults；无效 => INCOMPLETE）；opt-out fail-open；版本化 snapshot（未知版本 => INCOMPLETE）；导入副本关闭后原始路径仍加载；native name switch blast radius；disabledPluginIds |
| `tests/fixtures/s0/claude/c01–c08/` | 8 个 Claude fixture（profile.json + 合成技能目录 + 手工推导 expected.json） |
| `tests/fixtures/s0/openmausbot/o01–o08/` | 8 个 OpenMausBot fixture（同上；含合成 data/config.json 与 opt-out 文件） |
| `tests/claude/claude-poc.test.ts` | 8 个 fixture 测试 + 5 个规则单测 |
| `tests/openmausbot/openmausbot-poc.test.ts` | 8 个 fixture 测试 + 5 个规则单测 |
| `03_evidence/T003/CLAUDE_OPENMAUSBOT_POC.json` | 16 个 fixture 的 expected vs actual 全量对照（独立 dump 脚本对 dist 构建跑出，16/16 matched；sha256 `6b2b8c97…`） |
| `03_evidence/T003/T003_REPORT.md` | 本报告 |

## 规则矩阵（已实现并测试）

### Claude Code

| 规则 | 实现 | 覆盖 |
|---|---|---|
| ENTERPRISE / PERSONAL / PROJECT 优先级与分类 | 按来源根分别扫描，scope 保留在实例上 | c01 |
| Root 与 nested 同名技能共存为不同实例 | 不合并、不遮蔽；记 SAME_NAME_COLLISION（P2） | c02 |
| 插件技能带命名空间，不与裸名本地技能合并 | 逻辑名 `<plugin>:<name>` | c03 |
| --add-dir 来源 | ADD_DIR scope 正常发现 | c04 |
| Account-sync 无快照时 UNKNOWN | SOURCE_NOT_ENUMERATED（P1）+ INCOMPLETE，绝不 PASS | c06 |
| skillOverrides 纯 name-based，无 path selector | 命中全部同名实例；命中 >1 个 => NAME_SELECTOR_BLAST_RADIUS（P1） | c05 |
| 裸名 override 不触及命名空间插件实例 | `deploy` 不命中 `acme:deploy`；反之亦然 | 单测 |
| 未访问的 nested 目录不在会话范围内 | 不发现、不算未知来源 | 单测 |
| 政策禁用的 scope 进入有效集 => SCOPE_LEAK（P1） | forbiddenScopes / allowedScopes 比对 | c07 |
| 前置无效（缺 name）=> INVALID 实例 + INVALID_MANIFEST（P2） | 实例排除出有效集 | c08 |

### OpenMausBot

| 规则 | 实现 | 覆盖 |
|---|---|---|
| config.json 缺失 => documented defaults（两开关 off） | flags.configSource = "defaults" | o03 |
| config.json 无效/不可读 => INCOMPLETE + FAIL_OPEN_CONFIG（P1） | 不猜测 flag 状态 | 单测 |
| claudeUserSkills 开 => 个人 Claude 技能加载；关 => DISCOVERED 不加载 | flag 门控 | o02 / o03 |
| skillsLibrary 开 => 共享库 every-bot 技能加载；关 => DISCOVERED 不加载 | flag 门控 | o01 / o02 |
| opt-out 缺失 => 无 opt-out，every-bot 技能适用 | 缺失不等于未知 | 单测 |
| opt-out 无效/不可读 => FAIL_OPEN_CONFIG（P1）+ INCOMPLETE | 按公开文档 fail-open 语义，不声称 PASS | o05 |
| 导入副本关闭但原始路径仍在可加载根下 => IMPORT_ORIGINAL_PATH_STILL_ACTIVE（P1） | 原始路径另建 ELIGIBLE 实例 | o06 |
| 导入副本开启且原始路径不在可加载根下 => 无 finding | 干净对照 | o04 |
| Native 按名开关误伤同名 repo 技能 => NAME_SELECTOR_BLAST_RADIUS（P1） | name switch 命中全部同名实例 | o07 |
| 账号插件技能无 per-bot 开关 + 政策禁 PLUGIN => SCOPE_LEAK（P1） | disabledPluginIds 为空时保持 ELIGIBLE | o08 |
| 未知 snapshot 版本 => 库存不可信 => INCOMPLETE，零实例 | 版本门 | 单测 |
| Snapshot 技能指向缺失目录 => SOURCE_NOT_ENUMERATED（P1）+ INCOMPLETE | 不把缺失当作不存在 | 单测 |

### 通用判定（两适配器一致）

- 状态优先级：INCOMPLETE > FAIL > PASS。P2 finding（SAME_NAME_COLLISION / DUPLICATE_CONTENT / INVALID_MANIFEST）只登记，不把 PASS 翻成 FAIL。
- 实例身份：规范路径（realpath）+ 内容 SHA-256，绝不用逻辑名作唯一身份；同内容异路径仍为两个实例，另报 DUPLICATE_CONTENT（P2）。
- Account-sync / snapshot 派生实例无磁盘文件：contentSha256 为快照记录的哈希（已在代码注释中说明），evidenceLevel 为 HOST_SNAPSHOT。

## Fixture 分类（供 T004 复用）

每宿主 8 个 fixture = 4 个正常控制 + 4 个植入偏差：

| 宿主 | 正常控制 | 植入偏差 |
|---|---|---|
| Claude Code | c01 基础三来源、c02 root+nested 共存、c03 插件命名空间、c04 add-dir + 有快照的 account-sync | c05 name override blast radius、c06 account-sync 未枚举、c07 nested scope leak、c08 无效 manifest |
| OpenMausBot | o01 opt-out 生效、o02 user-skills 开、o03 无 config 默认值、o04 导入干净对照 | o05 opt-out 损坏 fail-open、o06 导入原始路径仍加载、o07 native 按名误伤、o08 插件无开关 |

T004 需补足每宿主 16 例（8 控制 + 8 植入）方可成 48 例 S0 gate；本任务 16 例可直接复用，expected.json 为手工推导、非生产输出复制。

## 验收命令（真实跑过）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm run typecheck` | 0 | tsc --noEmit 无报错 |
| `npm run test:claude -- --run` | 0 | vitest 13/13 通过（8 fixture + 5 单测） |
| `npm run test:openmausbot -- --run` | 0 | vitest 13/13 通过（8 fixture + 5 单测） |
| `npm run test:oracle` | 0 | Python unittest 11/11 通过（T001 既有 canonical 测试；Oracle resolver 本体仍为 T004 待实现桩） |
| `npm run build` | 0 | dist 构建成功；POC JSON dump 对 dist 构建跑出 16/16 matched |

## 全量测试观察（非本任务验收项）

`npm test` 全量：47 个测试，46 通过，1 失败——失败的是 **T002 的 `tests/codex/codex-poc.test.ts > c06-symlink-alias`**（T002 并行施工中，未完成）。本任务的 3 个测试文件（contracts 10 + claude 13 + openmausbot 13）全部通过。**未碰 T002 的任何文件**（src/adapters/codex、tests/codex、tests/fixtures/s0/codex、package.json / package-lock.json 的修改均为 T002 的，本提交不含它们）。

## 已知局限

- PoC 级 frontmatter 解析：只读 name/description 两字段；完整 YAML 解析与 manifest 校验在 T005。
- PoC 只扫描技能根的单层子目录；嵌套发现、symlink 深度策略在 T005。
- OpenMausBot 适配器只读公开文档说明的 config.json / opt-out 文件与版本化 snapshot；不解析未公开 SQLite schema、不调用私有 HTTP API（按 §4.5 边界）。
- Claude account-sync 快照技能无磁盘文件，contentSha256 为快照记录哈希（见上）。
- 未触碰真实宿主配置、真实 SKILL.md、真实账号、任何凭证；零真人参与；无网络调用。

## 交接

- TASK_ID: T003
- STATUS: PASS
- BASE_COMMIT: b0d3d4f
- OUTPUT_COMMIT: 2716487（`git show --stat` 82 个文件；仅本任务文件归属，不含 T002 的 package.json / codex 文件）
- INPUT_SHA256: 见 01_spec 规格文件（PROJECT_BOOK.md 31,870 B，IMPLEMENTATION_PLAN.md 34,795 B）
- MODIFIED_FILES: 仅本任务文件归属（src/adapters/shared、src/adapters/claude、src/adapters/openmausbot、tests/claude、tests/openmausbot、tests/fixtures/s0/claude、tests/fixtures/s0/openmausbot、03_evidence/T003）
- FORBIDDEN_FILES_TOUCHED: 无（未碰 T002 文件、package.json、src/contracts、oracle/）
- COMMANDS / EXIT_CODES: 见上表
- TEST_SUMMARY: test:claude 13/13；test:openmausbot 13/13；test:oracle 11/11；typecheck 0；build 0
- ORACLE_PARITY: 不适用（Oracle resolver 本体待 T004；本任务 expected.json 为手工推导）
- GATE_SHA256: 不适用（S0 gate 待 T004）
- KNOWN_LIMITATIONS: 见上节
- EVIDENCE_PATHS: 03_evidence/T003/CLAUDE_OPENMAUSBOT_POC.json、03_evidence/T003/T003_REPORT.md
- NEXT_TASK: T004（Python Reference Oracle + 48 例 S0 Gate）
- ROLLBACK: git revert OUTPUT_COMMIT
