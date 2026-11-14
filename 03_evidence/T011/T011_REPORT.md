# T011 任务报告｜Golden / Property / Mutation 回归（S4）

- 任务：T011｜Golden / Property / Mutation 回归（S4，7h）
- 日期：2026-11-13（UTC）
- 基线 commit：`3db8585`（T010 PASS，树干净）
- S0 gate 哈希：`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`（不变）
- 状态：**PASS**（验收见 §6；机器可读证据见 `03_evidence/T011/GOLDEN_PROPERTY_MUTATION_REPORT.json`，由 `scripts/t011-evidence.mjs` 从真实命令输出解析生成，未手填数字）

## 1. 目标与范围

扩大确定性测试覆盖，确保核心规则变更不能静默改变有效技能集合。输入为 S0–S3 冻结实现、Python Oracle、golden fixtures、固定 seed `P023-SKILLSCOPE-S0-2026-11-13`。

文件归属：`tests/golden`、`tests/property`、`tests/mutation`、`scripts/mutation-test.mjs`、`scripts/property-test.mjs`、`scripts/t011-evidence.mjs`、`03_evidence/T011/`。未碰 T012 及以后模块；未改 S0 seed / golden / Oracle；T005–T010 已交付模块只改了一处——`src/canonical/index.ts` 的一个真实 bug（见 §5），并在报告里写明。

## 2. 交付物

| 文件 | 大小 | 内容 |
|---|---|---|
| `tests/golden/runner.ts` | 13,250 B | 三个 PoC runner（复用 T002/T003/T006 调用模式）+ kernel/golden/Oracle 三方投影比较 |
| `tests/golden/s0-golden.test.ts` | 5,549 B | kernel vs 冻结 S0 golden，全字段比较，48 夹具 + 检测/误报汇总 |
| `tests/golden/oracle-parity.test.ts` | 2,515 B | 现场 spawn Python Oracle：Oracle vs golden 逐字节 + kernel vs Oracle 投影 |
| `tests/golden/extended-golden.test.ts` | 14,108 B | 13 个手工推导的 kernel 级 golden 用例（输入在代码内合成） |
| `tests/golden/extended/expected.json` | 11,534 B | 13 个用例的手工期望值（从 §4.1/§4.2 与 ADR-005/ADR-006 手算，绝非由生产 resolver 生成） |
| `tests/property/seed.ts` | 4,835 B | 确定性 PRNG（mulberry32 + FNV-1a）与生成器；seed 可由 `--seed` 覆盖，默认冻结 seed |
| `tests/property/properties.test.ts` | 27,915 B | 10 条性质测试（P1–P10） |
| `tests/mutation/mutations.json` | 8,463 B | 20 个变异，8 类（定义 + 杀死测试 + 原理） |
| `scripts/mutation-test.mjs` | 8,365 B | 变异 runner：先跑 control，变异只作用于临时副本（node_modules 符号链接），真实树不动 |
| `scripts/property-test.mjs` | 1,354 B | `test:property` 包装器：解析 `--seed`，经环境变量传入 vitest（见 §4） |
| `scripts/t011-evidence.mjs` | 8,104 B | 验收证据组装器：真实跑 5 条验收命令并解析输出写 JSON |
| `03_evidence/T011/GOLDEN_PROPERTY_MUTATION_REPORT.json` | 3,412 B | 机器可读验收报告 |
| `03_evidence/T011/mutation-matrix.json` | 6,428 B | 变异矩阵（20/20 杀死，分 8 类） |
| `03_evidence/T011/T011_REPORT.md` | 本文件 | 任务报告（验收记录由 Muse 亲自写，不在此） |

另有两处小改动：`tests/hash/hash.test.ts` +2 个 T011 回归测试（§5）；`package.json` 的 `test:property` 改为走包装器（§4）。零新增依赖。

## 3. Golden：全字段比较（比 T006 的交叉检查严格得多）

T006 只比较 status、finding-id 多重集、unknownScopes 与实例数。本任务的 `tests/golden/s0-golden.test.ts` 对 48 个夹具逐一比较 kernel 输出的**每一个字段**：status、实例（sourceRootId、sourceScope、relativePath、logicalName、folderName、manifestName、contentSha256、status、evidenceLevel、aliases）、finding（id、severity、sourceScope、status、detail、instanceIds、affectedCount）、coverage（enumerated/required/unknownScopes）、policy 摘要（applied、effectiveCount、expectedCount、violationCount）。

两个有文档记录的不对称（见 `tests/golden/runner.ts` 头注释）：

- **实例的 `canonicalPath` 与 `extra` 不在 kernel 比较内**：kernel 不输出这两项，它们是 PoC 层字段，由 S0 gate 在生产 canonicaliser 与 Oracle 之间逐字节比较。
- **策略 finding（SCOPE_LEAK / DISABLE_MISMATCH）的 detail 文本不逐字比较**：kernel 按 ADR-005 用自己的措辞重算，golden/Oracle 用 Oracle 的措辞。投影中该字段置 null；另断言每条策略 finding 的 detail 非空且点名违规实例 id。其余 finding 的 detail **逐字比较**（绝对夹具目录先 scrub 为 `<FIXTURE_DIR>`，与 S0 canonicaliser 同法）。

结果：**48/48 全字段一致**。检测记账沿用 gate 的定义（`scripts/s0-gate.mjs` §7）：planted 夹具当 kernel 结果等于 golden 且 golden 含 deviation marker（finding、unknown scope 或非 ELIGIBLE 实例）时计为检出——其中 codex c16 与 claude c14 仅凭一个非 ELIGIBLE 实例检出，状态 PASS 且无 finding；control 夹具当状态非 PASS 或含 P1 finding 时计为误报（P2 finding 在 control 上是合法的：同名共存与重复内容被允许）。**检出 24/24，误报 0**。

Oracle parity（`tests/golden/oracle-parity.test.ts`）：现场 spawn `oracle/python/reference_resolver.py`，**Oracle vs golden 48/48 逐字节 canonical JSON 一致**（含 `extra` 与 detail 文本，与 gate 相同的比较），**kernel vs Oracle 48/48 投影一致**。

Extended golden（13 个手工用例）：策略组合（forbidden scope + forbidden name、allow-list、双表并存时恰好一条 SCOPE_LEAK）、ADR-006（DISCOVERED 与 DISABLED 实例均不泄漏）、命名空间精确匹配（`deploy` 不匹配 `acme:deploy`，`acme` 也不匹配 `acme:deploy`）、优先级 INCOMPLETE > FAIL > PASS（UNKNOWN finding 压倒 P1 CONFIRMED）、P2-only 不失败、FAIL_OPEN_CONFIG 单独失败、discovery skip（symlink 出根）转 UNKNOWN finding、Claude 与 OpenMausBot 路径。**13/13 通过**。finding detail 文本不在冻结合同内（实现措辞），但每条 detail 断言非空。

## 4. Property：10 条性质，固定 seed 可重放

`tests/property/`，seed 默认 `P023-SKILLSCOPE-S0-2026-11-13`（mulberry32 + FNV-1a，零 Date/Math.random/环境输入），每条性质 60–200 个用例：

- **P1** canonical JSON：确定性、键序无关、NFC 等价同哈希、`-0` == `0`；重序列化 parsed 形式稳定。
- **P2** `compareCodePoints` 是码点全序（非 UTF-16 码元序）：反对称、自反、三元传递，与码点数组排序一致；U+10000 排在 U+FFFF 之后。
- **P3** 身份注册表 vs 独立暴力模型：size、别名合并（首路径为主、其余排序为 aliases）、同名碰撞组、重复内容组、实例排序，80 轮随机注册表。
- **P4** 策略比较：forbidden 集单调（多禁一个 scope/name，finding 数不减）、每条 finding 恰好指向一个 ELIGIBLE 实例、每实例至多一条 SCOPE_LEAK、DISABLE_MISMATCH 仅精确逻辑名匹配、expectedCount = effectiveCount − 违规实例数。
- **P5** finding 代数：normalize 幂等、severity 恒取 catalog、dedupe 幂等且有序、状态优先级与 §4.1 独立转录一致；未知 id 与空 detail 抛错。
- **P6** resolver 确定性：同一输入两次跑出同一 canonical 字节（含策略与不含策略）。
- **P7** 未知传播：一个未知 scope 或一条 UNKNOWN finding 强制 INCOMPLETE（即使已有 P1 CONFIRMED）；单条 P1 CONFIRMED 强制 FAIL；单条 P2 保持 PASS；config 不可读且无其他未知源时 fail-closed 为 `CONFIG`。
- **P8** 有效集恰好是 ELIGIBLE 实例（ADR-006）。
- **P9** seed 重放：同一 seed 两次生成逐字节相同的用例流；不同 seed 发散。
- **P10** 策略规范化：幂等、排序去重、非法策略（scope 又允许又禁止、空名、非数组）被拒绝而非静默修复；空列表被规范化丢弃（非错误）。

**10/10 通过**。另实测 `--seed` 换值后同样 10/10（见 §4），证明 seed 参数真实驱动用例流。

### test:property 的 `--seed` 包装器

验收命令 `npm run test:property -- --seed <seed>` 原样跑不通：vitest 没有 `--seed` 选项（直接报错 `CACError: Unknown option '--seed'`）。因此 `test:property` 改为 `node ./scripts/property-test.mjs`：解析 `--seed`，经环境变量 `SKILLSCOPE_PROPERTY_SEED` 传入 vitest；`tests/property/seed.ts` 默认仍为冻结 seed，裸跑 `vitest run tests/property` 行为不变。package.json 只改了这一行脚本，无依赖改动（沿用 T001/T005/T006/T008b/T009/T010 向 §3.3 之外加脚本的先例）。

## 5. 本任务发现并修复的真实缺陷：canonical 键排序先于 NFC

性质测试 P1 在首跑即暴露生产代码的真实 bug（T008b 的 `src/canonical/index.ts`）：

```ts
const keys = Object.keys(value).sort(compareCodePoints);   // 先按原始键排序
const parts = keys.map((key) => `${JSON.stringify(key.normalize("NFC"))}:...`);  // 再 NFC
```

分解形式的键 `"e" + combining acute` 首码点为 U+0065（`e`），排在 `"notes…"`（U+006E）之前；但其 NFC 形式 `"é"` 首码点为 U+00E9，应排在之后。于是：

- `canonicalizeJson({"e\u0301release": 0, "notes": 3})` 输出 `{"érelease":0,"notes":3}`；
- 再 parse 并重 canonical 化，输出变为 `{"notes":3,"érelease":0}`；
- **canonical 形式不是不动点**，`isCanonicalJson(canonicalizeJson(v))` 为 false；分解与预合成两种拼写哈希不同，违背模块自身文档（"canonically equivalent spellings hash the same"）与 ADR-011；
- 独立 Oracle（`oracle/python/canonical.py`）是先 NFC 再排序（"object keys sorted (stable, byte-wise on the NFC form)"），生产代码与之**分歧**——S0 夹具全是 ASCII 键，所以 gate 从未触及。

修复（`src/canonical/index.ts`，+30/−4 行）：先把键 NFC 规范化再按码点排序；两个不同原始键 NFC 碰撞为同一键时 fail-closed 抛 `TypeError`（无唯一 canonical 形式；Oracle 在该病态输入上是静默取后者——这是有意的 fail-closed 分歧，只影响现实中不存在的碰撞键输入，其余输入与 Oracle 逐字节一致）。Python 独立锚点验证：`{"notes":3,"érelease":0}` 的 SHA-256 为 `e85a9a77a5df439198f0da71318fdc2f40bbb367594993e96868fbfb297b679f`，与修复后生产输出一致。

回归锁定：`tests/hash/hash.test.ts` 新增 2 个测试（NFC 键排序向量 + 不动点 + 碰撞抛错），hash 套件由 39 增至 **41/41**；冻结 hash 向量（含 astral 键向量）全部仍通过；S0 gate 哈希不变。

## 6. Mutation：20/20 杀死，8 类全覆盖

`tests/mutation/mutations.json` 定义 20 个手工变异（每条只改一条冻结规则，附杀死测试与原理），`scripts/mutation-test.mjs` 执行：先在干净副本上跑全部 5 个不同杀死测试作 control（必须全过，否则中止），再逐个变异作用于临时副本（node_modules 符号链接，真实树不动）并跑其杀死测试。完整矩阵见 `03_evidence/T011/mutation-matrix.json`。

| 类 | 含义 | 变异 | 杀死 |
|---|---|---|---|
| 1 selector-as-path | 名字选择器匹配错字段 | M01（按 scope 匹配）、M02（forbidden 名硬编码为 `deploy`） | 2/2 |
| 2 scope-precedence | allow/forbid 分支逻辑 | M03（allow-list 取反）、M04（forbidden 分支删除）、M05（else-if 变 if，双 finding） | 3/3 |
| 3 fail-open | INCOMPLETE 条件丢弃 | M06（unknownScopes 检查删除）、M07（UNKNOWN finding 检查删除）、M08（SOURCE_NOT_ENUMERATED 默认为 CONFIRMED） | 3/3 |
| 4 coverage-mask | coverage 数字掩盖未枚举源 | M09（unknownScopes 恒为空）、M10（enumerated 报成 required）、M20（required 报成 enumerated） | 3/3 |
| 5 effective-set | 非 ELIGIBLE 实例算入有效集 | M11（DISCOVERED 算入）、M12（DISABLED 算入） | 2/2 |
| 6 namespace-flatten | 命名空间名只匹配一段 | M13（取末段）、M14（取首段） | 2/2 |
| 7 severity-downgrade | P1 降为 P2 | M15（SCOPE_LEAK）、M16（FAIL_OPEN_CONFIG） | 2/2 |
| 8 canonical-order | 规范化键序弱化 | M17（UTF-16 码元序）、M18（逆序）、M19（去 NFC） | 3/3 |

**Mutation score 20/20 = 100%（目标 ≥95%），0 存活、0 等价变异、0 错误。** 无失败变异，无需开 FIX 任务。

## 7. 验收（真实跑出，见 §6 机器可读报告）

| 命令 | 退出码 | 关键输出 |
|---|---|---|
| `npm test` | 0 | 512 tests passed，25 files（T010 时 434；+78 = golden 66 + property 10 + hash 2） |
| `npm run test:property -- --seed P023-SKILLSCOPE-S0-2026-11-13` | 0 | 10 tests passed，seed 如示 |
| `npm run test:mutation` | 0 | score 1.0（20/20），0 存活 |
| `npm run test:oracle` | 0 | Python Oracle 单元测试 42 tests，OK |
| `npm run s0:gate` | 0 | gate hash `a11d2a4c…` **不变**；parity 48/48；golden match production 48/48，oracle 48/48；检出 24/24；误报 0；replay 100 runs，1 unique hash |

以上数字由 `scripts/t011-evidence.mjs` 在 2026-11-13T15:26:08Z 从真实命令输出解析写入 `GOLDEN_PROPERTY_MUTATION_REPORT.json`（`passed: true`）；另用换值 seed 跑 property 亦 10/10。`typecheck`（`tsc --noEmit`）在开发过程中通过（T011 新增/改动的 TS 文件零错误）。

## 8. 未改动与已知局限

- **未改动**：S0 seed / golden / Oracle / T005–T010 模块（除 §5 的 canonical 修复）；S0 证据文件在 gate 后按惯例 `git checkout -- 03_evidence/S0/` 恢复（仅 base_commit 标签变化）。
- **局限 1**：property 测试是对固定 seed 的有限随机抽样（每条性质 60–200 用例），不是穷举；换 seed 亦通过，但不同 seed 的覆盖未经系统性扫掠。
- **局限 2**：变异测试覆盖 kernel 规则（policy / findings / resolver / canonical），不覆盖适配器、CLI、IO 与隐私模块；杀死测试是单文件 vitest 运行，未覆盖跨模块组合变异。
- **局限 3**：golden 比较不含实例 `canonicalPath` 与 `extra`（PoC 层字段，由 gate 逐字节比较）与策略 finding 的 detail 措辞（见 §3）。
- **局限 4**：NFC 碰撞键输入上生产与 Oracle 行为有意不同（生产抛错，Oracle 静默取后者）；现实输入无碰撞键，分歧只影响病态输入。
- **局限 5**：变异 runner 每次复制 `src/` + `tests/`（node_modules 符号链接），依赖 `/tmp` 可写；单次全量约 23 秒。
