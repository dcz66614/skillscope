# T001_REPORT.md — 环境探测、工程骨架与接口契约

- TASK_ID: T001（S0）
- BASE_COMMIT: 611a723
- 完成时间 (UTC)：2026-11-13 ~13:02
- 状态：PASS（五条验收命令真实退出码均为 0）

## 验收命令与真实结果

| # | 命令 | 退出码 | 关键输出 |
|---|---|---:|---|
| 1 | `npm ci` | 0 | added 40 packages in 4s；lockfile 与安装前一致（见下） |
| 2 | `npm run typecheck` | 0 | `tsc --noEmit` 无报错 |
| 3 | `npm test` | 0 | vitest 5.1.0；1 个测试文件，10/10 通过（tests/contracts/contracts.test.ts，513ms） |
| 4 | `npm run build` | 0 | `tsc -p tsconfig.build.json`；产出 dist/contracts/index.js（4,622 B），Node 导入验证通过，AUDIT_STATUSES = ["PASS","FAIL","INCOMPLETE"] |
| 5 | `npm run test:oracle` | 0 | `python3 -m unittest discover -s oracle/tests`；Ran 11 tests，OK（0.003s） |

## 交付文件

| 文件 | 字节 | 说明 |
|---|---:|---|
| package.json | 1,079 | 冻结 scripts（§3.3 全量 17 个脚本名）；无 license 字段；runtime 依赖为零 |
| package-lock.json | 40,500 | sha256 `80d02945516fe1cbe22e6a51f97e869eb72eea27ca94c761f4dff361d70bf03d`；npm ci 前后一致；lockfileVersion 3；71 个包 |
| tsconfig.json | 289 | strict + noUncheckedIndexedAccess；target ES2022；module NodeNext；include src + tests |
| tsconfig.build.json | 186 | 继承 base；仅编译 src；outDir dist |
| .gitignore | — | node_modules/、dist/、coverage/、__pycache__/、*.pyc |
| src/contracts/index.ts | 6,909 | §4 合同：EngineId / SourceRootV1 / SkillInstanceV1 / ProfileV1 / ReportV1 + validate* 运行时校验 + isDistinctInstance 身份规则 |
| tests/contracts/contracts.test.ts | 3,594 | 10 个测试：合同校验、同名异路径为不同实例、非法哈希/状态/引擎拒绝、AUDIT_STATUSES 三态 |
| oracle/python/__init__.py | 409 | Oracle 包说明（stdlib only） |
| oracle/python/canonical.py | 1,641 | 规范 JSON + SHA-256（UTF-8、LF、NFC、键排序、紧凑分隔符、数组保序）——T008 的 TS 侧须与之逐字节一致 |
| oracle/python/reference_resolver.py | 968 | 接口占位：resolve() 在 T004 实现前显式抛 NotImplementedError，绝不以生产输出冒充真值 |
| oracle/tests/test_canonical.py | 2,811 | 11 个测试：键排序、NFC 等价、数组保序、哈希确定性、与独立 hashlib 计算一致 |
| scripts/env/probe.mjs | 3,473 | §3.1 环境探测脚本（只读），输出 03_evidence/T001/env-probe.json |
| 00_control/ENVIRONMENT_REPORT.md | 2,662 | 实测环境报告（见下） |
| 00_control/DECISION_LOG.md | 1,956 | ADR-001、ADR-002、版本锁定、OPEN-001/002/003 |
| 00_control/PROJECT_STATE.json | 260 | t001_status = PASS（本报告提交时更新） |
| 00_control/TASK_BOARD.csv | 658 | T001 PASS；T002/T003 待派发 |
| 03_evidence/T001/env-probe.json | 2,044 | sha256 `b512532dba48ebb3ae739d5f938347c9aa6af1815bbabfd536e21eb1399c9d57` |

## 环境实测摘要（全文见 ENVIRONMENT_REPORT.md）

- Linux htch-runtime 7.0.0-44-generic x86_64；CPU 4 核 AMD EPYC 9D25；内存 8,319,893,504 B（探测时空闲仅约 611 MiB，偏紧）；磁盘可用约 130 GiB。
- Node v24.22.1；npm 10.9.4；Python 3.12.3（PyYAML 6.0.1 可用）；git 2.43.0；linux x64。
- 系统 PATH 无浏览器；`~/.cache` 有 Chrome-for-Testing / Playwright chromium 缓存，未探测可运行性（T012 决定）。
- Node 24.22.1 标准库无 TOML 解析器（实测 absent）→ OPEN-001 由 T002 锁定 TOML 依赖。
- npm registry 可达；版本锁定：typescript 5.9.3（规格要求 5.x；registry 最新 7.0.2 未采用）、vitest 5.1.0、@types/node 24.19.2。

## 决策记录

- ADR-001：源码树置于仓库根（src/、oracle/、tests/、scripts/、docs/），不采用 §10 的 `02_source/` 嵌套布局——§3.3 冻结脚本用根相对路径，空目录 `02_source/` 已删除。
- ADR-002：测试框架选用 Vitest 5.1.0，与 §3.3 默认脚本形式一致；备选 Node 内置 runner，切换须另立 ADR。

## 已知局限

- `s0:gate`、`s0:repeat`、`test:mutation`、`test:e2e`、`test:offline`、`test:performance`、`verify:all`、`release:build`、`release:verify` 九个脚本名已按 §3.3 冻结，但其实现文件分属 T004/T011/T012/T014，当前不存在——此刻运行会诚实失败（模块不存在），不是已实现。T001 验收不包含它们。
- `reference_resolver.py` 的 resolve() 在 T004 前显式抛错；Oracle 目前只有 canonical 工具通过测试。
- 探测时空闲内存仅约 611 MiB；后续全量测试如遇内存不足，先降并发再排查，不得误判为产品缺陷。
- 未触碰真实宿主配置、真实 SKILL.md、任何凭证；零真人参与。

## 下一步

NEXT_TASK: T002（Codex PoC）与 T003（Claude + OpenMausBot PoC）可并行派发，均依赖 T001 PASS commit。
