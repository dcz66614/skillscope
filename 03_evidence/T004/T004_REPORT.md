# T004 验收报告 — Python Reference Oracle、48 例 S0 Gate 与确定性重放

- TASK_ID: T004（S0）
- STATUS: PASS
- BASE_COMMIT: 5175eb8（P023: merge ADR-003 into DECISION_LOG, close OPEN-001；含 T002 aff08cb + T003 2716487/aa2a810）
- OUTPUT_COMMIT: 97492fa
- SPEC_VERSION: 1.0.0（PROJECT_BOOK.md 31,870 B，sha256 `73b9baa7…`；IMPLEMENTATION_PLAN.md 34,795 B，sha256 `f9fab1b1…`）
- 完成时间 (UTC)：2026-11-13 ~13:45
- 规则依据：PROJECT_BOOK.md §4.2–§4.5、§5.2、§10.1；IMPLEMENTATION_PLAN.md §4.4、§5 T004、§6、§7.2

## 验收命令与真实结果

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `npm run s0:gate` | 0 | S0 gate PASS；48 fixtures（control 24，planted 24）；production/oracle parity 48/48；golden match production 48/48，oracle 48/48；detected 24/24；false alarms 0；incomplete sources 11 across 10 fixtures；external requests 0；source writes 0；replay 100 runs，1 unique gate hash；gate_sha256 `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca` |
| 2 | `npm run test:oracle` | 0 | `python3 -m unittest discover -s oracle/tests`；Ran 42 tests，OK（11 个 T001 canonical + 31 个新增 resolver 测试） |
| 3 | `npm run s0:repeat -- --count 100` | 0 | s0:repeat PASS；100 runs，1 unique gate hash：`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`（与 gate 的哈希一致） |

附加验证（非验收命令，但证明无回归）：

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm test` | 0 | 4 个测试文件，71/71 通过（contracts 10 + codex 19 + claude 21 + openmausbot 21；原 47/47，新增 24 个 fixture 测试） |
| `npm run typecheck` | 0 | `tsc --noEmit` 无报错 |
| `npm run build` | 0 | dist 构建成功 |

## 交付文件

| 文件 | 字节 | SHA-256 前 16 位 | 说明 |
|---|---|---|---|
| oracle/python/reference_resolver.py | 59,174 | bf57c409962c61d0 | 独立 Python Reference Oracle：Codex / Claude / OpenMausBot 三解析器 + canonical 化 + CLI |
| oracle/tests/test_reference_resolver.py | 15,904 | f04a77d65729dbd5 | Oracle 单元测试（31 个：frontmatter、TOML、selector、scope、fail-closed、canonical 化、48 例汇总） |
| tests/fixtures/s0/manifest.json | 9,844 | 0fb2041048f12423 | 48 例 manifest（engine / kind / defect，8+8 每宿主） |
| tests/fixtures/s0/（24 个新 fixture） | 123 个文件 | — | codex c09–c16、claude c09–c16、openmausbot o09–o16：layout/profile/input + expected.json |
| tests/golden/s0/expected.json | 83,283 | 2dd6071072cddd0b | S0 golden（48 例 canonical 结果，从 Oracle 输出冻结，见 §Golden review） |
| scripts/s0-canonical.mjs | 10,388 | 6b3a94654b33e38a | 生产侧 canonical 化 + canonical JSON / SHA-256（独立实现，与 Oracle 同定义） |
| scripts/s0-run.mjs | 7,775 | 6c5733bed5aeebba | fixture 运行器（dist 适配器 + canonical 化）、fixture 树哈希、100 次重放 |
| scripts/s0-gate.mjs | 11,883 | 9706816fb3575a23 | S0 门禁主脚本（build → 生产运行 → Oracle 对照 → golden 对照 → 写检测 → 网络扫描 → 重放） |
| scripts/repeat-hash.mjs | 1,859 | cdb458a0da1db59d | 确定性重放脚本（--count，默认 100） |
| 03_evidence/S0/S0_GATE.json | 83,954 | 64c57f1a1af0a2e6 | Gate 输出（§6.2 全部字段 + 48 例 canonical 结果） |
| 03_evidence/S0/ORACLE_PARITY.json | 4,565 | 99415eb6abfe6c64 | 逐 fixture parity（48/48，0 mismatch） |
| 03_evidence/S0/REPEAT_HASH.json | 7,569 | 4e926d51dd5ffa7b | 100 次重放哈希清单（100 个相同值） |
| 03_evidence/S0/S0_GATE.log | 462 | 841294b4d3fc2f85 | Gate 文本摘要 |
| 03_evidence/T004/T004_REPORT.md | — | — | 本报告 |
| tests/codex/codex-poc.test.ts（+8 行） | — | — | CASE_IDS 扩展至 c09–c16 |
| tests/claude/claude-poc.test.ts（+8 行） | — | — | fixture 列表扩展至 c09–c16 |
| tests/openmausbot/openmausbot-poc.test.ts（+8 行） | — | — | fixture 列表扩展至 o09–o16 |

未触碰的文件：`src/`（全部生产适配器与 contracts）、`01_spec/`、`00_control/`、T002/T003 的已有 fixture 与 expected.json、package.json / package-lock.json、真实宿主配置、任何凭证。

## 48 例构成（与实施计划 §6.1 对照）

| 宿主 | 正常控制 | 植入偏差 | 合计 |
|---|---:|---:|---:|
| Codex | 8（c01、c02、c03、c05、c06、c07、c09、c10） | 8（c04、c08、c11、c12、c13、c14、c15、c16） | 16 |
| Claude Code | 8（c01、c02、c03、c04、c09、c10、c11、c12） | 8（c05、c06、c07、c08、c13、c14、c15、c16） | 16 |
| OpenMausBot | 8（o01、o02、o03、o04、o09、o10、o11、o12） | 8（o05、o06、o07、o08、o13、o14、o15、o16） | 16 |
| **总计** | **24** | **24** | **48** |

注意：T002 实际交付是 Codex 6 控制 + 2 植入（不是任务简报所说的 4+4），因此本次补 2 控制 + 6 植入才达到 8+8；Claude 与 OpenMausBot 各补 4 控制 + 4 植入。

§6.1 植入偏差覆盖：同名不同路径 + name selector blast radius（codex c04/c14/c15、claude c05/c16、omb o07）；path selector 错误匹配（codex c16，见下）；last matching rule 顺序错误（codex c15）；Claude project / personal / nested 作用域误判（claude c07/c13，及 c02/c09 共存对照）；plugin namespace 被压平（claude c14）；OpenMausBot claudeUserSkills / skillsLibrary 开关误判（omb o09/o12 关→DISCOVERED，o02 开对照）；imported original path 仍 active（omb o06）；opt-out / choices 文件损坏后 fail-open（omb o05、o15）。

## Canonical 输出定义（生产与 Oracle 的共同比较面）

Claude / OpenMausBot 适配器的原生结果含有绝对路径派生值（`canonicalPathHash` 是绝对 realpath 的 SHA，finding detail 含绝对路径），跨机器不稳定，因此 S0 比较面不是原生结果，而是 T004 定义的 canonical 结果。生产侧（scripts/s0-canonical.mjs）与 Oracle 侧（oracle/python/reference_resolver.py）各自独立实现同一定义，逐字段比较，无忽略字段：

- 实例身份 =（sourceRootId，fixture 相对的 canonicalPath）+ contentSha256；原生 instanceId / canonicalPathHash / engine 不进入比较面（前两者是 canonicalPath 的派生值，engine 由 fixture_id 隐含）。
- canonicalPath：文件型技能为 fixture 相对的 realpath（POSIX）；虚拟技能沿用适配器自身的合成描述符（codex `bundled/<name>/SKILL.md`、`plugins/<id>/<name>/SKILL.md`；claude account-sync `snapshot/<name>/SKILL.md`）。
- finding detail 中的绝对 fixture 目录替换为 `<FIXTURE_DIR>`；finding instanceIds 为 canonical 实例键 `<sourceRootId>:<relativePath>`（已排序）；finding status 沿用 Codex 原生值，Claude/OpenMausBot 按 `SOURCE_NOT_ENUMERATED → UNKNOWN、其余 → CONFIRMED` 推导（与 Codex 对同一 finding 的约定一致）。
- 实例按（sourceRootId，relativePath，logicalName）排序；finding 按（id，sourceScope，detail）排序；unknownScopes 按字母序。
- manifestName 仅在适配器报告时出现；affectedCount 仅 Codex blast radius 出现；aliases 沿用原生值（codex 报告，claude/omb PoC 不报告故为 []）。
- gate_sha256 = SHA-256（canonical JSON：UTF-8、LF、NFC、键排序、紧凑分隔）of `{seed, results}`；复用 T001 的 oracle/python/canonical.py 定义，TypeScript 侧独立实现。

## 判定定义（与 §6.2/§6.3 对照）

- 控制误报：控制 fixture 的实际状态非 PASS，或含任一 P1 finding。24 个控制全部 PASS 且无 P1（P2 finding 仅为 conformant 记录：claude c02/c09 同名共存、c12 重复内容——P2 不翻转 PASS，见 §5.2）。
- 植入检出：植入 fixture 的实际结果与冻结 golden 逐字段一致，且 golden 期望含偏差标记（finding、或任一实例状态非 ELIGIBLE、或 unknownScopes 非空）。24 个植入全部检出。
- incomplete_source_count = 全部 fixture 的 unknownScopes 长度之和 = 11（codex c08:2 + c11/c12/c13 各 1；claude c06/c15 各 1；omb o05/o13/o14/o15 各 1）；incomplete fixture 数 = 10。
- 外部请求 0：gate 对 `src/` 与 `scripts/` 做静态扫描（`node:http/https/net` 导入与 `fetch(` 调用），0 命中；适配器只用 node:fs / node:crypto / node:path 与 smol-toml。
- 源目录写操作 0：gate 在运行前后对整个 fixture 树做文件哈希（含符号链接目标）比对，0 变化。唯一临时文件是 Codex config 的 `__CASE_DIR__` 占位符副本，写在 os.tmpdir() 并删除。

## Golden review（48 例逐项人工核实）

Golden 由 Oracle 输出冻结（`/tmp/freeze_golden.py`，非生产输出），冻结前逐项核实：

- 24 个已有 fixture：Oracle canonical 结果与 T002/T003 手工推导的 expected.json 逐字段对照（codex 全字段；claude/omb 约简字段 + coverage + flags）——24/24 一致（含 c06 symlink alias 合并、o06 导入原始路径实例、c08 三 finding 等细节；内容哈希另做 sha256sum 抽查，3/3 一致）。
- 24 个新 fixture：逐项对照 fixture 设计（见下表）；另做 3 个内容哈希 sha256sum 抽查，全部一致；canonical 输出全文 grep 确认不含任何绝对路径（0 命中）。

| Fixture | 种类 | 状态 | 核实结论 |
|---|---|---|---|
| codex/c09-name-selector-single | control | PASS | personal 单实例被 name selector 禁用，无 blast finding |
| codex/c10-same-name-coexist | control | PASS | 三来源同名 deploy 各为独立 ELIGIBLE 实例 |
| codex/c11-missing-user-source | planted | INCOMPLETE | home_root 不存在 → USER SOURCE_NOT_ENUMERATED，覆盖 4/5 |
| codex/c12-missing-system-inventory | planted | INCOMPLETE | bundled_file 缺失 → SYSTEM 未枚举，覆盖 4/5 |
| codex/c13-missing-plugin-inventory | planted | INCOMPLETE | plugins_file 缺失 → PLUGIN 未枚举，覆盖 4/5 |
| codex/c14-name-blast-three-scopes | planted | FAIL | 三来源 deploy 全 DISABLED，blast affectedCount=3 |
| codex/c15-mixed-name-path-order | planted | FAIL | name 禁用两人后 path 重新启用根 deploy；嵌套仍 DISABLED；blast 2 |
| codex/c16-path-selector-wrong-target | planted | PASS | path 禁用根 deploy（操作者本意是嵌套副本），嵌套仍 ELIGIBLE；偏差标记为 DISABLED/ELIGIBLE 格局 |
| claude/c09-enterprise-personal-same-name | control | PASS | ENTERPRISE+PERSONAL 同名共存，SAME_NAME_COLLISION P2 |
| claude/c10-plugin-override-scoped | control | PASS | `acme:deploy` off 只禁用插件实例，裸 deploy 不受影响 |
| claude/c11-adddir-unvisited-nested | control | PASS | 未访问 nested 不发现、不算未知；覆盖 2/2 |
| claude/c12-duplicate-content-p2 | control | PASS | 两文件字节相同 → DUPLICATE_CONTENT + SAME_NAME_COLLISION，均为 P2 |
| claude/c13-enterprise-scope-leak | planted | FAIL | 政策禁 ENTERPRISE，ent-admin 在有效集 → SCOPE_LEAK |
| claude/c14-plugin-namespace-flattened | planted | PASS | 裸 `deploy` off 不触及 `acme:deploy`；压平实现会误禁两者，gate 可捕获 |
| claude/c15-adddir-missing-required | planted | INCOMPLETE | ADD_DIR 缺失 → SOURCE_NOT_ENUMERATED，覆盖 1/2 |
| claude/c16-override-blast-three-scopes | planted | FAIL | 三来源 deploy 全 DISABLED，blast + collision |
| omb/o09-library-off-discovered | control | PASS | skillsLibrary 关 → every-docs DISCOVERED，release ELIGIBLE |
| omb/o10-disabled-plugin-ids | control | PASS | disabledPluginIds 关掉插件技能，release 不受影响 |
| omb/o11-optout-empty-list | control | PASS | opt-out 空数组 → 无 opt-out，library 技能 ELIGIBLE |
| omb/o12-user-skills-off-discovered | control | PASS | claudeUserSkills 关 → my-notes DISCOVERED |
| omb/o13-unknown-snapshot-version | planted | INCOMPLETE | snapshot v99 → 库存不可信，0 实例，SNAPSHOT 未知 |
| omb/o14-missing-snapshot-skill-dir | planted | INCOMPLETE | ghost 技能目录缺失 → BOT_ASSIGNED 未枚举，release 仍在 |
| omb/o15-invalid-config-json | planted | INCOMPLETE | config.json 无效 → FAIL_OPEN_CONFIG；适配器按默认 flags 继续（library 技能 DISCOVERED），状态仍为 INCOMPLETE |
| omb/o16-shared-library-scope-leak | planted | FAIL | 政策禁 SHARED_LIBRARY，every-docs 在有效集 → SCOPE_LEAK |

关于 c16 与 claude c14（PASS 状态的植入偏差）：其偏差不在 finding 里，而在有效集本身——配置写错目标 / 命名空间被压平时，正确解析器必须如实报告真实有效集（哪个实例被禁用、哪个仍在），而 golden 正是冻结了这个真实有效集；若解析器按名匹配或压平命名空间，结果会偏离 golden，gate 即失败。这一界定已写入 manifest 的 defect 分类与 gate 的检出定义（见 §判定定义）。

## 施工中发现并修复的真实问题

1. **c15/c16 的 cwd 写错导致嵌套技能未被发现。** 初版 input.json 的 cwd 为 `layout/repo`，Codex 发现规则只从 cwd 向上走到 repo 根，不向下扫描子目录，因此 `repo/a/` 的 deploy 从未进入结果（Oracle 输出只有 1 个实例、无 blast finding）。核对 c03/c04/c05 的既有 fixture 后确认 cwd 应为 `layout/repo/a`；修正 input.json（并同步修正生成脚本），重跑后 c15/c16 与设计一致。此为 fixture 设计错误，非适配器缺陷。
2. **o15 的预期修正。** 初版设计误以为无效 config 会导致 0 实例；重读 openmausbot-poc.ts 确认适配器在 config 无效时并不提前返回，而是按默认 flags（两开关关）继续解析 snapshot：every-docs 为 DISCOVERED、release 为 ELIGIBLE，状态 INCOMPLETE。Oracle 与生产一致，expected 按适配器行为修正。
3. **TypeScript canonical 化的空字符串 scrub 缺陷（自查发现，未进入任何输出）。** 初版 `canonicalizeCodex` 向 scrub 传空 fixtureDir，`String.split("")` 会把 detail 拆成字符；修复为传真实 fixtureDir（Codex detail 本就不含绝对路径，scrub 为无操作）并加空串守卫。

## 已知局限

- Oracle 与生产共享 canonical 输出定义（各自独立实现，gate 做逐字段比较）；定义本身的正确性由项目书 §4/§5.2 与本报告的逐项核实支撑，T013 独立审查时应复核。
- Oracle 的 TOML 解析用 Python 标准库 tomllib，生产用 smol-toml 1.9.1；48 例 fixture 的 TOML 子集（`[[skills.config]]`、布尔值、字符串）两者语义一致， exotic TOML 边缘差异不在 S0 范围内。
- Symlink 环 / 逃逸目标：Python `os.path.realpath` 不抛错而 Node `realpathSync` 会抛，行为在环上不同；48 例无环 fixture，归 T005 处理。
- Node `localeCompare` 与 Python 排序在 finding 排序上对 ASCII 字符串一致（48 例 parity 48/48 已证实）；非 ASCII detail 排序差异若出现，gate 会直接报 parity mismatch，不会静默通过。
- Claude/OMB 原生结果中的 `canonicalPathHash` / `instanceId` 不在 canonical 比较面内（见 §Canonical 输出定义）；其正确性由 canonicalPath + contentSha256 的逐字段一致间接保证。
- vitest 的 OpenMausBot 单元测试会在 fixture 目录内建临时目录（data-invalid-config、data-no-optout）并删除；gate 本身不跑 vitest，gate 的写检测只覆盖 gate 自身的运行。

## 交接

- TASK_ID: T004
- STATUS: PASS
- BASE_COMMIT: 5175eb8
- OUTPUT_COMMIT: 97492fa
- INPUT_SHA256: PROJECT_BOOK.md `73b9baa7…`；IMPLEMENTATION_PLAN.md `f9fab1b1…`
- OUTPUT_FILES: 见 §交付文件
- MODIFIED_FILES: oracle/python/reference_resolver.py；tests/codex/codex-poc.test.ts；tests/claude/claude-poc.test.ts；tests/openmausbot/openmausbot-poc.test.ts
- FORBIDDEN_FILES_TOUCHED: 无（未碰 src/、01_spec/、00_control/、已有 fixture、package.json、真实配置、任何凭证）
- COMMANDS / EXIT_CODES: `npm run s0:gate` 0；`npm run test:oracle` 0（42/42）；`npm run s0:repeat -- --count 100` 0；另 `npm test` 0（71/71）、`npm run typecheck` 0、`npm run build` 0
- TEST_SUMMARY: s0:gate PASS；test:oracle 42/42；s0:repeat 100/100 同一哈希；npm test 71/71
- ORACLE_PARITY: 48/48（ORACLE_PARITY.json，0 mismatch）
- GATE_SHA256: `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`
- KNOWN_LIMITATIONS: 见上节
- EVIDENCE_PATHS: 03_evidence/S0/S0_GATE.json、03_evidence/S0/ORACLE_PARITY.json、03_evidence/S0/REPEAT_HASH.json、03_evidence/S0/S0_GATE.log、03_evidence/T004/T004_REPORT.md（本报告）、tests/golden/s0/expected.json、tests/fixtures/s0/manifest.json
- NEXT_TASK: T005（技能实例身份、来源图与 canonical path；S0 已通过，T005–T014 解锁）
- ROLLBACK: git revert OUTPUT_COMMIT
