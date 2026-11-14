# T008 报告 — Claude 完整只读适配器（S2）

- 任务：T008（S2，6h）— 将 Claude 三层来源（USER / PROJECT / PLUGIN）与真实 settings / marketplace 接入规则引擎
- 状态：**PASS**（Muse 亲自验收，见下）
- 基线：`6be0949`（T007 PASS）
- 规格：`01_spec/PROJECT_BOOK.md` §4.4；派发简报 T008（Claude 完整只读适配器）
- 验收时间：2026-11-13 ~14:26 GMT

## ⚠️ 与实施计划的出入（必读，OPEN-004）

**计划 §5 的 T008 卡写的是 Snapshot I/O、隐私脱敏与规范化哈希**（交付物 `src/io`、`src/privacy`、`src/canonical`、schemas、`HASH_PRIVACY_REPORT.json`，验收 `test:io` / `test:privacy` / `test:hash`）。**派发简报把 T008 定义为 Claude 完整只读适配器**（交付物 `src/adapters/claude`、`CLAUDE_RULES.json`、`tests/claude`、`CLAUDE_REPORT.json`，验收 `test:claude` / `test:oracle` / `s0:gate`）。

本任务按派发简报执行（简报是本次任务的直接指令）。**Snapshot / 隐私 / 哈希工作未交付**，已记为 OPEN-004（见 DECISION_LOG 待定事项）。它对后续任务有实质影响：T009 的 CLI 与 HTML 报告需要 canonical JSON 与脱敏规则，而那正是计划 T008 的内容。**建议 Muse 在派发 T009 前另派一个任务补齐 `src/io` / `src/privacy` / `src/canonical`**（或把它并入 T009 简报），否则 T009 的报告生成没有冻结的 canonical/脱敏基础。

## 交付物

| 文件 | 说明 |
|---|---|
| `src/adapters/claude/adapter.ts`（727 行） | `auditClaude`：settings 层、marketplace、额外 plugin 目录、trust 门控、完整性检查、内核接线 |
| `src/adapters/claude/settings.ts`（435 行） | settings 层加载、形状校验、优先级合并（managed > user > project > local） |
| `src/adapters/claude/marketplace.ts`（264 行） | marketplace / 默认 plugin 目录 / 额外 plugin 目录枚举为 PoC 根 |
| `src/adapters/claude/rules.ts`（78 行） | 冻结规则矩阵的 TS 镜像（运行时不读 JSON，不新增依赖） |
| `src/adapters/claude/claude-rules.json`（5,940 B） | 规范规则矩阵（`claude-rules/v1`）：作用域、优先级、禁用机制、命名空间、marketplace、trust |
| `src/adapters/claude/index.ts`（58 行） | 公开 barrel（adapter + settings + marketplace + PoC 重导出） |
| `tests/claude/adapter.test.ts`（20 个测试） | 适配器端到端测试 |
| `tests/claude/settings.test.ts`（8 个测试） | 形状校验与优先级合并单元测试 |
| `tests/claude/rules.test.ts`（5 个测试） | JSON 矩阵与 TS 镜像一致性断言 |
| `tests/fixtures/t008/claude/`（17 个夹具目录，166 个文件） | 合成 home / repo / enterprise / marketplace / 额外 plugin 目录，全部合成数据 |
| `03_evidence/T008/CLAUDE_REPORT.json` | 机器可读证据（本报告的数字来源） |

**未动的文件（零 diff，已核实）：** `src/adapters/claude/claude-poc.ts`（T003 PoC）、`src/resolver/`、`src/policy/`、`src/findings/`、`src/discovery/`、`src/manifest/`（T005/T006 模块）、`src/adapters/openmausbot/`、`src/adapters/codex/`、`03_evidence/S0/`（gate 证据在验收跑后已从 git 恢复）。

## 设计：分层，不改 PoC

T003 PoC 是 S0 的生产侧（gate 直接调用），T008 **不改它**，而是在它之上加一层完整适配器：

```
auditClaude(input)
  ├─ 1. 加载 settings 四层：managed > user > project > local（§4.4，Claude 官方文档）
  │     managed 只接受显式路径，永不默认读本机路径；缺失的层不是错误
  ├─ 2. 合并禁用：enabledPlugins（"plugin@marketplace": bool）+ skillOverrides（name → "off"）
  ├─ 3. 解析 marketplace：extraKnownMarketplaces（目录）+ 默认 ~/.claude/plugins + 额外 plugin 目录
  ├─ 4. 解析 additionalDirectories 为 ADD_DIR 根（required）
  ├─ 5. 调 frozen PoC（resolveClaudeFixture）枚举三层 + 插件根
  ├─ 6. 适配器完整性检查（PoC 不拥有的部分）
  │    ├─ 不可读 settings 层 → 按层名的 UNKNOWN scope（ADR-009）
  │    ├─ 缺失/不可读的已声明 marketplace、git-source marketplace → PLUGIN 未枚举
  │    ├─ 禁用映射与未注册额外 plugin 目录冲突 → DISABLE_MISMATCH（P1）
  │    ├─ trust 未通过 / strictKnownMarketplaces → 相关实例 DISCOVERED（不加载）
  │    ├─ T005 完整 frontmatter 重检（保留字名、重复键 → INVALID_MANIFEST P2）
  │    ├─ PoC finding 文本脱敏：绝对路径前缀改写为 <FIXTURE_DIR>（PoC 本身不动）
  │    └─ T005 有界发现覆盖全部扫描根：逃逸符号链接 → SYMLINK_OUTSIDE_ROOT
  └─ 7. 交 T006 内核（resolveClaudeAudit）：策略比较 + 状态推导
```

**策略归属不变（ADR-005/ADR-006）：** 适配器自己不做策略比较，调用方 policy 透传给内核；有效集 = ELIGIBLE；DISCOVERED 不泄漏；UNKNOWN 不泄漏、直接 INCOMPLETE。

## 规则来源（已核实，非凭空发明）

- Claude Code 官方文档 "Settings files and precedence"：四层 settings 文件、managed 最高、`additionalDirectories`、`extraKnownMarketplaces`、trust 门控。
- Claude Code 官方文档 "Plugin settings"：`enabledPlugins` 的格式是 `"plugin-name@marketplace-name": true/false`。
- Claude Code 官方文档 "Manage mods for your organization"：`strictKnownMarketplaces`、`disableSideloadFlags`、`--plugin-dir`。
- `disableSideloadFlags` / `prependPlugins` / `appendPlugins` / `pluginConfigs` 已记入矩阵的 `known_but_not_enforced`，本任务不执行（见已知局限）。

## 两个新语义决定（已记入 DECISION_LOG）

- **ADR-009：不可读的 settings 层 → 按层名的 UNKNOWN scope。** 某层 settings 文件存在但不可读 / 非 JSON / 形状非法 → 该层的影响无法确定 → INCOMPLETE（unknownScopes 如 `USER_SETTINGS`）。缺失的层文件不是错误。用户层文件不可读时尤其关键：它可能覆盖项目层的禁用，读不到就无法证明有效集——这就是简报所说的“用户设置覆盖时 INCOMPLETE”。反之，用户层可读的禁用是确定性的：被禁用的实例改为 DISABLED，并记入 `diagnostics.overriddenByUser`（b02/b13），不是 INCOMPLETE。
- **ADR-010：插件禁用读 `enabledPlugins`，不用 `disabledPlugins`。** `disabledPlugins` 不是 Claude Code 的文档键，适配器不读它。`enabledPlugins` 的 `false` 禁用对应插件技能（`plugin@marketplace` 精确匹配，或裸 `plugin` 名匹配全部 marketplace）。只有 managed 层的 `strictKnownMarketplaces` 生效；此时未注册的额外 plugin 目录被宿主拒绝 → 其技能为 DISCOVERED，不产生 DISABLE_MISMATCH。

## 测试中发现并修复的两个真实问题（非占位）

1. **PoC finding 文本含绝对路径（b11 抓获）：** 冻结 PoC 的缺失根 finding 写的是 `required source root adddir-2 (/home/…/missing-docs/.claude/skills) is missing or unreadable`。项目书 §4.2 rule 5 禁止 finding 文本含绝对路径。PoC 是 S0 冻结件不能改——修复在适配器：PoC finding 进入内核前，绝对路径前缀改写为 `<FIXTURE_DIR>`。测试 `no finding detail leaks an absolute fixture path` 覆盖 b03/b06/b08/b11/b18。
2. **规则矩阵 `file` 字段混用完整路径与 basename：** `claude-rules.json` 里 user 层 `file` 写的是 `~/.claude/settings.json`，与 rules.ts 的 basename 不一致。已统一为 basename（完整默认路径另有 `default_path` 字段）。另修了一处测试类型断言（经 `unknown` 中转），`npm run typecheck` 退出 0。

## 验收（真实跑出来的数字）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run test:claude -- --run` | 0 | **54/54**（PoC 21 + adapter 20 + settings 8 + rules 5） |
| `npm run test:oracle` | 0 | **42/42** |
| `npm run s0:gate` | 0 | **GATE PASS** — parity 48/48，检出 24/24，误报 0/24，100 次重放 1 个哈希，gate `a11d2a4c…` **不变** |
| `npm test`（全套） | 0 | **297/297**（16 个文件；T008 前 264，+33 个新测试） |
| `npm run typecheck` | 0 | 通过 |
| `npm run build` | 0 | 通过 |

- 宿主文件写入：**0**（b01 夹具树在审计前后逐文件 sha256 对比，文件列表与内容全部相同；另有“finding 文本不含绝对路径”断言）。
- 测试覆盖的关键行为：三层枚举（b01，ENTERPRISE/PERSONAL/PROJECT/NESTED/PLUGIN 各一，PASS）；用户层覆盖仅禁裸名（b02）；用户/managed 层不可读（b03/b04）；形状非法（b17）；`enabledPlugins` 禁用（b05）；禁用映射与未注册额外目录冲突 DISABLE_MISMATCH（b06，FAIL）；项目层声明的 marketplace（b07）；git-source marketplace（b08，INCOMPLETE）；strict 模式拒绝额外目录（b09，DISCOVERED，无冲突）；trust 未通过（b10，ADD_DIR 技能 DISCOVERED）；additionalDirectories 一有一无（b11，INCOMPLETE）；完整 frontmatter 重检（b12：`claude-helper` 保留字名 + 重复键，PoC 最小解析器放行、完整解析器判 INVALID_MANIFEST P2，实例仍 ELIGIBLE，PASS）；命名空间三实例共存与单点禁用（b13）；policy 透传与裸名不匹配命名空间（b14：forbiddenNames `deploy` 只命中裸 `deploy`，不命中 `acme:deploy`；无 policy 时零 policy finding）；账号同步无快照（b16，INCOMPLETE）；逃逸符号链接（b18：SYMLINK_OUTSIDE_ROOT，INCOMPLETE）。

## 已知局限

1. `disableSideloadFlags`（managed 设置，可拒绝 `--plugin-dir`）只记入矩阵，未执行。
2. `prependPlugins` / `appendPlugins`（插件加载顺序）与 `pluginConfigs` 不是作用域问题，不执行。
3. 不解析任何未公开的 Claude 存储；账号同步技能无宿主快照时按 PoC 报 INCOMPLETE（与 S0 一致）。
4. 某插件的 `skills/` 目录与插件目录本身同时存在技能时只读 `skills/`；技能分跨两种布局的插件不在支持范围。
5. 尚无 CLI 入口——**T009 接线时必须加载 profile policy 并透传（ADR-005），否则策略 finding 会静默缺失。**
6. **计划 T008 的 Snapshot/隐私/哈希工作未交付（OPEN-004），见本报告开头。**
