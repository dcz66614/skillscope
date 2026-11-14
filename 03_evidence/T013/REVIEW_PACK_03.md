# REVIEW_PACK_03 — Python Oracle、S0 Gate 与证据脚本（P023 T013 独立复核）

- 任务：P023 SkillScope T013（S5 独立复核）
- 冻结候选：`8a7f736`；S0 gate `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`
- 日期（UTC）：2026-11-13
- 本包范围：`oracle/`、S0 gate 脚本、全部 `scripts/`、golden/property/mutation 测试基建、T012 两处修复的复核。
- 结论：本包范围内未发现 P0/P1。发现 2 项 P2（P2-T013-02 的 gate 部分、P2-T013-10），均见 FINDINGS.md。

## 1. Python Oracle（独立性核查）

读过全文：`oracle/python/reference_resolver.py`、`oracle/python/canonical.py`、`oracle/tests/test_canonical.py`、`oracle/tests/test_reference_resolver.py`（后者经 `npm run test:oracle` 的 42 测试全过 + 结构抽查；`__init__.py` 为空包标记）。

- **独立性成立**：Oracle 只用 Python 标准库（`json`、`hashlib`、`unicodedata`、`pathlib`），不导入、不调用任何 SkillScope TypeScript 代码；`py-canonical-check.py` 同样只用标准库。Oracle 的规则实现是独立重写（`reference_resolver.py` 内含 canonicalise_* 与 driver），非生产代码的翻译——其与生产在 NFC 碰撞键、-0.0、孤 surrogate 上的**行为分歧**反而证明两者不是同一份逻辑的复制（见 §3）。
- `reference_resolver.py`：48 夹具的期望输出由它现场生成并与 golden 逐字节比较（`tests/golden/oracle-parity.test.ts`）；S0 gate 中生产/Oracle parity 48/48。Oracle 自身单元测试 42/42（本轮实测 `Ran 42 tests … OK`，0.048s）。
- `canonical.py`：NFC + 码点键序 + 无空白 + UTF-8；**但** `sha256_hex` 对 canonical 字节**加一个尾 LF**后哈希，而 TS `canonicalSha256` 对无 LF 字节哈希（见 §3）。
- `test_canonical.py`：`test_sha256_matches_independent_hashlib_computation` 把 `sha256_hex` 钉在 `b'{"a":1}\n'` 上——即 Oracle 自身的哈希约定是“带 LF”，与冻结向量（无 LF）不同约定。两者各自内部一致，从未交叉比较。

## 2. S0 Gate（`scripts/s0-gate.mjs` / `s0-run.mjs` / `s0-canonical.mjs`）

全文已读；本轮实测通过（见 T013_REPORT.md §1）。

- `s0-gate.mjs`：8 步（构建 → 生产跑 48 夹具 → Oracle spawn → canonical 比较 → golden 比较 → 检出/误报记账 → 100 次重放 → 写证据）。`SKILLSCOPE_GATE_NO_REBUILD=1` 仅测试用（套件内 globalSetup 已构建；独立运行永远重建）。`git checkout -- 03_evidence/S0/` 在 verify:all 与 e2e 内恢复 gate 改写的 base_commit 标签——已验证恢复有效（本轮跑后树干净）。
- `s0-run.mjs`：`repeatGate` 在进程内重跑 gate 100 次，要求唯一 gate hash。
- `s0-canonical.mjs`：**声称“must match oracle/python/canonical.py exactly”，但三处不符**（P2-T013-02）：
  1. `canonicalBytes` = canonical JSON + `"\n"`（带尾 LF），而 TS `src/canonical` 的 `canonicalBytes` 无尾 LF；`sha256Hex` 因此与 TS `canonicalSha256` 对同一值算出不同哈希。**实测**：值 `{a:"x\u2028y", b:"line\u2028sep", c:"emoji😀"}`，TS 与 Python 的 canonical 字符串逐字节相同（U+2028 均为原始 `e2 80 a8`，emoji 相同），但 sha 助手不同约定。
  2. `normalise` 用 `Object.keys(value).sort()`——默认 UTF-16 码元序；TS `compareCodePoints` 与 Python `sort_keys=True` 均按码点排序。**实测**：astral 键 `{U+10000, U+E000}`，Python 与 TS 均以 U+E000 在前，s0-canonical 以 U+10000 在前。
  3. Python `canonical_json(-0.0)` 得 `"-0.0"`，TS `canonicalizeJson(-0)` 得 `"0"`（`py-canonical-check.py` 的 `canon` 对 0 返回 `"0"`，与 TS 一致；`oracle/python/canonical.py` 无 -0 测试）。
  - **为何不是实时缺陷**：gate 用 `canonicalEquals` 比较经**同一** s0-canonical 规范化后的生产与 Oracle 值（Oracle 输出先解析为 JS 值再规范化），两侧走同一排序；报告哈希只用 TS 函数；冻结向量钉住无 LF 约定。分歧只在有人直接拿 s0-canonical/Python 的 canonical 字符串或 sha 与 TS 的对应物比较时才会显现。建议：统一字节形式或在文档中明确两种哈希函数输入不同、不可互比。
- Gate 的网络扫描只覆盖 `node:http/https/net` 导入与 `fetch(`（启发式，非证明；无 `child_process`/curl/`WebSocket`/`dgram` 覆盖）；离线性的强证据是 `offline-check.mjs` 的死代理实测（三 demo 在黑洞代理下仍为冻结退出码 1/0/2）。备注，非 finding。
- Gate 输出本轮：48 夹具（control 24 / planted 24）、parity 48/48、golden production 48/48 + oracle 48/48、检出 24/24、误报 0、未枚举源 11（跨 10 夹具）、外部请求 0、源写 0、重放 100 次 1 个哈希、gate_sha256 不变。

## 3. Golden / Property / Mutation 测试基建

- `tests/golden/runner.ts`（全文）：投影逻辑对称——策略 finding（SCOPE_LEAK / DISABLE_MISMATCH）的 detail 在**两侧**同时置 null（kernel 与 Oracle 措辞不同），其余 finding 的 detail 在 scrub fixtureDir 后逐字比较；实例按码点 `<` 排序；frozen 侧的 policy 摘要由结果自身推导（applied = 夹具带 policy；effectiveCount = ELIGIBLE 数；expectedCount = effective − 违规实例数；violationCount = 策略 finding 数）——这是对 kernel 摘要算术的真实检查，非自证。`checkPolicyFindingDetails` 断言每条策略 finding 的 detail 非空且点名违规实例 id。两个已记录的不对称（实例 `canonicalPath`/`extra` 不在 kernel 比较内，由 gate 逐字节比较；策略 finding detail 措辞不在冻结合同内）均有文档且合理。
- `tests/golden/s0-golden.test.ts` / `oracle-parity.test.ts` / `extended-golden.test.ts`：未逐行读，T011 报告 §3 描述与 runner.ts 实现一致；13 个手工 extended 用例的期望值在 `tests/golden/extended/expected.json` 中（声明为手算，非生产生成）。
- `tests/property/seed.ts` + `properties.test.ts`：未逐行读；T011 报告 §4 列出 P1–P10 性质与 seed 机制；`property-test.mjs` 包装器解析 `--seed` 经环境变量传入（vitest 无 `--seed` 选项，见 PACK_01 §2.3）。
- `tests/mutation/mutations.json` + `mutation-test.mjs`（全文）：20 变异、8 类；先在干净副本上跑 control（杀死测试必须全过，否则中止），再逐个变异作用于临时副本（node_modules 符号链接，真实树不动）；score = killed / (total − equivalent)，目标 ≥0.95；T011 证据 20/20 = 100%。**本轮未重跑全量 mutation**（约需数分钟 × 20 副本构建；T011 证据完整且 gate/全量套件已重跑通过），见 T013_REPORT.md 局限。

## 4. 其余 scripts（全文已读）

| 脚本 | 结论 |
|---|---|
| `verify-all.mjs` | 8 步聚合，每步都跑、逐条记退出码与耗时；license inventory 为真实检查（读 lockfile + 各包自带 package.json，非静态列表）；可选未装平台包单列，不算缺失。本轮 8/8 通过 |
| `e2e.mjs` | 真实 CLI 进程驱动三 demo；schema 校验；HTML 内嵌 JSON 与 JSON 报告逐字节相同；夹具树前后哈希相同（0 源写）；确定性两次审计字节相同；`verify --fixtures s0`；截图本地缓存、无则跳过不失败。本轮 28/28 |
| `offline-check.mjs` | 四项独立检查（静态扫描、死代理三态、输出扫描、文档扫描）；自身文件因模式列表含禁用词而被排除扫描（注释说明，诚实）；本轮 PASS |
| `performance.mjs` | 500 实例合成夹具，各 3 次取中位数；wall time 含 Node 启动；峰值 RSS 读 `/proc/<pid>/status` VmHWM 轮询；无 /proc 时记 null 且**不**静默通过；目标永不就地调整（§10.3：非核心目标调整需 ADR）。本轮在 verify:all 内通过 |
| `perf-fixture.mjs`（+ `.d.mts`） | 确定性 500 实例生成器（60% REPO / 30% USER / 10% ADMIN；无时间戳、无随机数） |
| `build-lock.mjs`（+ `.d.mts`） | 原子 mkdir 锁 + holder pid 防死锁；120 s 超时。**P2-T013-10**：`releaseBuildLock` 无条件删锁目录（若锁在超时后被另一进程夺取，原 holder 的释放会删掉新 holder 的锁）；`lockHolderAlive` 检查-删除之间有 TOCTOU。仅测试基建（globalSetup + s0-gate），120 s 超时 vs 约 4 s 构建，实际触发概率极低。硬化建议，非正确性缺陷 |
| `release-rehearsal.mjs` | T014 流程预演（git archive → dist zip → SHA256SUMS → unzip -t → sha256sum -c → 干净目录重建 + 烟囱审计）；23 个 `.gitkeep` 目录逐一核查在干净树中存在；唯一偏离是干净目录 symlink 链接本仓库 node_modules 代替 `npm ci`（已声明）；产物只进 `03_evidence/T012/rehearsal/`，不写 `release/` |
| `repeat-hash.mjs` | 100 次重放，要求唯一 gate hash；`--count` 须为正整数 |
| `demo.mjs` | 三 demo 审计；退出码不匹配或外部资源 >0 时 exit 1；确定性不匹配时 exit 1；截图失败不掩盖（`failed:` 会进 failures） |
| `env/probe.mjs` | T001 环境探测；只读；`npm view typescript version` 是一次注册表可达性探测（施工环境，非产品运行时） |
| `hash-privacy-evidence.mjs` | T008b 证据生成器：15 向量 TS vs fixture vs Python 三方对照；PII 扫描只记模式名/路径/长度，**不记密钥值**；报告生成两次须逐字节相同；写盘后重读重哈希 |
| `identity-evidence.mjs` | T005 证据生成器：固定 /tmp 树；11 条不变量；树外 secret 永不出现；source graph 无绝对路径 |
| `t010-evidence.mjs` | 退出码矩阵实测（正常 + `--ci` + 4 个错误用例）；README 首屏渲染截图；矩阵不匹配即抛错 |
| `t011-evidence.mjs` | 从真实命令输出解析数字写 JSON（未手填）；gate 后恢复 `03_evidence/S0/` |
| `py-canonical-check.py` | 独立 Python canonical 实现（标准库）；键按码点排序（`key=lambda k: [ord(c) for c in k]`）；0 → `"0"`；哈希无尾 LF——与 TS 一致，与 `oracle/python/canonical.py::sha256_hex` 的带 LF 约定不同（见 §3） |

## 5. npm 脚本表核对（`package.json` vs 计划 §3.3）

- 冻结脚本全部存在且行为与计划一致：`build`、`test`、`test:codex/claude/openmausbot`、`test:oracle`、`s0:gate`、`s0:repeat`、`test:mutation`、`test:e2e`、`test:offline`、`test:performance`、`verify:all`。
- 计划 §3.3 之外新增的脚本（每项均有 DECISION_LOG 先例记录）：`test:rules`、`test:identity`、`test:symlink`、`test:manifest`、`test:io`、`test:privacy`、`test:hash`、`test:cli`、`demo`、`test:ci`、`test:property`（改线见 PACK_01 §2.3）。零新增依赖。
- `release:build` / `release:verify` 声明存在、目标文件不存在（P2-T013-08，T014 自有）。

## 6. T012 两处修复的复核

1. **23 个空 skills 目录 `.gitkeep`**（commit 495890d）：`git archive` 丢空目录 → 打包树与工作树审计不一致（干净目录 codex-fail 退出 2 而仓库内退出 1）。修复为 23 个空目录各加 `.gitkeep`（1 个 demo + 22 个 S0 夹具）。复核：`git ls-files "**/.gitkeep"` 本轮仍为 23 个；`release-rehearsal.mjs` 逐一核查其在干净树中存在；PoC（`listSkillDirs` 只认目录）与 Oracle（`_is_dir_or_symlink` 只认目录）均跳过普通文件，审计结果零变化——gate hash 不变（本轮实测 `a11d2a4c…`）与 codex-fail audit_sha256 不变（`948f9414…`，T012 报告记录）一致。**产品未为求测试通过降低门槛**：缺失目录仍 fail-closed 为 SOURCE_NOT_ENUMERATED（本轮 Codex 探针复证），未被“容忍缺失”。
2. **并行测试竞态修复**（cc9b016 / 3911f60 / c1857ef 三轮）：根因为共享态未同步——5 个测试文件并发 `tsc` 写同一份 `dist/`、gate 自己重建 dist、两处 `git checkout -- 03_evidence/S0/` 撞 `index.lock`。最终形态：`vitest.config.ts` + `tests/helpers/global-setup.ts`（套件开始前构建一次 dist，套件内不重建）；`SKILLSCOPE_GATE_NO_REBUILD=1` 仅测试用（独立运行永远重建）；`scripts/build-lock.mjs` 共享锁供 globalSetup 与 s0-gate 使用；`tests/helpers/test-infra.ts` 只剩 `checkoutS0`（index.lock 重试 10 次）。复核：本轮 `npm test` 两次（verify:all 内一次 + 独立一次）均为 28 文件 525/525，无 flake；`verify:all` 8/8。修复未降低任何正确性门槛——它删除的是重复构建与重复 gate 测试（e2e 的 gate 测试由 9 减为 8，全量由 526 变为 525），断言本身未动。`SKILLSCOPE_GATE_NO_REBUILD=1` 的作用域：仅 `tests/cli/cli.test.ts:349-359` 在套件内设置，用完恢复；`scripts/s0-gate.mjs:110-116` 明确标注 TEST-ONLY。

## 7. 本包未发现 P0/P1 的依据

- Oracle 独立于生产实现（仅标准库；行为分歧反证非复制）；gate 48/48 parity、24/24 检出、0/24 误报、100 次重放 1 哈希——本轮亲自重跑复证。
- 全部证据脚本均为真实执行、真实解析输出，无空脚本、固定 exit 0 或只打印 PASS 的占位（逐个读过；`demo.mjs` 的“总是 exit 0”注释指检查全部通过时，失败路径均 exit 1）。
- T012 两处修复均未降低正确性门槛，且均有回归证据。
