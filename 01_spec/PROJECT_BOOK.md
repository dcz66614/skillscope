# P023 SkillScope 技能作用域镜｜PROJECT_BOOK.md

**PROJECT_ID:** P023    
**SLUG:** skillscope    
**SPEC_VERSION:** 1.0.0    
**方向:** C01 SkillScope 技能作用域镜（已锁定）    
**SPEC_STATUS:** SPEC_FROZEN / NOT_IMPLEMENTED    
**PLAN_STATUS:** READY_FOR_S0_ONLY    
**GO_STATUS:** GO NOT DECLARED    
**LICENSE:** MIT (Sam 决定，2026-11-13 ~18:02 GMT)
**参与政策:** ZERO_HUMAN_PARTICIPANTS    
**用户价值测量:** USER_VALUE_NOT_MEASURED    
**规格日期:** 2026-11-13

> SkillScope 是一个本地优先、只读的技能作用域解析与隔离一致性验证工具。它回答：每个 Bot 在当前项目、用户、管理员、插件和账号同步上下文中，究竟能发现哪些 Skill？这些 Skill 从哪里来？同名技能是否被一起禁用？配置损坏后是否 fail-open？它不执行权限控制、不修改宿主配置、不做技能安全扫描。

## 0. 一页摘要

### 0.1 一句话价值

**一条命令，查清每个 Agent 到底能看到哪些 Skills、每个 Skill 从哪里来，以及是否有不该出现的技能。**

示意输出（非实测）：

~~~text  
\$ skillscope audit --profile skillscope.json

CODEX / repo: billing-service  
  ✓ repo/.agents/skills/release  
  ! same-name collision: deploy (2 distinct paths)  
  ! name selector affects 2 skills; expected 1

CLAUDE / repo: billing-service  
  ✓ project/.claude/skills/release  
  ? account-synced skills: not enumerated

OPENMAUSBOT / bot: release-helper  
  ✓ assigned library skill: release  
  ! unreadable opt-out state: INCOMPLETE

RESULT: FAIL  
Report: ./skillscope-report.html  
~~~

以上路径、名称和结果只是 UI 样例，不是对任何真实账号、机器或 Bot 的扫描结果。

### 0.2 核心机制

1. 为每个 Bot / Agent 会话建立独立来源清单：项目、用户、管理员、系统、插件、账号同步、共享技能库、导入技能等。  
2. 按 Codex、Claude Code、OpenMausBot 各自的加载与禁用规则，解析技能是否进入该 Bot 的可发现集合。  
3. 用物理文件身份、规范路径、来源作用域和内容 SHA-256 区分同名实例、符号链接别名和内容相同但来源不同的文件。  
4. 将预期集合与用户策略、可取得的宿主观察清单对照，检测全局继承、同名误伤、错误关闭、未枚举来源和 fail-open 风险。  
5. 输出确定性 JSON / 静态 HTML 报告及 SHA-256 证据；无法完整枚举时输出 UNKNOWN / INCOMPLETE，不把未知当作安全。

### 0.3 冻结边界

- 只做技能作用域解析与隔离一致性验证，不做技能商店、安装器、同步服务或 Agent Runtime。  
- 默认只读；扫描不修改 SKILL.md、配置文件、插件状态或宿主设置。  
- 不执行 SKILL.md 中的命令、脚本、链接或任何内容。  
- 不调用 LLM、云 API、商业付费 API、远程模型或遥测服务。  
- 0 名真人参与者；验证全部采用合成目录、合成配置、固定输入、确定性算法和独立 Python Reference Oracle。  
- 许可证 MIT（Sam 决定，2026-11-13 ~18:02 GMT；LICENSE 已加入仓库根目录）。

## 1. 用户、场景与痛点

### 1.1 目标用户

- **多 Agent 开发者：** 同一台机器上使用 Codex、Claude Code、OpenMausBot，在多个仓库配置项目级、个人级和共享 Skills。  
- **AI 开发环境维护者：** 管理团队开发机、远程 VM 或自托管 Agent 平台，需要在安装、更新、迁移后核验 Bot 技能范围。  
- **Agent Harness / IDE 开发者：** 维护多 Bot 工作台，需要在发布前验证技能来源枚举、同名处理和禁用规则。

### 1.2 典型场景

1. 新增个人 Skill 后，确认它是否只对预期用户或 Bot 可见。  
2. 在 monorepo 子目录启动 Agent，核对当前目录、上级目录和仓库根目录的技能合并结果。  
3. 项目目录与个人目录各有一个同名技能，关闭一个时确认是否误伤另一个。  
4. Bot 级开关调整后，检查原始目录、共享库或引擎原生技能是否仍进入会话。  
5. 配置文件损坏或不可读时，确认系统是否恢复默认启用。  
6. 发布前用固定 fixture 重跑 CI，检测宿主升级是否改变技能作用域。

### 1.3 痛点量化（规划假设，不是用户研究结果）

| 指标 | 初始假设 | 证据边界 |  
|---|---:|---|  
| 触发频率 | 技能安装、更新、切仓库或调整 Bot 时；目标用户每周约 2–5 次相关检查 | NOT_MEASURED |  
| 痛点强度 | 4/5 | 产品判断假设 |  
| 一般排查代价 | 每次约 10–30 分钟 | 工程估算，未实测 |  
| 复杂故障代价 | 约 30–90 分钟，严重时可能更长 | 规划区间，非行业统计 |  
| 当前 workaround | 手工 find/grep、查看 /skills、检查配置、重启宿主、逐个 Bot 对照 | 只能检查局部 |  
| workaround 不足 | 目录存在不等于 Bot 会加载；同名不等于同一文件；按名称关闭可能影响多个路径；插件可能不在本地目录列表 | 由公开规则和真实 Issue 支持 |

### 1.4 需求证据

**OpenMausBot #5449：** 2026-11-11 创建，2026-11-13 页面仍显示 Open。报告涉及 Codex / Claude 按名称禁用造成同名误伤、配置不可读时技能重新出现、~/.agents/skills 漏列、关闭导入副本但原始目录仍加载，以及账号插件技能进入 Bot 回合等问题。后续有 #5450、#5454 修复提议和提交，并提到 #5488 对账号插件路径的处理。因此本项目将其作为真实故障模式和合成回归样本来源，不声称九项问题全部仍未修复。

https\://github.com/milind-soni/OpenMausBot/issues/5449

**Codex 官方规则：** 项目来源从当前目录向仓库根目录扫描 .agents/skills；用户来源为 \$HOME/.agents/skills；管理员来源为 /etc/codex/skills；系统来源为 bundled skills；支持 symlink。skills.config 的绝对 path 只匹配单个 SKILL.md，name 匹配所有同名技能，多条匹配时最后一条生效。

https\://learn.chatgpt.com/docs/build-skills

**Claude Code 官方规则：** 企业、个人、项目、嵌套目录、额外目录、插件和 claude.ai 账号同步技能具有不同来源语义；项目根目录和嵌套技能可同时存在；插件技能带命名空间。

https\://code.claude.com/docs/en/skills

**Agent Skills 规范：** 技能目录至少含 SKILL.md；frontmatter 要求 name 和 description，并规定 name 的格式约束。

https\://agentskills.io/specification

**OpenMausBot 官方配置：** 服务端 config.json 位于 ~/.openmausbot/config.json 或 OMB_DATA_DIR 指定目录；claudeUserSkills 与 skillsLibrary 默认关闭；共享库 opt-out 状态位于 skill-state/\<bot-id>/library-opt-out.json。公开文档说明无效或不可读的 opt-out 文件可能使 every-bot 技能重新出现。main 分支文档不代表每个发布版本，必须记录实际版本。

https\://github.com/milind-soni/OpenMausBot/blob/main/docs/feature-flags.md

证据边界：单个 Issue 不能推算行业发生率；一个宿主的规则不能推断为另一个宿主的规则；不使用未经核实的 Star 增长、市场规模或收购交易作为需求证据。

## 2. 差异化与已有方案边界

| 方案 | 已有能力 | SkillScope 借鉴 | 不复制 |  
|---|---|---|---|  
| Codex / Claude 原生 Skills UI 与 CLI | 列出、选择或调用当前宿主技能 | 尊重宿主自身发现规则 | 不做另一个技能列表 |  
| Agent Skills 开放规范 | 统一 SKILL.md 元数据格式 | 读取 name / description / 目录结构 | 不重新定义标准 |  
| OpenMausBot Skills 页面 | 管理 Bot 与共享库技能 | 区分 Bot、共享库、原生来源 | 不做新的管理页面或写入控制 |  
| SkillGuard 等技能权限研究 | 技能权限、风险治理方向 | 作为相邻研究边界 | 不做权限执行、恶意技能扫描或运行时沙箱 |  
| GitHub CLI 的技能安装 / 枚举工作流 | 技能发现、安装或列举 | 作为开发者习惯参考 | 不把枚举命令包装成独立产品 |

独立价值主张：

**Bot × Session Profile × Skill Instance × Source Scope 的有效集合解析，以及与期望策略之间的隔离一致性验证。**

差异化在于多宿主规则适配、路径身份、name-only selector blast radius、fail-open / 未枚举来源的 UNKNOWN 语义、独立 Python Oracle 和可复现 CI 回归。不声称全球首创。

## 3. 产品目标与非目标

### 3.1 MVP 目标

- 支持 Codex、Claude Code、OpenMausBot 三种来源适配器。  
- 读取用户明确授权的本地技能根目录、宿主配置和可导入来源快照。  
- 识别 SKILL.md、frontmatter、来源范围、逻辑名称、规范路径、符号链接别名和内容 SHA-256。  
- 按宿主规则计算可发现 / 可加载候选集合。  
- 区分 DISCOVERED、ELIGIBLE、DISABLED、ACTIVE_EXPECTED、UNKNOWN、INVALID。  
- 检测同名不同路径、name-selector blast radius、全局继承、禁用失效、配置 fail-open 和未枚举来源。  
- 输出 PASS、FAIL、INCOMPLETE 三态总结果。  
- 提供 CLI、JSON、静态 HTML 和 CI 退出码。  
- 默认本地运行、无外部请求、无遥测、无 LLM。  
- 提供独立 Python Reference Oracle 和 100 次确定性哈希重放。

### 3.2 非目标

- 不做技能商店、技能下载器、安装器或同步服务。  
- 不执行技能正文、scripts/、shell 命令或任何技能指令。  
- 不判断 Skill 是否恶意或安全。  
- 不实现权限控制、拦截器、Bot Runtime 或宿主补丁。  
- 不替代 Codex、Claude Code、OpenMausBot 原生技能 UI。  
- 不保证模型实际调用某个 Skill；只检查可发现 / 可加载范围。  
- 不保证所有插件或账号云端同步技能都能离线枚举；缺少证据必须 INCOMPLETE。  
- 不读取 Cookie、账号令牌、聊天记录、真实对话或模型请求。  
- 不连接真实模型，不发起真实 Agent 回合。  
- 不做 SaaS、云端目录或远程遥测。

### 3.3 MVP 平台范围

| 宿主 | v1.0 支持方式 | 关键边界 |  
|---|---|---|  
| Codex | 本地项目 / 用户 / 管理员技能目录 + config.toml 规则；可选运行时 inventory snapshot | 系统技能与账号插件若无法枚举，标记 UNKNOWN |  
| Claude Code | 本地 enterprise / personal / project / nested / --add-dir、可读取 settings 与插件清单 | 云端 / Cowork 账号同步来源无快照时 UNKNOWN |  
| OpenMausBot | 读取服务端 config.json、feature flags、可读 opt-out 文件；接收版本化 per-bot snapshot | 不猜测未公开数据库结构；缺失 per-bot 清单时 INCOMPLETE |

## 4. 核心规则模型

### 4.1 关键术语

- **Skill Instance：** 特定来源路径中的具体 SKILL.md 文件；两个同名文件是两个实例。  
- **Logical Name：** 宿主用于调用或禁用的名称，可能来自 frontmatter、目录名或插件命名空间。  
- **Source Scope：** REPO / USER / ADMIN / SYSTEM / ENTERPRISE / NESTED / ADD_DIR / PLUGIN / ACCOUNT_SYNC / BOT_ASSIGNED / SHARED_LIBRARY / IMPORTED。  
- **Session Profile：** 某 Bot 在特定 cwd、repo、用户目录、宿主版本、启动参数和 feature flags 下的来源上下文。  
- **Expected Set：** 根据宿主规则和策略配置计算的可发现 / 可加载技能实例集合。  
- **Observed Set：** 宿主公开 inventory、版本化 snapshot 或明确可读取的运行时证据提供的集合。  
- **Coverage：** 已成功枚举来源 / 应枚举来源。未知来源不能从分母中静默删除。

### 4.2 身份与哈希

每个 Skill Instance 保存 engine、bot_id、session_profile_id、source_scope、source_root_id、relative_path、logical_name、folder_name、manifest_name、content_sha256、instance_id、symlink_aliases、discovery_status、load_status 和 evidence_level。

身份规则：

1. 不以 logical_name 作为唯一身份。  
2. 同名但不同规范路径的文件保持为不同实例。  
3. 多个符号链接最终指向同一文件时归并为一个物理实例，并保留 alias。归并只在同一来源 scope 内发生（FIX-R2，见 §4.3 跨来源段）：同一物理文件经第二个 scope 到达时，为该 scope 另建一个实例，不得由先扫描的 scope 决定策略结果。  
4. 内容 SHA 相同但路径不同的两个文件仍是两个实例；另报 DUPLICATE_CONTENT。  
5. 导出报告默认使用 source_root_id + 相对路径；机器绝对路径和用户名默认脱敏。  
6. 路径大小写、Unicode NFC、Windows 盘符和符号链接语义由平台适配器处理；无法确定文件系统大小写语义时不猜测。

### 4.3 Codex 规则

依据 OpenAI 官方文档：

- 项目来源：当前工作目录及其父目录到 repository root 范围内的 .agents/skills。  
- 用户来源：\$HOME/.agents/skills。  
- 管理员来源：/etc/codex/skills。  
- 系统来源：Codex bundled skills。  
- 符号链接目录会跟随目标扫描。  
- skills.config 每条记录使用 path 或 name 之一。  
- path 是绝对 SKILL.md 路径，只匹配单个实例。  
- name 匹配所有同名技能。  
- 多条匹配规则中最后一条生效。  
- [skills.bundled].enabled=false 可关闭当前项目的 bundled system skills。

必须显示 name selector 的影响实例数。若用户想关闭一个实例但 selector 会命中多个同名实例，输出 NAME_SELECTOR_BLAST_RADIUS。

未能读取 Codex 配置、系统技能清单或账号插件清单必须标记 UNKNOWN；不能把未发现当作不存在。

**失败即未知（FIX-R1，P0-R1-01）：** 技能根目录的枚举结果是三态——`ok`（已枚举）、`missing`（路径不存在或不是目录，已知无此来源）、`unreadable`（存在但因权限或 I/O 错误无法读取）。`unreadable` 必须进入 unknownSources 并使审计 INCOMPLETE；绝不能把读取失败转换为空集合后 PASS。同一根目录内已读到的技能仍保留，但来源整体标记未知。悬空符号链接（目标不存在）跳过，不计入未知。

**符号链接逃逸（FIX-T013R，P1-T013R-01）：** 守卫必须测解析后路径（realpath）。解析后路径落在来源根之外的技能不得归属到包含它的 scope，也不得静默丢弃：产生 SYMLINK_OUTSIDE_ROOT（P1/UNKNOWN），审计 INCOMPLETE；逃逸目标的内容不得读取。根内符号链接仍跟随并按别名归并（同一物理实例多路径合并）。

**跨来源物理归并（FIX-R2，P1-R2-02）：** 物理身份与来源归属分离。同一物理文件（同一 realpath）在**同一** scope 内经多条访问路径到达时归并为一个实例并保留 alias（c06 行为不变）；经**第二个 scope**到达时，为该 scope 另建一个实例（各自的 sourceRootId / sourceScope / relativePath / instanceId；contentSha256 与 canonicalPathHash 相同）。不得采用“先扫描的 scope 决定归属”——否则禁 USER 的技能会被先到的 REPO 实例吞掉，内核错误 PASS。内核对两个实例分别做策略比较；按 realpath 匹配的 path selector 同时命中两个实例；同名实例触发 NAME_SELECTOR_BLAST_RADIUS 时计入两个实例。IdentityRegistry 的身份键本就是 (sourceRootId, canonicalPath)，天然按 scope 分离，无需改动；Claude 适配器的 scanSkillRoot 按根调用、每次新建去重表，同样无跨 scope 归并，无需改动。Oracle 与 TS 同步实现，行为逐项对齐。

### 4.4 Claude Code 规则

依据 Claude Code 官方 Skills 文档：

- Enterprise：managed settings directory 下的 .claude/skills。  
- Personal：~/.claude/skills。  
- Project：仓库中的 .claude/skills。  
- Nested：子目录 .claude/skills，按启动目录与实际访问目录规则加载。  
- Additional directory：通过 --add-dir / /add-dir 添加的目录。  
- Plugin：插件技能带命名空间。  
- claude.ai account synced skills：CLI、Cowork、cloud sessions 的可见范围不同；云端会话不能简单等同于本地 ~/.claude/skills。

同名规则按官方来源优先级和命名空间处理。项目根目录与嵌套目录技能可以同时存在；插件技能不与普通本地技能按裸名称合并。Claude 的 name-based skillOverrides 不能假定具备 Codex 的绝对路径 selector 能力。

会话启动参数、setting sources、safe mode、managed policy 或账号同步状态缺失时，降低 coverage，必要时返回 INCOMPLETE。

**账号同步来源（FIX-R1，P0-R1-03）：** `~/.claude/skills/synced/` 是 claude.ai 账号同步技能的标准位置，属于 ACCOUNT_SYNC 来源。若 profile 未声明 ACCOUNT_SYNC 根，适配器仍须检查该目录：目录不存在是已知无此来源；目录存在且含技能、或不可读，则 ACCOUNT_SYNC 来源未知（SOURCE_NOT_ENUMERATED），requiredSources 计入该来源，审计 INCOMPLETE。若 profile 已声明 ACCOUNT_SYNC 根，以声明为准，不再另查 synced/。

**标准来源自动派生（FIX-R1，P1-R1-03）：** PERSONAL（`~/.claude/skills`）与 PROJECT（仓库 `.claude/skills`）是标准来源，profile 漏列时适配器自动派生——目录含技能、或有不可验证的跳过项、或不可读时派生；目录缺失或为空时不派生。NESTED 不派生（未访问的子目录等于已知无此来源）；ENTERPRISE 不派生（来自 managed-settings 目录）。

**不可读技能文件（FIX-R1，P0-R1-02）：** 技能目录内 SKILL.md 存在但不可读（权限拒绝等）时，该技能内容未知：来源不得计入已枚举，审计 INCOMPLETE。子目录本身没有 SKILL.md（如 synced/ 容器目录）只是“不是技能”，静默跳过；目录名恰为 SKILL.md 亦然。

### 4.5 OpenMausBot 规则

依据 OpenMausBot 当前公开 feature-flags 文档与 #5449：

- 服务端 config.json 默认位于 ~/.openmausbot/config.json；若配置 OMB_DATA_DIR，则从该目录读取。  
- **功能开关位于 `config.json` 的 `features` 对象内（FIX-R1，P0-R1-04）：** `{"features": {"skillsLibrary": true, "claudeUserSkills": true}}`。顶层同名键一律忽略——只有 `features` 对象内的布尔值生效；`features` 缺失时两开关均为默认关闭；`features` 不是对象、或开关值不是布尔值时，配置无效（FAIL_OPEN_CONFIG + INCOMPLETE）。旧版按顶层读 flags 是错误假设，已修正；Python Oracle 同步修正。  
- claudeUserSkills 默认关闭；开启后 Claude Bots 可加载机器个人 ~/.claude/skills。  
- skillsLibrary 默认关闭；开启后共享技能库和相关设置可用。  
- every-bot 技能 opt-out 状态位于数据目录 skill-state/\<bot-id>/library-opt-out.json。  
- 当前公开文档描述：opt-out 文件存在但不可读或格式不正确时，Bot 可能重新获得 every-bot 技能；这是必须保留的 fail-open 回归样本。  
- **权限拒绝与不存在必须区分（FIX-R1，P1-R1-02）：** 配置文件或 opt-out 文件存在但不可读（EACCES/EPERM）时，审计 INCOMPLETE（FAIL_OPEN_CONFIG）；opt-out 不可读时实例仍按宿主语义保持 ELIGIBLE，但审计不得 PASS。仅当路径确实不存在时才按缺省/缺失处理。  
- #5449 还记录 Bot 级原生技能开关、同名冲突、导入技能原始路径仍加载及插件来源问题；Issue 后续有部分修复提议和提交，必须按宿主版本区分。

适配边界：

1. 只读读取已公开文档说明的配置文件和 opt-out 文件。  
2. per-bot assigned / imported / plugin inventory 优先使用版本化 snapshot contract。  
3. 不解析未公开 SQLite schema，不猜测内部目录，不调用私有 HTTP API。  
4. 配置损坏、缺失或版本未知时输出 INCOMPLETE / UNKNOWN。  
5. 绝不修改 config.json、library-opt-out.json 或 Bot 状态。

## 5. 规则判定、结果与问题分类

### 5.1 总体状态

| 状态 | 定义 |  
|---|---|  
| PASS | 所有必需来源覆盖完整；Expected Set 与策略一致；无确认偏差 |  
| FAIL | 至少一项确认的技能作用域偏差、错误继承、错误禁用或策略违例 |  
| INCOMPLETE | 有无法读取 / 无法枚举 / 版本未知的必需来源，无法证明完整性 |

INCOMPLETE 不得折算成 PASS。报告可同时列出已确认 FAIL 和未解决 UNKNOWN。

**跳过项转 finding（FIX-R1，P0-R1-02）：** 扫描中被跳过的条目凡内容未知者必须转为 finding 或 INCOMPLETE，不得静默消失：SKILL.md 存在但不可读、目录不可读、文件过大（SKILL_MD_TOO_LARGE）均转为 SOURCE_NOT_ENUMERATED（P1/UNKNOWN）；SKILL.md 不存在（ENOENT，子目录不是技能）、符号链接逃逸之外的结构性跳过不转；扫描根缺失/不可读本身已通过 coverage 上报，不重复转 finding。

### 5.2 Finding 类型

| Finding ID | 含义 | 默认严重度 |  
|---|---|---|  
| SCOPE_LEAK | 禁止来源中的技能仍进入 Expected / Observed Set（仅 ELIGIBLE 实例计入；DISCOVERED 实例不触发，ADR-006/ADR-023，FIX-R1 对齐 PoC 与内核） | P1 |  
| DISABLE_MISMATCH | 期望关闭的技能仍被宿主加载 | P1 |  
| NAME_SELECTOR_BLAST_RADIUS | 名称 selector 会影响多个不同实例 | P1 |  
| SAME_NAME_COLLISION | 多个来源存在同名不同路径实例 | P2 |  
| FAIL_OPEN_CONFIG | 配置不可读 / 无效时宿主可能恢复默认启用 | P1 |  
| SOURCE_NOT_ENUMERATED | 插件、账号同步或系统来源未能枚举；或扫描中内容未知的跳过项（不可读 SKILL.md / 目录、过大文件） | P1 / INCOMPLETE |  
| IMPORT_ORIGINAL_PATH_STILL_ACTIVE | 关闭导入副本但原始目录仍加载 | P1 |  
| SYMLINK_ALIAS | 多个来源路径指向同一物理实例 | P2 |  
| SYMLINK_OUTSIDE_ROOT | 符号链接指向未授权扫描根目录 | P1 / INCOMPLETE |  
| INVALID_MANIFEST | SKILL.md 缺失或 frontmatter 不可解析 | P2 |  
| DUPLICATE_CONTENT | 不同路径的 SKILL.md 内容哈希相同 | P2 |

### 5.3 不做的推断

- 不根据技能目录存在推断宿主一定加载。  
- 不根据技能列表没有显示推断宿主不会加载。  
- 不根据同名推断同一实例。  
- 不根据内容哈希相同推断来源或权限相同。  
- 不把静态 Expected Set 冒充运行时 Observed Set。  
- 不推断模型实际是否调用技能，也不评估技能内容是否可信。

## 6. 数据结构与接口

### 6.1 Profile 示例

~~~json  
{  
  "schema": "skillscope.profile/v1",  
  "profile_id": "codex-billing-repo",  
  "engine": "codex",  
  "cwd": "./fixtures/codex/billing-service",  
  "repo_root": "./fixtures/codex/billing-service",  
  "home_root": "./fixtures/home",  
  "source_roots": [  
    {"id": "repo", "scope": "REPO", "path": ".agents/skills"},  
    {"id": "user", "scope": "USER", "path": "../home/.agents/skills"}  
  ],  
  "policy": {  
    "allowed_scopes": ["REPO", "USER", "SYSTEM"],  
    "forbidden_names": ["private-admin"]  
  }  
}  
~~~

该示例只用于合成测试；真实路径由本地 profile 配置提供，不写入公开 golden。

**FIX-R1 新增可选字段（schema `skillscope-profile-v1.json`）：** OpenMausBot profile 须声明 `bot_id`（必填于 engine=openmausbot 时；CLI 不再默默用 profile_id 作 bot id），可选 `data_dir`（显式数据目录；缺省时按 OMB_DATA_DIR → `<home>/.openmausbot` 解析）、`snapshot_path`（显式 snapshot 路径；缺省时用 profile 目录下 `./snapshot.json`，缺失则 INCOMPLETE）。Codex profile 可选 `config_path`（显式 `config.toml` 路径；缺省时按 profile 目录 `config.toml` → 用户真实 `~/.codex/config.toml` 顺序解析）。显式路径指向缺失文件时 CLI 退出码 3。

### 6.2 Skill Instance

~~~ts  
interface SkillInstanceV1 {  
  instanceId: string;  
  engine: "codex" | "claude-code" | "openmausbot";  
  botId?: string;  
  sourceRootId: string;  
  sourceScope: string;  
  relativePath: string;  
  canonicalPathHash: string;  
  logicalName: string;  
  folderName: string;  
  manifestName?: string;  
  contentSha256: string;  
  status: "DISCOVERED" | "ELIGIBLE" | "DISABLED" | "UNKNOWN" | "INVALID";  
  evidenceLevel: "STATIC_RULE" | "HOST_SNAPSHOT" | "RUNTIME_OBSERVED";  
}  
~~~

### 6.3 Audit Report

~~~json  
{  
  "schema": "skillscope.report/v1",  
  "profile_id": "codex-billing-repo",  
  "status": "INCOMPLETE",  
  "expected_count": 4,  
  "observed_count": null,  
  "coverage": {"enumerated_sources": 2, "required_sources": 3},  
  "findings": [  
    {  
      "id": "SOURCE_NOT_ENUMERATED",  
      "severity": "P1",  
      "source_scope": "PLUGIN",  
      "status": "UNKNOWN"  
    }  
  ],  
  "inventory_sha256": "\<filled only by a real run>",  
  "oracle_result_sha256": "\<filled only by a real run>",  
  "audit_sha256": "\<filled only by a real run>"  
}  
~~~

占位哈希不是真实运行结果；规格文件不填入虚构哈希。

### 6.4 CLI 合同

计划中的命令：

~~~bash  
skillscope init  
skillscope audit --engine codex --cwd .  
skillscope audit --profile skillscope.json --format json  
skillscope audit --profile skillscope.json --format html --out ./skillscope-report.html  
skillscope verify --fixtures s0  
skillscope audit --profile skillscope.json --ci  
~~~

退出码：0 \= PASS；1 \= FAIL；2 \= INCOMPLETE；3 \= 输入或配置格式错误；4 \= 内部执行错误。

**FIX-R1 CLI 解析规则：** Codex 配置按显式 `config_path` → profile 目录 `config.toml` → 用户真实 `~/.codex/config.toml` 顺序解析，存在但不可读的配置文件视为已找到（交由 PoC 失败关闭），不回退到下一级；OpenMausBot `bot_id` 缺失时退出码 3，`data_dir` 显式值优先于 OMB_DATA_DIR，`snapshot_path` 显式值优先于 `./snapshot.json`；解析结果（config/bot/data dir/snapshot 的路径与来源）打印在审计摘要中。

CLI 默认只读。只有 init 明确创建项目策略文件；audit / verify 不写入被扫描目录。

## 7. UI 与报告设计

### 7.1 主视图：Bot × Source Scope Matrix

行是 Bot / Session Profile，列是 REPO、USER、ADMIN、SYSTEM、PLUGIN、ACCOUNT_SYNC、BOT_ASSIGNED、SHARED_LIBRARY、IMPORTED。单元格显示技能数量、状态与来源覆盖情况。

### 7.2 技能详情

选择某个 Skill Instance 后显示逻辑名称、frontmatter 名称、来源范围和相对路径、规范路径身份摘要、内容 SHA-256、宿主启用 / 禁用 selector、规则命中顺序、同名实例关系、符号链接别名、证据等级与未知原因。

### 7.3 Finding 详情

每条 Finding 展示 Bot / Session Profile、涉及实例、命中的宿主规则、期望与计算状态、支持配置来源、未知原因和建议检查的文件或宿主版本。

### 7.4 静态 HTML

HTML 报告完全离线、自包含；不加载 CDN、远程字体、遥测或第三方脚本。导出默认脱敏绝对路径。

## 8. 技术架构与模块

### 8.1 技术栈

| 组件 | 选型 | 冻结策略 |  
|---|---|---|  
| Runtime | Node.js 24 LTS | T001 记录 VM 实际版本并锁定 |  
| 语言 | TypeScript 5.x | 锁定精确 patch |  
| CLI | Node.js CLI | 不依赖常驻服务 |  
| Frontmatter | YAML parser | 锁定精确依赖与 lockfile |  
| 配置解析 | Node built-in JSON / TOML parser strategy | TOML parser 依赖在 T001 核验 |  
| 哈希 | Node crypto SHA-256 | 标准算法 |  
| 测试 | Vitest 或 Node test runner | T001 根据现有环境冻结 |  
| 独立 Oracle | Python 3.12+ 标准库 | 不导入生产 TypeScript 代码 |  
| 报告 | 静态 HTML + JSON | 无外部资源 |

不需要 GPU、Docker、数据库服务器、LLM、收费 API 或网络连接。若当前 VM 不是 Windows，先记录实际环境；Linux 必测，Windows 路径语义通过合成 fixture 测试，未真机运行不得声称 Windows 已实测。

### 8.2 架构图

~~~text  
CLI / Static HTML Report  
          |  
Profile + Policy Loader  
          |  
Host Adapters  
  | Codex Adapter  
  | Claude Code Adapter  
  | OpenMausBot Adapter  
          |  
Source Discovery / Manifest Parser  
          |  
Skill Identity Registry  
  | canonical path  
  | logical name  
  | content SHA-256  
  | symlink aliases  
          |  
Host-specific Scope Resolver  
          |  
Expected Skill Set + Coverage  
          |  
Policy Comparator / Findings  
          |  
Canonical JSON + SHA-256  
          |  
Python Reference Oracle (tests only)  
~~~

### 8.3 模块归属

- src/contracts/：Profile、Policy、SkillInstance、Report schema  
- src/discovery/：只读目录遍历、SKILL.md 定位  
- src/manifest/：YAML frontmatter 解析与验证  
- src/identity/：canonical path、instance ID、content hash  
- src/adapters/codex/：Codex 来源和 skills.config 规则  
- src/adapters/claude/：Claude 来源、命名空间和 settings 规则  
- src/adapters/openmausbot/：config.json、feature flags、opt-out 与 snapshot  
- src/resolver/：宿主规则与 Expected Set  
- src/policy/：allow / deny / expected source 比对  
- src/findings/：Finding 分类与严重度  
- src/canonical/：规范 JSON 与 SHA-256  
- src/cli/：audit / init / verify / export  
- src/report/：JSON、静态 HTML  
- oracle/python/：独立 Reference Oracle  
- tests/fixtures/：全部合成配置、目录和 snapshot

## 9. 隐私、安全与许可证

- 默认只在本机读取用户明确指定的技能根目录和宿主配置。  
- 不上传 SKILL.md 正文、配置文件、文件名列表或绝对路径。  
- 报告只保留必要元数据、相对路径和哈希；分享版默认脱敏。  
- 不读取 token、API key、Cookie、聊天记录或账号凭据；遇到敏感字段只报告字段存在，不记录值。  
- 不执行 Skill 内容、脚本、MCP 工具或宿主命令。  
- 默认只读；除显式 init 和输出文件外，不修改扫描根目录。  
- 对 symlink loop、路径逃逸、权限拒绝、损坏配置使用限界处理；无法验证时 INCOMPLETE。  
- 不联网；外部资料只在研发规格阶段使用，不作为产品运行依赖。  
- 用户可查看、修改、删除 profile / policy / report；不建立云端副本或持久化个人档案。  
- 项目许可证 MIT（Sam 决定，2026-11-13 ~18:02 GMT；LICENSE 在仓库根目录，Copyright (c) 2026 dcz66614）。
- 第三方依赖必须生成清单并由 T013 复核许可证；未知许可证依赖不得进入发布包。

## 10. 验收标准

### 10.1 S0 硬验证门

固定 seed：P023-SKILLSCOPE-S0-2026-11-13。

- 3 个适配器：Codex、Claude Code、OpenMausBot。  
- 48 个合成 fixture：每个适配器 16 个。  
- 每个适配器 8 个 conformant controls + 8 个植入 scope defects。  
- 24/24 正常控制不得误报。  
- 24/24 植入偏差必须检出。  
- 48/48 生产 resolver 与独立 Python Oracle 逐字段一致。  
- 损坏或不可读的必需配置不得 PASS；必须 UNKNOWN / INCOMPLETE 或确认 FAIL。  
- 固定输入连续运行 100 次，gate_sha256 必须只有一个唯一值。  
- 外部网络请求 0；对源目录写操作 0；真人参与 0。

S0 未通过：STOP；T005–T014 BLOCKED。不得删 fixture、修改 golden 迎合实现、增加忽略项或降低阈值。S0 通过也不自动代表产品已完成。

### 10.2 完整产品验收目标

| 指标 | 目标 |  
|---|---:|  
| S0 固定 fixture | 48/48 |  
| Oracle parity | 100% |  
| 植入偏差检出 | 24/24 |  
| 控制组误报 | 0/24 |  
| 同名不同路径保留为不同实例 | 100% |  
| symlink 同目标别名识别 | 100% 支持样本 |  
| fail-open 风险检测 | 100% 植入样本 |  
| 未枚举来源处理 | 不得 PASS |  
| 100 次 hash replay | 1 个唯一 gate SHA |  
| 产品运行外部请求 | 0 |  
| 真人参与 | 0 |  
| License | PENDING_SAM_DECISION |

### 10.3 性能目标（待 VM 实测）

在 T001 记录的真实 VM 上，使用 500 个合成 Skill Instance、3 个宿主 profile：CLI 完整扫描目标 ≤5 秒；HTML 报告生成目标 ≤2 秒；内存目标 ≤300 MB。以上是工程目标，不是已测成绩；若 VM 资源不足，记录真实基线并在 T012 冻结可实现门槛，不得伪造。

## 11. 开源传播与产品化设计

### 11.1 README 首屏

README 第一屏必须让开发者在 10 秒内理解：

**“一个 Skill 被关闭后，其他同名路径会不会也一起消失？还有哪些技能从别的来源偷偷进入这个 Bot？”**

首屏包含：Bot × Source Scope 矩阵截图、安装命令、audit 命令、SAME_NAME_COLLISION / NAME_SELECTOR_BLAST_RADIUS / FAIL_OPEN_CONFIG Demo、PASS / FAIL / INCOMPLETE 解释，以及 Read-only / Local-first / No LLM / No telemetry 标识。

### 11.2 开箱即用路径

- npx skillscope audit --engine codex --cwd .  
- npx skillscope audit --profile skillscope.json --format html  
- npx skillscope audit --profile skillscope.json --ci

这些是规格阶段的目标命令，开发和验收完成前不得宣称真实可用。

### 11.3 GitHub 传播设计

CLI-first；内置合成 Demo；一条命令生成 HTML；CI 退出码明确；三宿主适配器和公开规则矩阵；维护可复现 host-version fixtures；公开测试夹具和 Oracle 合同。

高 Star 潜力是产品假设，不是承诺。传播力来自问题一句话可懂、一条命令运行、结果能截图、CI 可复用。

### 11.4 产品级与潜在收购价值

可能的战略价值：为 Agent IDE / Runtime 提供跨来源技能作用域验证；为企业 AI 开发平台提供本地或 CI 策略回归；为多 Bot 工作台提供来源完整性与 fail-open 回归测试；形成可持续维护的宿主版本规则数据库和合成回归集。

潜在战略买家类型（纯假设，不代表接触或收购意向）：AI IDE / Coding Agent 厂商、Agent Runtime / Harness 平台、企业开发者平台和安全治理产品、自托管 Agent 工作台。

商业化不进入 MVP。优先开源 CLI 和规则测试；以后若出现真实采用证据，再评估企业策略包、团队基线和支持服务。不得为了商业化而把本地报告或技能内容上传云端。

## 12. 风险与停止条件

| 风险 | 级别 | 处理 |  
|---|---|---|  
| 宿主规则与官方文档不一致 | P0 | 按版本记录；未知版本 INCOMPLETE；不猜 |  
| 同名技能按 name selector 被一起禁用 | P0 | identity-aware blast-radius 检查 |  
| 配置不可读时默认启用 | P0 | 必须 fail closed / INCOMPLETE |  
| 插件或账号同步来源无法枚举 | P1 | coverage 降低，禁止 PASS |  
| symlink loop / path escape | P0 | 限界扫描；不越权读取 |  
| Oracle 与生产实现共享算法 | P0 | 独立 Python 重实现，不 import TS |  
| 内容相同的两个路径被错误合并 | P0 | instance identity 与 content hash 分离 |  
| 项目退化为技能枚举器 | P0 | STOP；必须保留 scope resolution + policy comparison + Oracle |  
| 需要在线模型或收费 API 才能判定 | P0 | STOP |  
| 需要真人访谈 / 真人评审 / 真人验收 | P0 | STOP，违反零真人约束 |

停止条件：无法从公开规则和可审计配置建立三个适配器的最小确定性模型；核心判定不能由独立 Python Oracle 复算；结果必须依赖真实模型调用或私有云端 API；未知来源被错误地显示为 PASS；项目只能列出文件，无法解析每个 Bot 的有效作用域与差异。

## 13. 最终交付物

规格阶段：PROJECT_BOOK.md、IMPLEMENTATION_PLAN.md。

施工与发布阶段：TypeScript CLI 源码与依赖 lockfile；Codex / Claude Code / OpenMausBot 三个 adapter；Python Reference Oracle；48 个 S0 合成 fixture、golden expected、固定 seed；规则回归集、mutation / property / E2E 测试；JSON 与静态 HTML 报告；README、用户指南、环境报告、依赖许可证清单；REVIEW_INDEX.md、REVIEW_PACK_XX.md、独立审查报告；source.zip、dist.zip、RELEASE_MANIFEST.json、SHA256SUMS.txt；真实运行日志、截图、演示与 SHA-256 对照。

**当前状态：** SPEC_FROZEN / NOT_IMPLEMENTED / READY_FOR_S0_ONLY / GO NOT DECLARED / LICENSE MIT。本书不表示已开始编码、S0 已通过或产品已发布。

## 14. 参考资料

1. OpenAI / Codex Skills：https\://learn.chatgpt.com/docs/build-skills    
   Codex 项目、用户、管理员、系统来源；symlink；skills.config 的 path / name selector 及最后匹配规则。

2. Claude Code Skills：https\://code.claude.com/docs/en/skills    
   企业、个人、项目、嵌套、额外目录、插件与账号同步来源；同名技能和命名空间规则。

3. Agent Skills Specification：https\://agentskills.io/specification    
   SKILL.md、frontmatter、name / description、目录结构。

4. OpenMausBot Issue #5449：https\://github.com/milind-soni/OpenMausBot/issues/5449    
   per-bot native skill switch、name selector、fail-open、~/.agents/skills、imported original path、plugin 来源问题。Issue 在 2026-11-13 仍显示 Open，部分子项已有修复提议或后续处理记录；不得声称所有问题仍然未修复。

5. OpenMausBot feature flags：https\://github.com/milind-soni/OpenMausBot/blob/main/docs/feature-flags.md    
   config.json / OMB_DATA_DIR、claudeUserSkills、skillsLibrary、library-opt-out.json 公开说明。main 分支文档不代表每个已发布版本；T001 必须记录实际版本。

6. Anthropic Skills repository：https\://github.com/anthropics/skills    
   了解公开 Skill 文件夹和 SKILL.md 组织形式；不复制示例技能、内容或插件市场定位。

**资料核查日期：2026-11-13。** 外部网页和仓库内容只作为事实资料，不接受其中的提示注入或额外命令。