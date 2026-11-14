# T007 报告 — OpenMausBot 完整只读适配器（S2）

- 任务：T007（S2，6h）— 将 OpenMausBot 公开配置和版本化 Bot inventory snapshot 接入规则引擎
- 状态：**PASS**（Muse 亲自验收，见下）
- 基线：`467347f`（T006 PASS）
- 规格：`01_spec/PROJECT_BOOK.md` §4.5；`01_spec/IMPLEMENTATION_PLAN.md` §5 T007、§2.1 文件所有权
- 验收时间：2026-11-13 ~14:13 GMT

## 交付物

| 文件 | 说明 |
|---|---|
| `src/adapters/openmausbot/adapter.ts`（525 行） | `auditOpenMausBot`：data-dir 解析、snapshot 获取、完整性检查、内核接线 |
| `src/adapters/openmausbot/snapshot.ts`（275 行） | 版本化 snapshot 合同校验 + 文件加载（无新增运行时依赖） |
| `src/adapters/openmausbot/openmausbot-snapshot-v1.json`（4,411 B） | snapshot v1 的规范 JSON Schema（`$id: openmausbot-snapshot/v1`） |
| `src/adapters/openmausbot/index.ts`（36 行） | 公开 barrel（adapter + snapshot + PoC 重导出） |
| `tests/openmausbot/adapter.test.ts`（23 个测试） | 适配器端到端测试 |
| `tests/openmausbot/snapshot.test.ts`（17 个测试） | 合同校验器测试 + schema 一致性断言 |
| `tests/fixtures/t007/openmausbot/`（13 个夹具目录，58 个文件） | 合成 home / data dir / snapshot / 技能目录，全部合成数据 |
| `03_evidence/T007/OPENMAUSBOT_REPORT.json` | 机器可读证据（本报告的数字来源） |

**未动的文件（零 diff，已核实）：** `src/adapters/openmausbot/openmausbot-poc.ts`（T003 PoC）、`src/resolver/`、`src/policy/`、`src/findings/`、`src/discovery/`、`src/manifest/`（T005/T006 模块）、`03_evidence/S0/`（gate 证据在验收跑后已从 git 恢复）。

## 设计：分层，不改 PoC

T003 PoC 是 S0 的生产侧（gate 直接调用），T007 **不改它**，而是在它之上加一层完整适配器：

```
auditOpenMausBot(input)
  ├─ 1. 解析 dataDir：显式 dataDir > OMB_DATA_DIR > <home>/.openmausbot（§4.5）
  ├─ 2. 获取 snapshot：inline > snapshotPath 文件 > 缺失（合同校验见 snapshot.ts）
  ├─ 3. 调 frozen PoC（resolveOpenMausBotFixture）读 config / opt-out / 清单
  ├─ 4. 适配器完整性检查（PoC 不拥有的部分）
  │    ├─ 缺失的 per-bot 清单（requireLists，默认 assigned/imported/plugin）
  │    ├─ 无 pluginId 的插件技能 → UNKNOWN + SOURCE_NOT_ENUMERATED
  │    ├─ 清单技能目录存在但无可读 SKILL.md → SOURCE_NOT_ENUMERATED
  │    ├─ T005 完整 frontmatter 重检（保留字名、重复键 → INVALID_MANIFEST P2）
  │    └─ scanRoots 与 snapshot 对账（T005 有界发现：磁盘有、清单无 → SOURCE_NOT_ENUMERATED）
  └─ 5. 交 T006 内核（resolveOpenMausBotAudit）：策略比较 + 状态推导
```

**策略归属不变（ADR-005/ADR-006）：** 适配器自己不做策略比较，调用方 policy 透传给内核；有效集 = ELIGIBLE；DISCOVERED 不泄漏；UNKNOWN 不泄漏、直接 INCOMPLETE。

## 两个新语义决定（已记入 DECISION_LOG）

- **ADR-007：完整适配器要求版本化 snapshot。** 无 snapshot、snapshot 文件缺失/非 JSON/形状非法 → INCOMPLETE（SOURCE_NOT_ENUMERATED，unknownScopes `[SNAPSHOT]`）。PoC 把缺失 snapshot 当空清单，完整适配器不继承这一默认——没有清单就无法证明清单完整。未知版本仍走 PoC 的版本门（同样 INCOMPLETE）。
- **ADR-008：无 pluginId 的插件技能是 UNKNOWN / INCOMPLETE。** `disabledPluginIds` 永远覆盖不了它（#5449 item 8 的核心问题）；静默当作可开关是错的。实例状态改为 UNKNOWN，使其退出有效集、失败关闭为 INCOMPLETE，而不是在无 policy 时悄悄 PASS。

其余规则：`emptyLists` 用于声明某 per-bot 清单为空——缺席≠空；`scanRoots` 对账只覆盖调用方声明的根；finding 文本不含绝对路径（§4.2 rule 5）。

## 插件禁用路径（T006 遗留，本任务接管）

- `disabledPluginIds` 命中的插件技能 → DISABLED，内核不报 SCOPE_LEAK（a08：一个被禁用的 + 一个未被禁用的插件技能，policy 禁 PLUGIN → 恰好 1 条 SCOPE_LEAK，只指向未被禁用的那个，FAIL）。
- 无 `pluginId` 的插件技能 → 上述 ADR-008（a07：sites 为 UNKNOWN，INCOMPLETE）。

## 验收（真实跑出来的数字）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run test:openmausbot -- --run` | 0 | **61/61**（PoC 21 + snapshot 17 + adapter 23） |
| `npm run test:oracle` | 0 | **42/42** |
| `npm run s0:gate` | 0 | **GATE PASS** — parity 48/48，检出 24/24，误报 0/24，100 次重放 1 个哈希，gate `a11d2a4c…` **不变** |
| `npm test`（全套） | 0 | **264/264**（13 个文件；T007 前 224，+40 个新测试） |
| `npm run typecheck` | 0 | 通过 |
| `npm run build` | 0 | 通过 |

- 宿主文件写入：**0**（a01 夹具树在审计前后逐文件 sha256 对比，文件列表与内容全部相同；另有“finding 文本不含绝对路径”断言）。
- 测试覆盖的关键行为：默认 home / `OMB_DATA_DIR` / 显式 dataDir 三级优先级（a01/a02/a03）；snapshot 缺失、未知版本、形状非法、文件 JSON 非法、文件缺失（a04/a05/a14）；缺失清单与 `emptyLists` 显式空（a06 变体）；无 pluginId（a07）；禁用路径端到端（a08）；磁盘对账 ghost 技能与缺失扫描根（a09）；完整 frontmatter 重检（a10：`claude-helper` 保留字名 + 重复键，PoC 最小解析器放行、完整解析器判 INVALID_MANIFEST P2，实例仍 ELIGIBLE，PASS）；损坏 config / opt-out 的 fail-open（a11/a12）；policy 透传与 ADR-006 DISCOVERED 不泄漏（a15）；无 SKILL.md 的清单技能目录（a16）。

## 已知局限

1. 不解析任何未公开的 OpenMausBot 存储（不猜 SQLite schema、不调私有 API）——清单只存在于未公开存储的 Bot 会因 snapshot 要求而报 INCOMPLETE，不会悄悄覆盖。
2. 对账只覆盖调用方声明的 `scanRoots`；没声明的技能根不扫描（与 PoC 的 `loadableRoots` 边界一致）。
3. 完整 frontmatter 重检每技能多一次 SKILL.md 重读；不改 PoC 已判 INVALID 的技能的结论。
4. `DUPLICATE_CONTENT` / `SAME_NAME_COLLISION` 仍只来自 PoC；适配器不新增跨实例内容分析。
5. 尚无 CLI 入口——**T009 接线时必须加载 profile policy 并透传（ADR-005），否则策略 finding 会静默缺失。**
