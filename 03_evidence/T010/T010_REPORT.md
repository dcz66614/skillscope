# P023 T010 任务报告 — CI 模式、退出码、README 与开箱 Demo（S3）

- 任务：T010｜CI 模式、退出码、README 与开箱 Demo（S3，5h）
- 基线：`fbc6521`（T009 PASS）
- 代码提交：`52d8d7b`；控制文件提交见 git log（TASK_BOARD T010→PASS、T011→READY、PROJECT_STATE `S3_T010_PASS`、DECISION_LOG ADR-014）
- 状态：PASS（全部验收命令真实跑过，退出码均为 0）
- 报告日期：2026-11-13

## 交付物

| 文件 | 行数 / 大小 | SHA-256 前 16 位 | 说明 |
|---|---|---|---|
| `src/cli/index.ts`（修改） | 223 行 | `662a803d…` | `--ci` 布尔标志；CI 模式单行机读输出；`--ci` 只用于 audit |
| `tests/ci/ci.test.ts`（新增） | 225 行 | `f0bb71e3f…` | 8 个测试：退出码矩阵 + 错误分支 |
| `tests/cli/cli.test.ts`（修改 1 行） | — | — | T009 的 `--ci` 拒绝断言改为接受（见下） |
| `scripts/offline-check.mjs`（新增） | 222 行 | `9f12ac3c…` | 离线检查：静态扫描 + 死代理运行 + 输出扫描 + 文档扫描 |
| `scripts/t010-evidence.mjs`（新增） | 297 行 | `f3de570d…` | 证据脚本：exit-code 矩阵 + 命令日志 + README 首屏截图 |
| `README.md`（新增） | 116 行 | `56334ef6…` | 首屏按 PROJECT_BOOK §11.1；零外部 URL |
| `docs/quickstart.md`（新增） | 115 行 | `28d23bb6…` | 安装 → 首审 → CI → demo → 自验 |
| `docs/host-rules.md`（新增） | 52 行 | `53bc40b7…` | 三宿主冻结规则与未覆盖项 |
| `docs/images/scope-matrix.png`（新增） | 136,209 B | `b88e872b…` | 与 T009 演示截图同 sha（复制，未重生成） |
| `.github/workflows/skillscope.yml`（新增） | 58 行 | `19692ea1…` | 只调用本地 CLI；demo PASS 审计 + S0 gate |
| `03_evidence/T010/exit-code-matrix.json` | 2,335 B | `4404e06e…` | 10 条实测矩阵记录 |
| `03_evidence/T010/command-log.txt` | 2,134 B | `f89f4c51…` | 全部实测命令与输出 |
| `03_evidence/T010/readme-first-screen.png` | 213,564 B | `aebee291…` | README 首屏真实渲染截图（目视确认） |
| `03_evidence/T010/readme-first-screen.html` | 1,651 B | — | 截图用的渲染后 HTML（图片路径已转绝对路径） |
| `03_evidence/T010/README_DEMO_REPORT.md` | — | — | README / Demo 证据汇总（计划交付物） |
| `package.json`（修改） | +1 行 | — | 新增 `"test:ci"`；零新增依赖 |

## `--ci` 模式（ADR-014）

- `audit --profile <path> --ci` / `audit --engine <e> --cwd <dir> --ci`：抑制多行 §0.1 控制台摘要，stdout 恰好一行机读输出：`skillscope: RESULT=<STATUS|ERROR> exit=<code>[ report=<path>]`；报告文件照常写盘；退出码不变。
- 退出码：0 PASS、1 FAIL、2 INCOMPLETE、3 输入/配置错误、4 内部错误。INCOMPLETE 在 CI 模式下仍为 2，绝不弱化为 0。
- `RESULT=` 一词只在报告成功写盘时取审计状态；写盘失败（exit 4）时印 `RESULT=ERROR`——审计本身 PASS 但报告没写出来时，CI 行绝不能谎称 PASS（实现中发现并修复，见下）。
- `--ci` 用于 `init` / `verify` 时为输入错误（exit 3）。未知选项仍为 exit 3。

## 离线检查（`npm run test:offline`）

四重独立检查，全部通过：

1. 静态扫描：`src/`、`scripts/*.mjs`、`dist/` 无网络调用点（fetch、http/https request/get、net.connect、WebSocket、axios、undici、XMLHttpRequest），`dist/` 的 JS 里零 `https://` 字符串。
2. 死代理运行：三演示审计在 `http_proxy/https_proxy` 指向黑洞地址（127.0.0.1:9）时仍返回冻结退出码 1/0/2。
3. 输出扫描：死代理运行产出的 JSON/HTML 报告零 `http://` / `https://`，HTML 过 `scanExternalResources` 为 0 命中。
4. 文档扫描：`README.md`、`docs/`、`.github/workflows/` 零 `https://` 字符串。

## 验收命令（真实退出码）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run test:ci -- --run` | 0 | 8/8 通过 |
| `npm run demo` | 0 | 三演示 1/0/2 符合预期；外部资源 0/0/0；确定性字节相同；截图 136,209 B |
| `npm run test:offline` | 0 | 四重检查全部 PASS |
| `npm run build` | 0 | 通过（`dist/cli/index.js`，bin `skillscope`） |
| `npm run s0:gate` | 0 | GATE PASS；parity 48/48；检出 24/24；误报 0/24；100 次重放 1 哈希；gate `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca` **不变** |
| `npm test`（全套，附加） | 0 | **434/434**（21 文件；T009 时 426 + 新增 8） |
| `npm run test:cli -- --run` | 0 | 13/13 通过 |

## 测试中发现并修复的三个真实问题（非占位）

1. **exit 4 时 CI 行谎称 PASS**：报告写盘失败（`--out` 指不存在的目录）时，审计本身是 PASS，初版 CI 行印 `RESULT=PASS exit=4`。已修复：只有报告成功写盘才印审计状态，否则印 `RESULT=ERROR`。回归测试覆盖（`tests/ci` 的 exit 4 用例）。
2. **离线检查把自己扫出来**：`scripts/offline-check.mjs` 的模式列表本身含有 `axios`、`undici`、`XMLHttpRequest` 字面词，静态扫描报自身 3 处违规。已修复：扫描排除检查脚本自身（注释注明原因）；产品代码与 `dist/` 本身零命中。
3. **T009 测试的 `--ci` 调用无 `--out`**：T009 时 `--ci` 被拒绝（exit 3），调用不写报告；T010 接受 `--ci` 后，同一调用按默认路径把报告写进了夹具树（`tests/fixtures/demo/codex-fail/profile.report.json`）。已修复：该调用补显式 `--out` 到临时目录，杂散文件已删除，夹具树干净；并在测试里加注释防重犯。
4. **全量并行时两个 `beforeAll` 构建超时**：`tests/ci` 与 `tests/cli` 的 `beforeAll` 各跑一次 `npm run build`；全量 21 worker 并行时两个 `tsc` 在小 VM 上抢 CPU，超过 Vitest 默认 10 秒 hook 超时（两文件各 8 / 2 个测试被跳过，全量一度报 424 通过 + 10 跳过）。测试本身无问题（单独跑 8/8、13/13，早期全量也曾 434/434）。已修复：两处 `beforeAll` 显式加 120 秒超时（同文件 gate 测试已有 300 秒先例）；修复后全量连续两次 434/434。修复提交见下。

## T009 测试的 1 行改动（说明）

`tests/cli/cli.test.ts` 第 330 行：T009 断言 `audit … --ci` 退出 3（当时 `--ci` 明确属于 T010 且被拒绝）。T010 实现 `--ci` 后该断言失效，改为断言退出 1（codex-fail 审计），并补 `--out` 到临时目录、补未知选项仍退出 3 的断言。改动原因是任务边界变化，不是修 T009 的 bug；其余 12 个测试未动。

## README 诚实性

- 首屏按 PROJECT_BOOK §11.1：痛点提问、Scope Matrix 截图、安装命令、audit 命令、三 Finding Demo、PASS / FAIL / INCOMPLETE 解释、Read-only / Local-first / No LLM / No telemetry 标识。
- 样例输出逐字取自 `03_evidence/T009/demo/demo-stdout.log`（codex-fail），仅把绝对路径前缀略写为 `.../` 并注明。
- 数字全部实测：S0 门 48/48 parity、24/24 检出、0 误报、100 次重放 1 哈希；demo 退出码 1/0/2；全量测试 434/434。
- 未写任何未经测量的 Stars、用户数、市场规模或性能成绩；§10.3 的性能目标是目标不是成绩，未写入 README。
- 未宣称支持未完成宿主版本；未宣称 `npx skillscope` 可用（未发布，README 只写本地可跑的命令）。
- License 一节如实写 PENDING_SAM_DECISION，无 LICENSE 文件，`package.json` 无 license 字段。
- README、`docs/`、workflow 零 `https://` 字符串（离线检查第 4 项覆盖）。

## 已知局限

- `--ci` 的单行输出不含 finding 明细；CI 要明细请读报告文件。
- 离线检查的静态扫描只认已知网络调用模式；未知库的网络调用不在保证内（与 T008b 的密钥扫描同类局限）。
- README 截图依赖本机 Playwright 缓存的 headless Chromium；缓存缺失时证据脚本记录 skipped，不失败（本次真实生成）。
- GitHub Actions 示例未在真实 GitHub 上跑过——本机无法跑 Actions；它只调用本地 CLI（checkout / setup-node / upload-artifact 除外，均为标准步骤），YAML 已做语法检查（见 README_DEMO_REPORT.md）。
- 工作流审计的是仓库自带的合成 PASS 演示 profile；真实用法见 workflow 内注释掉的示例步骤。
