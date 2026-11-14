# T012_REPORT.md — 端到端、离线、性能与发布预演（S4）

- TASK_ID: T012（S4）
- BASE_COMMIT: 841e828（T011 PASS 控制提交）
- OUTPUT_COMMIT（代码）: 63d8ad1（E2E / 离线 / 性能 / verify:all / 发布预演）
- OUTPUT_COMMIT（修复）: 495890d（空 skills 目录 .gitkeep 修复，见 §4）
- OUTPUT_COMMIT（修复 2）: cc9b016（并行测试竞态修复，见 §8）
- OUTPUT_COMMIT（修复 3）: 3911f60（共享构建锁含 S0 gate、去重 gate 运行，见 §8）+ c1857ef（vitest globalSetup 一次构建、套件内不重建，见 §8）
- 完成时间 (UTC)：2026-11-13 ~16:10
- 状态：PASS（六条验收命令真实退出码均为 0，见 §1）
- 本报告为任务执行者（builder）自写；Muse 的验收记录由 Muse 亲自另写，不在本文件。

## 1. 验收命令与真实结果

| # | 命令 | 退出码 | 关键输出 |
|---|---|---:|---|
| 1 | `npm test` | 0 | vitest 28 个测试文件，**525/525 通过**（T011 时 512；新增 e2e 8 + offline 3 + performance 2 = 13；用时 ~23–45 s）。另见 §8：最终验收前发现并行竞态（三轮失败），修复后连续 5 次全量运行均为 525/525 通过，另 `verify:all` 内 2 次通过 |
| 2 | `npm run test:e2e` | 0 | **28/28 检查通过**：三 demo profile 冻结退出码 1/0/2、JSON 均通过 skillscope.report/v1 校验、HTML 内嵌 JSON 与 JSON 报告逐字节相同、外部资源 0、夹具树审计前后逐字节相同（0 源写）、两次审计字节相同、`verify --fixtures s0` 退出 0、HTML 截图成功（136,209 B） |
| 3 | `npm run test:offline` | 0 | `offline-check: PASS — no account, no LLM, no network, no real skills needed`（静态扫描、死代理三态 1/0/2、文档扫描均 OK） |
| 4 | `npm run test:performance` | 0 | 500 实例：扫描中位数 **208 ms**（目标 ≤5,000 ms）、HTML 中位数 **302 ms**（目标 ≤2,000 ms）、峰值 RSS **81.9 MiB**（目标 ≤300 MiB）、500/500 实例、hash 稳定 |
| 5 | `npm run verify:all` | 0 | **8/8 步骤通过**：typecheck 0、test 0、test:oracle 0、test:e2e 0、test:offline 0、test:performance 0、s0:gate 0、license-inventory 0（42 个包；见 §3） |
| 6 | `npm run s0:gate` | 0 | S0 gate PASS；**gate_sha256 不变：`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`**；48/48 parity、48/48 golden、检出 24/24、误报 0/24 |

另跑：`npm run typecheck` 0；`npm run test:oracle` 0（42 OK）。本任务未新增任何 npm 依赖（零新增依赖；package.json 未改动）。

## 2. 交付文件

| 文件 | 字节 | 说明 |
|---|---:|---|
| scripts/perf-fixture.mjs | 5,179 | 确定性 500 实例合成 Codex 夹具生成器（60% REPO / 30% USER / 10% ADMIN；无时间戳、无随机数；也可作脚本单独跑） |
| scripts/perf-fixture.d.mts | 558 | 上述生成器的类型声明（NodeNext 下 .mjs 须配 .d.mts，见 §5） |
| scripts/performance.mjs | 8,719 | `test:performance`：各 3 次取中位数、wall time 含 Node 启动、/proc VmHWM 轮询峰值 RSS、hash 稳定性断言 |
| scripts/e2e.mjs | 10,449 | `test:e2e`：真实 CLI 进程驱动三 demo profile；schema 校验；内嵌 JSON 逐字节比对；夹具树哈希前后比对；S0 verify；本地 headless Chromium 截图 |
| scripts/verify-all.mjs | 7,566 | `verify:all`：8 步聚合（每步都跑、逐条记退出码与耗时）+ 依赖许可证清单（见 §3） |
| scripts/release-rehearsal.mjs | 10,032 | T014 打包流程预演：git archive → dist zip → SHA256SUMS → unzip -t → sha256sum -c → 干净目录重建 + 烟囱审计；产物只进 03_evidence/T012/rehearsal/，不写 release/ |
| tests/e2e/e2e.test.ts | 6,351 | vitest E2E：真实 CLI 进程；8 个测试（冻结退出码、schema、内嵌 JSON、外部资源 0、夹具不变、确定性；gate 测试见 §8 已移除，避免与 cli.test.ts 并行跑 gate） |
| tests/offline/offline.test.ts | 5,404 | vitest 离线：死代理三态、src/scripts/dist 静态无网络调用点、报告无 http(s):// URL |
| tests/performance/performance.test.ts | 4,113 | vitest 性能：100 实例夹具（临时生成）；PASS、精确计数、hash 稳定；宽松 sanity 界（10 s / 5 s），严格 §10.3 目标只由 performance.mjs 断言 |
| tests/helpers/test-infra.ts | 1,870 | 共享测试基建（§8 修复）：checkoutS0（index.lock 重试）；cli.test.ts 的 S0 恢复改用它（buildDistOnce 已随 globalSetup 删除） |
| tests/helpers/global-setup.ts | 1,209 | vitest globalSetup（§8 修复 3）：套件开始前构建一次 dist/（共用 scripts/build-lock.mjs 的锁） |
| vitest.config.ts | 469 | vitest 配置：仅声明 globalSetup；测试发现仍为默认（全部 *.test.ts） |
| scripts/build-lock.mjs (+ build-lock.d.mts) | 2,810 + 390 | 共享 dist 构建锁（§8 修复 2）：原子 mkdir 锁 + holder pid 防死锁；s0-gate.mjs 与测试基建共用同一把锁 |
| 03_evidence/T012/performance.json | 955 | 性能测量 + 环境信息（见 §3 性能基线） |
| 03_evidence/T012/e2e.log / e2e.json | 1,720 / 3,698 | E2E 日志与机器可读汇总（28/28） |
| 03_evidence/T012/e2e-codex-fail.png | 136,209 | codex-fail HTML 报告截图（本地 headless Chromium 渲染，无下载） |
| 03_evidence/T012/verify-all.json / verify-all.log | 15,328 / 749 | verify:all 全量汇总（8 步退出码/耗时/输出尾）与日志 |
| 03_evidence/T012/licenses.json | 8,873 | 依赖许可证清单（42 包 + 30 个未装可选平台包 + 产品 PENDING_SAM_DECISION） |
| 03_evidence/T012/RELEASE_REHEARSAL.md | 2,252 | 发布预演报告（非冻结；T014 将从冻结 commit 重做） |
| 03_evidence/T012/rehearsal/source.zip | 1,342,913 | 预演 source.zip（git archive HEAD，含 .gitkeep 修复） |
| 03_evidence/T012/rehearsal/dist.zip | 87,127 | 预演 dist.zip（新构建的 dist/） |
| 03_evidence/T012/rehearsal/SHA256SUMS.txt | 152 | 两 zip 的 SHA-256（已 sha256sum -c 验证 OK） |
| 03_evidence/T012/rehearsal/REHEARSAL_MANIFEST.json | 683 | 预演 manifest（commit、字节、SHA、结论 PASS） |
| 23 × tests/fixtures/**/skills/.gitkeep | 各 ~600 | §4 修复：让 git 能跟踪空 skills 目录（1 个 demo + 22 个 S0 夹具） |
| 00_control/DECISION_LOG.md | — | 新增 ADR-017（OPEN-003 关闭）与 T012 记录 |
| 00_control/TASK_BOARD.csv / PROJECT_STATE.json | — | T012 PASS；T013 READY |

## 3. 性能基线与许可证清单（真实 VM 测量）

环境（03_evidence/T012/performance.json）：Node v24.22.1；Linux 7.0.0-44-generic x64；CPU AMD EPYC 9D25（4 核）；内存 8,319,901,696 B；三次测量的 1 分钟负载分别为 0.42、2.31、4.4。三次独立测量一致：

| 指标 | 目标 | 第 1 次（3 次中位数） | 第 2 次（verify-all 内） | 第 3 次（最终 verify-all 内） | 结论 |
|---|---:|---:|---:|---:|---|
| 500 实例 CLI 完整扫描 | ≤5,000 ms | 364 ms（三次 364/425/288） | 208 ms（三次 207/208/243） | 250 ms（三次 357/250/217） | 通过，余量 ~13–24× |
| HTML 报告生成 | ≤2,000 ms | 277 ms（三次 302/276/277） | 302 ms（三次 292/302/306） | 294 ms（三次 290/304/294） | 通过，余量 ~6–7× |
| CLI 峰值 RSS | ≤300 MiB | 81.9 MiB | 81.9 MiB | 81.9 MiB | 通过 |
| 实例数 / 状态 | 500 / PASS | 500 / PASS | 500 / PASS | 500 / PASS | 通过 |
| canonical hash 稳定 | 3 次相同 | audit_sha256 `6979a58c…` 3 次相同 | 相同 | 相同 | 通过 |

结论：§10.3 三项目标全部达成，无需 ADR 调整目标；上述数字即冻结的 VM 性能基线（T013 复核用）。

许可证清单（03_evidence/T012/licenses.json，由 package-lock.json + 各包自带 package.json 逐个实查，非静态列表）：
- 已安装 42 个包，许可证集合：MIT、Apache-2.0、BSD-3-Clause、ISC、MPL-2.0；无包缺失 license 字段；无版本与 lockfile 不符。
- 运行时依赖：smol-toml 1.9.1（BSD-3-Clause）、yaml 2.9.1（ISC）；开发依赖：typescript 5.9.3（Apache-2.0）、vitest 5.1.0（MIT）、@types/node 24.19.2（MIT）。
- 30 个 lockfile 列出的包未安装：全部为 `optional: true` 的平台专属包（rolldown 各平台 binding、lightningcss 各平台二进制、fsevents、@emnapi/* 等），npm 在 linux x64 上正确跳过——已单列记录，不算缺失（见 §5 第 2 项）。
- 产品本身：LICENSE PENDING_SAM_DECISION，无 LICENSE 文件——如实记录，未自行添加。

## 4. 本任务的真实发现：git archive 丢空目录，打包树与工作树审计不一致

发布预演第一次运行即 FAIL（不是占位失败，是真实发现）：

- 现象：干净目录（从 `git archive HEAD` 解出）里的 codex-fail 烟囱审计退出 **2（INCOMPLETE）**，而仓库内同一夹具退出 **1（FAIL）**；audit_sha256 也不同（干净目录 `3b20fd5a…` vs 仓库 `948f9414…`）。
- 根因：`git archive` 不包含空目录。工作树里有 23 个空 skills 目录（demo codex-fail 的 `admin/skills/` + 22 个 S0 夹具的 skills 目录），打包后全部丢失。产品行为本身是正确的 fail-closed：skills 目录**缺失** → SOURCE_NOT_ENUMERATED（INCOMPLETE），**存在但为空** → 已枚举 0 实例——两者必须区分，绝不能把缺失当空（改产品去“容忍缺失”会违反 §6.3 STOP 规则，故不采纳）。
- 修复（commit 495890d）：在 23 个空 skills 目录各加一个 `.gitkeep` 占位文件（文件内写明用途，防误删）。PoC（`listSkillDirs` 只认目录）与 Python Oracle（`_is_dir_or_symlink` 只认目录）都跳过普通文件，因此审计结果零变化，实测验证：
  - S0 gate 仍 PASS，**gate_sha256 不变**（`a11d2a4c…`），48/48 parity、48/48 golden；
  - codex-fail audit_sha256 不变（`948f9414…`），仍 FAIL；
  - `npm test` 仍 526/526。
- 预演第二次运行全部通过：source.zip 1,342,913 B（sha256 `bce9c763…`）、dist.zip 87,127 B（sha256 `4ed1c145…`）、`unzip -t` 两 zip 均无错误、`sha256sum -c` OK、干净目录重建 + 烟囱审计退出 1 且 audit_sha256 与仓库完全相同（`948f9414…`）。
- 另：预演脚本新增一项检查——每个被跟踪的 `.gitkeep` 所在目录必须在解出的干净树里存在（本轮 23/23 通过）。
- 未动项：02_source / 04_review / 05_release 三个空顶层目录不在 git 跟踪内、也不是审计输入，未处理；T014 打包时若需其进包，须另行决定（已在预演报告中备注）。
- 注意：S0 夹具中**故意缺失**的目录（如 c11-missing-user-source 的 user skills 目录，本就不存在）未动——缺失本身就是该 planted case 的缺陷点，.gitkeep 只加在“已存在但为空”的目录上。

## 5. 执行中修复的两个实现问题（均已验证通过）

1. **typecheck 失败**：`tests/performance/performance.test.ts` 导入 `scripts/perf-fixture.mjs` 时 tsc 报 TS7016（无声明文件）。原因：NodeNext 模块解析下 `.mjs` 的声明文件必须是 `.d.mts`，不是 `.d.ts`。修复：`scripts/perf-fixture.d.ts` 改名 `scripts/perf-fixture.d.mts`；`npm run typecheck` 通过。
2. **license-inventory 误报**：首版把 lockfile 列出但未安装的 30 个平台专属包当作缺失而 FAIL。核查确认 30 个全部是 `optional: true`（rolldown/lightningcss 各平台 binding、fsevents 等），npm 在 linux x64 上正确跳过。修复：可选未装包单列 `not_installed_optional`，不记为失败；仅非可选缺失、版本不符、无 license 才失败。之后 inventory PASS。

另两处小修（均在自测中发现并即时修正，未影响结论）：e2e.mjs 的一条 PASS 检查误带了失败文案（日志措辞问题，已修正）；offline.test.ts 的一次编辑误删了一行 `readFileSync`（ReferenceError，已补回并全量重跑通过）；e2e.test.ts 的 `verify --fixtures s0` 测试曾超时（S0 gate 约 6.6 s > vitest 默认 5 s），当时已给显式 120 s 超时；该测试后在 §8 第二轮修复中被整体移除（与 cli.test.ts 重复），超时问题随之消失。

## 6. 遵循的冻结决策

- ADR-015（canonical 先 NFC 再排序）：未动 `src/canonical/index.ts`；性能/E2E 的 hash 稳定性断言均基于此规则通过；500 实例审计 hash 在 3 次运行中完全相同。
- ADR-005（kernel 拥有策略比较，profile policy 必传）/ ADR-006（有效集 = ELIGIBLE）：未动 `src/policy` 与 resolver；性能夹具用全允许策略，审计 PASS，500 实例全部 ELIGIBLE。
- OPEN-003（E2E 浏览器来源）：见 ADR-017——产品是 CLI + 静态 HTML，无浏览器界面，故不存在“浏览器驱动产品”的 E2E；本任务用本地缓存的 headless Chromium 只做 HTML 渲染截图（未下载任何浏览器或依赖），其余 E2E 断言均为文件级检查。OPEN-003 关闭。
- 零真人、零真实技能、零网络调用：全部夹具合成；性能/E2E/离线均在本地运行；离线脚本与测试证明外部请求 0（死代理三态仍为冻结退出码）。

## 8. 最终验收前发现的并行竞态与修复（本任务的第二个真实发现）

在证据提交后、最终复核 `npm test` 时，全量套件出现一次失败（此前同一命令已连续两次 526/526 通过）：

- `tests/e2e/e2e.test.ts` 文件级失败：`afterAll` 里的 `git checkout -- 03_evidence/S0/` 撞上另一并行测试文件的同名命令，`fatal: Unable to create '.git/index.lock': File exists`。
- `tests/ci/ci.test.ts`：`PASS demo --ci` 期望退出 0，实得 1——最可能的解释是 5 个测试文件在 `beforeAll` 里并发跑 `tsc` 写同一份 dist/，CLI 在某模块写一半时被 spawn，加载截断文件而退出 1（日志未捕获该次 spawn 的 stderr，未能逐字证实；但同一代码两次全绿、一次失败，且两次失败均为典型的并行共享态竞态，确定性回归可排除）。

根因是共享态操作未同步：本任务把并发构建者从 2 个（cli、ci）增加到 5 个（+ e2e、offline、performance），并增加了第二个并发 `git checkout` 恢复点，使原本低概率的竞态变得可见。

修复分三轮（commit cc9b016、3911f60 与下方“修复 3”）：
- 第一轮（cc9b016）：新增 tests/helpers/test-infra.ts——`buildDistOnce(repoRoot)` 以 OS 临时目录下的原子 mkdir 锁串行化 `npm run build`（锁内记 holder pid，死进程的锁可被夺取；120 s 超时）；`checkoutS0(repoRoot)` 仅在报错含 `index.lock` 时重试 `git checkout -- 03_evidence/S0/`（最多 10 次，间隔 300 ms）。cli / ci / e2e / offline / performance 五个文件的 `beforeAll` 与两处 S0 恢复改用它们。修复后连续 3 次全量 `npm test` 均为 526/526 通过——但随后的 `npm run verify:all` 里 `npm test` 又失败一次，说明第一轮修得不彻底。
- 第二轮（3911f60，根因补查）：这次失败是 e2e.test.ts 的 `verify --fixtures s0` 测试退出 1。查明：`scripts/s0-gate.mjs` 第 1 步自己跑 `npm run build`，且不在第一轮的锁里——两个并行测试文件（cli.test.ts 与 e2e.test.ts）同时跑 gate 时，各自的 gate 构建与各文件的 `beforeAll` 构建互相竞态；两个 gate 还同时写同一份 03_evidence/S0/ 证据。修复：新增 scripts/build-lock.mjs（+ build-lock.d.mts）把锁抽到一处，`scripts/s0-gate.mjs` 第 1 步改用它，test-infra.ts 的 `buildDistOnce` 改为委托同一把锁；e2e.test.ts 不再自己跑 gate（与 cli.test.ts 重复），e2e 测试数由 9 减为 8，全量由 526 变为 525。修复后连续 3 次全量 `npm test` 均为 525/525 通过——但随后的 `npm run verify:all` 里 `npm test` 又失败一次，说明第二轮仍未修到根上。
- 第三轮（根因再补查，见下方“修复 3”）：这次失败是 ci.test.ts 的 `verify --fixtures s0 --ci` 期望退出 3（`--ci` 只用于 audit），实得 1。`verify --ci` 在 CLI 里本应直接 exit 3，实得 1 说明进程根本没跑到参数检查——spawn 时 dist/ 恰在被重写，加载截断模块而退出 1。至此明确：锁只能让构建互斥，**构建与 CLI spawn 之间没有任何互斥**——排队等锁的构建可以在套件开始数秒后才启动，正好撞上其他文件已开始的 CLI spawn。修复：
  - 新增 vitest.config.ts + tests/helpers/global-setup.ts：dist/ 只在套件开始前构建一次，五个文件的 `beforeAll` 构建全部删除（e2e 只保留夹具树哈希快照）。
  - `scripts/s0-gate.mjs` 支持 `SKILLSCOPE_GATE_NO_REBUILD=1`（仅测试用）：套件内 cli.test.ts 的 verify 测试设置该变量跳过 gate 的重建——globalSetup 刚从当前源码构建过 dist，重建既多余又会在套件中途重写 dist/；独立运行（`npm run s0:gate`、`skillscope verify`、scripts/e2e.mjs）永远不设该变量，始终重建。
  - test-infra.ts 只剩 `checkoutS0`（`buildDistOnce` 已无调用者，随之删除）。
- 验证：`npm run typecheck` 0；修复后连续 5 次全量 `npm test` 均为 28 文件、525/525 通过；`npm run verify:all` 连续 2 次 8/8 通过（见 §1）。

## 9. 已知局限

1. **性能基线只适用于本 VM**：测量在 1.5 共享 CPU、负载 0.42–4.4 的云 VM 上进行；其他机器上的数字会不同，但余量很大（扫描余量 13× 以上）。`tests/performance` 用 100 实例 + 宽松界，只做回归哨兵；严格 §10.3 目标以 `npm run test:performance`（500 实例）为准。
2. **截图依赖本地缓存**：e2e.mjs 的截图在 `~/.cache/ms-playwright` 无 headless Chromium 时会跳过（记为 skipped，不失败）；本轮缓存存在，截图成功。截图只证明 HTML 能渲染，不证明交互（产品无交互）。
3. **预演不是冻结**：`03_evidence/T012/rehearsal/` 的 zip 由 T012 中间 commit（495890d）打出；T014 将从 T013 PASS 后的冻结 commit 重新完整执行打包与校验。预演的唯一偏离是干净目录用 symlink 链接本仓库 `node_modules` 代替 `npm ci`（本机不联网）；构建与审计均在该目录内完成。
4. **verify:all 耗时**：全量约 80 秒（含 `npm test` ~45 s）；T013 将直接复用，无需再拆。
5. **Windows 未实测**：本 VM 为 Linux；Windows 路径语义未真机运行，不得声称已测（与 T001 环境报告一致）。
