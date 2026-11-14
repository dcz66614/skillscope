# T002_REPORT.md — Codex 技能来源解析 PoC

- TASK_ID: T002（S0）
- BASE_COMMIT: b0d3d4f（T001 PASS）
- 完成时间 (UTC)：2026-11-13 ~13:10
- 状态：PASS（两条验收命令真实退出码均为 0；另附 typecheck / build / npm ci / 全量测试全部通过）

## 验收命令与真实结果

| # | 命令 | 退出码 | 关键输出 |
|---|---|---:|---|
| 1 | `npm run test:codex -- --run` | 0 | vitest 5.1.0；1 个测试文件，11/11 通过（8 个 golden fixture + 3 个单元测试，288ms） |
| 2 | `npm run test:oracle` | 0 | `python3 -m unittest discover -s oracle/tests`；Ran 11 tests，OK（0.001s） |

附加验证（非验收命令，但证明无回归）：

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm test` | 0 | 4 个测试文件，47/47 通过（contracts 10 + codex 11 + claude 13 + openmausbot 13；T003 的测试也通过） |
| `npm run typecheck` | 0 | `tsc --noEmit` 无报错 |
| `npm run build` | 0 | 产出 `dist/adapters/codex/codex-poc.js` |
| `npm ci` | 0 | lockfile 与安装后一致 |

注意：本任务中段 `npm run typecheck` / `npm run build` 曾因并行施工的 T003 文件
`src/adapters/openmausbot/openmausbot-poc.ts:155` 类型错误而失败（`canonicalPathHash`
不存在于 `ScannedSkill`）；那是 T003 进行中的代码，不是 T002 的问题。T002 模块
当时已用单文件 `tsc` 验证可独立编译。任务结束时 T003 已修复，全量 typecheck /
build 均通过。

## 交付文件

| 文件 | 字节 | SHA-256 前 16 位 | 说明 |
|---|---:|---|---|
| src/adapters/codex/codex-poc.ts | 21,902 | bcd3197c4e4a978f | Codex PoC 实现（§4.3 规则） |
| src/adapters/codex/README.md | 5,655 | 83e06802dff8b4b1 | 规则来源说明、设计取舍、TOML 选型 |
| tests/codex/codex-poc.test.ts | 8,885 | c01388f1c2a47b9b | 8 golden + 3 单元测试 |
| tests/fixtures/s0/codex/（8 个 case） | 20,692（52 个文件） | — | layout + input.json + expected.json；另有 1 个符号链接（c06 alpha-alias） |
| package.json | 1,116 | 76fea7d6d9605734 | 新增 `dependencies: {smol-toml: 1.9.1}`（精确版本）；无 license 字段 |
| package-lock.json | 40,992 | 8952c4515f3d631f | lockfileVersion 3；72 个包（T001 为 71 个） |
| 03_evidence/T002/T002_REPORT.md | — | — | 本报告 |
| 03_evidence/T002/CODEX_POC_REPORT.json | — | — | 机器可读的逐 case 结果摘要 |

未触碰的文件：真实 Codex HOME、真实 `~/.codex/config.toml`、任何凭证、T003 的
claude/openmausbot 文件、`00_control/`（DECISION_LOG.md、PROJECT_STATE.json、
TASK_BOARD.csv 未改——与并行施工的 T003 共享工作树，避免冲突；ADR-003 见下，
请协调员合并进 DECISION_LOG.md）。

## 8 个 fixture 逐 case 结果

| Case | 种类 | 审计状态 | 技能数 | Findings | 规则要点 |
|---|---|---|---|---:|---|---|
| c01-repo-discovery | control | PASS | 3 | 0 | cwd=a/b 走到 repo 根；outside/ 的 secret 未发现 |
| c02-user-admin-system | control | PASS | 4 | 0 | USER / ADMIN / SYSTEM 分类正确 |
| c03-path-selector | control | PASS | 2 | 0 | path selector 只禁用 1 个实例 |
| c04-name-selector-blast | planted | FAIL | 2 | 1 | name selector 禁用两个同名实例 + NAME_SELECTOR_BLAST_RADIUS（affectedCount 2） |
| c05-last-match-wins | control | PASS | 2 | 0 | 后一条 path 记录覆盖前一条 |
| c06-symlink-alias | control | PASS | 2 | 0 | alpha 与 alpha-alias 合并为 1 个实例，alias 已记录 |
| c07-bundled-disabled | control | PASS | 2 | 0 | `[skills.bundled].enabled=false` 禁用系统技能 |
| c08-unreadable-config | planted | INCOMPLETE | 2 | 3 | 非法 TOML → fail closed；SYSTEM + PLUGIN 未枚举 |

通过标准对照（实施计划 §5 T002）：8/8 fixture 通过；项目目录沿 CWD 到 repo root
发现范围正确；用户 / 管理员 / 系统来源分类正确；path selector 只匹配单实例；
name selector 命中所有同名实例；多条匹配按最后匹配项处理；symlink 同目标保留
alias 而不重复建实例；未知来源不默认为不存在。全部满足。

## Golden review（expected.json 逐字段人工核实）

expected.json 由 PoC 生成后逐字段人工核对，非盲目冻结。核对结论：

- **c01**：release（根）、deploy（a/）、notify（a/b/）三技能齐全；outside/ 的
  secret 不在结果中；全部 ELIGIBLE；覆盖 5/5。正确。
- **c02**：personal（USER）、org-wide（ADMIN）、pdf + docx（SYSTEM）分类正确；
  SYSTEM 按字母序 docx 在前；覆盖 5/5。正确。
- **c03**：根 deploy ELIGIBLE、嵌套 a/deploy DISABLED；两个同名实例身份不同
  （canonicalPathHash 不同）；无 blast finding。正确。
- **c04**：两个 deploy 均为 DISABLED；NAME_SELECTOR_BLAST_RADIUS P1，
  affectedCount=2；审计状态 FAIL。正确。
- **c05**：根 deploy 先禁后启 → ELIGIBLE（last wins）；嵌套 deploy 未触动；
  无 findings；PASS。正确。
- **c06**：alpha 唯一实例，canonical 为真实路径，aliases 含
  `.agents/skills/alpha-alias/SKILL.md`；beta 独立；共 2 个技能。正确。
- **c07**：release ELIGIBLE；pdf SYSTEM DISABLED；PASS。正确。
- **c08**：release + personal 均为 UNKNOWN（fail closed）；unknownSources
  [SYSTEM, PLUGIN]；FAIL_OPEN_CONFIG + 2 × SOURCE_NOT_ENUMERATED；
  覆盖 3/5；configReadable=false；INCOMPLETE。正确。
- **哈希独立抽查**（sha256sum 直接算文件，与 expected.json 对照）：
  release SKILL.md `c9671453…`、alpha `d7a48111…`、personal `894192a4…`、
  pdf 内容 `8113e55d…`、canonical path `c23835b4…` / `5d2792da…` 全部一致。
- **无绝对路径**：grep 确认 8 份 expected.json 均不含 `/home/hatch` 等机器路径。

## 发现并修复的真实问题

**测试夹具复制会破坏相对符号链接（harness bug，已修复，非 PoC 缺陷）。**
初版测试把 layout 复制到临时目录再跑 PoC，结果 c06 出现 3 个技能且
expected.json 含绝对路径。排查确认：Node 的 `fs.cp({dereference: false})`
会把相对符号链接的目标改写为绝对路径（指向原树），导致临时副本里的
alpha-alias 指向原 fixture 的 alpha 目录——两个路径解析到不同物理文件，
PoC 正确地报告了两个实例。修复：测试直接对已提交的 layout 运行 PoC
（PoC 严格只读，fixture 不会被修改），只把 config.toml 复制到临时文件以
解析 `__CASE_DIR__` 占位符。修复后 c06 为 2 个技能，expected.json 无绝对
路径。此教训已写入测试文件注释。

## 决策记录（ADR-003，待协调员合并进 00_control/DECISION_LOG.md）

- **ADR-003（OPEN-001 关闭）**：TOML 解析器选用 `smol-toml` **1.9.1**（精确版本，
  integrity `sha512-j7WyPdf0CJoutMzMoPLF/bVXHtKZIT9Rb4eGeEbWw8X2t5oirjPgpL+OpaENZrILYaXqYwnVH+qgUwVbl+pUJQ==`），
  BSD-3-Clause，零依赖（lockfile 核实无 `dependencies` 字段）。备选 `@ltd/j-toml`
  （较大）与手写子集解析器（可能掩盖配置错误）均被否决。Node 24.22.1 标准库无
  TOML 解析器（T001 已实测）。
- **frontmatter 最小解析**：PoC 只提取 `name:` 标量，缺失时回退文件夹名；完整
  manifest 解析与 INVALID 状态归 T005，不为 PoC 引入 YAML 依赖。
- **expected.json 生成方式**：PoC 生成 + 逐字段人工核对 + 独立哈希抽查后冻结；
  T004 的独立 Python Oracle 将对同一输入重新推导期望值，形成第二重校验。

## 已知局限

- `path` selector 命中 0 个实例时静默忽略（无 finding）；T006 可补 finding。
- name-selector 排序规则由单元测试覆盖（后条目覆盖前条目），未单设 golden
  fixture（同名实例必然触发 blast finding，不适合做干净 control）。
- 符号链接环 / 逃逸目标：`realpathSync` 报错时直接抛出（loud fail），有界处理归 T005。
- 插件技能只枚举为 ELIGIBLE，无禁用路径（#5449 指出 `turn/start` 无
  `disabledPluginIds`）；禁用路径归 T007。
- SYSTEM / PLUGIN 内容哈希来自合成 inventory 描述，非真实 SKILL.md 文件；
  代码与 README 中已注明。

## 下一步

NEXT_TASK: T004（Python Reference Oracle + S0 Gate，48 例）。T002 的 8 个 Codex
fixture 可直接复用为 T004 的 Codex 16 例中的 8 例（需再补 8 例：按实施计划
§6.1，植入偏差须覆盖 path selector 错误匹配、last matching rule 顺序错误等）。
T003（Claude + OpenMausBot PoC）并行施工中，结束时全量测试 47/47 已通过。
