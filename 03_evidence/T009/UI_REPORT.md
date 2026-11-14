# P023 T009 任务报告 — CLI 主流程与静态 HTML 报告（S3）

- 任务：T009｜CLI 主流程与静态 HTML 报告（S3，7h）
- 基线：`ed33ca2`（T008b PASS）；代码提交见 git log；控制文件提交见 git log
- 验收方式：以下命令全部真实运行，退出码均为 0（`npm run demo` 本身退出 0；三个演示 audit 按设计分别返回 1/0/2）

## 验收命令（真实退出码与关键输出）

| 命令 | 退出码 | 结果 |
|---|---|---|
| `npm run typecheck` | 0 | 通过 |
| `npm run test:cli -- --run` | 0 | **13/13**（audit 退出码与报告形状 8；HTML 2；init 1；CLI 二进制 2；verify 1） |
| `npm run demo` | 0 | codex-fail json/html 退出 1（预期 1）；claude-pass 退出 0（预期 0）；openmausbot-incomplete 退出 2（预期 2）；外部资源 0/0/0；同一 profile 两次审计 JSON 字节相同；截图真实生成 |
| `npm run build` | 0 | 通过（`dist/cli/index.js`，bin `skillscope`） |
| `npm run s0:gate` | 0 | GATE PASS；parity 48/48；检出 24/24；误报 0/24；100 次重放 1 哈希；gate_sha256 `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca` **不变** |
| `npm test`（全套，附加） | 0 | **426/426**（T008b 时 413 + 新增 13） |
| `npm run test:oracle`（gate 内） | 0 | 42/42（gate 输出） |

## 交付文件

- `src/cli/index.ts` — 入口与参数解析（`init` / `audit` / `verify`；`--help`）；退出码 0/1/2/3/4；§0.1 样式控制台摘要
- `src/cli/audit.ts` — profile 加载（`loadProfile`）、profile→适配器接线、ReportV1 构建/脱敏/哈希/写盘；policy 一律透传内核（ADR-005）
- `src/cli/init.ts` — `init` 写 starter `skillscope.json`（合成 home `./.skillscope-home`，首审不读真实 home）；已存在时拒绝覆盖（退出 3）
- `src/cli/verify.ts` — `verify --fixtures s0` 委托给冻结的 `scripts/s0-gate.mjs`（不另写一份 gate；退出码透传）
- `src/report/index.ts` — 静态 HTML 渲染（Scope Matrix / Findings / Coverage / 哈希；内联 `<style>`，零外部资源）+ `scanExternalResources`；渲染器不重算 verdict，只打印 `audit.status`
- `scripts/demo.mjs` — 演示运行器（`npm run demo`）：三 profile 审计、外部资源扫描、确定性复核、headless Chromium 截图
- `tests/cli/cli.test.ts` — 13 测试（见上表）
- `tests/fixtures/demo/{codex-fail,claude-pass,openmausbot-incomplete}/` — 演示夹具：三引擎 × 三状态
- `package.json` — 新增 `bin.skillscope`（`dist/cli/index.js`）、`test:cli`、`demo`；零新增依赖
- `03_evidence/T009/demo/` — 演示证据：三份 JSON 报告、三份 HTML 报告、截图 PNG、demo-stdout.log、external-scan.log
- `00_control/DECISION_LOG.md` — ADR-013（报告哈希定义、profile→适配器映射约定）

## 关键行为（均有测试证明）

- **三态与退出码**：codex-fail → FAIL / 1（NAME_SELECTOR_BLAST_RADIUS，`deploy` name selector 命中 2 个不同实例，两个 deploy 均 DISABLED，release 仍 ELIGIBLE；expected 1，observed 3，coverage 5/5）；claude-pass → PASS / 0（2 实例）；openmausbot-incomplete → INCOMPLETE / 2（无 snapshot，SOURCE_NOT_ENUMERATED，unknown SNAPSHOT，coverage 1/2，observed_count null，符合 §6.3）。
- **策略透传（ADR-005）**：profile policy（snake_case）映射为 PolicyV1 后一律传给内核；forbidden_names `release` 的回归测试复现 DISABLE_MISMATCH（Codex PoC 从不产生该 Finding，证明来自内核）。有效集 = ELIGIBLE（ADR-006）继续适用。
- **报告哈希（ADR-013）**：inventory_sha256 = canonicalSha256(instances)；audit_sha256 = canonicalSha256（audit_sha256 为 null 的报告其余部分）；oracle_result_sha256 = null（CLI 从不跑 Python Oracle，null 是诚实值不是缺口）。报告先经 `redactReport` 再哈希、写盘，并过 frozen schema 校验。
- **HTML/JSON 一致**：HTML 内嵌的 canonical ReportV1 JSON 解析后与 JSON 报告文件逐值相等；同一 audit 两次渲染字节相同；HTML 含 Scope Matrix、Findings、Coverage、哈希与三态明确文字；外部资源扫描 0 命中（三份报告）。
- **脱敏**：temp 目录复本审计的 JSON/HTML 均不含该绝对路径（grep 0 命中）；`demo-stdout.log` 是本地控制台日志，其中 `Report:` 行含本机输出路径——不是共享报告，不在脱敏范围内。
- **verify**：委托冻结 gate；测试内跑 gate 通过后用 `git checkout` 恢复 03_evidence/S0/（gate 只改 base_commit 标签）。
- **`--engine/--cwd` 形式**：读 `<cwd>/skillscope.json`，无 profile 时退出 3 并提示先 `init`；CLI 从不猜测宿主根目录。`--ci` 属于 T010，本任务明确拒绝（退出 3）。

## 设计决定（ADR-013，全文见 DECISION_LOG）

1. **报告哈希定义**（见上“报告哈希”）。
2. **profile→适配器映射约定**：全部 profile 路径相对 profile 文件所在目录；codex 的 config.toml / bundled.json / plugins.json 在 profile 目录存在时读取、不存在时缺席（SYSTEM/PLUGIN 按 PoC 规则报 unknown，绝不静默当空）；ADMIN 根取 ADMIN source root 路径的 dirname；OMB 的 dataDir `./data`、snapshot `./snapshot.json`（缺席即 INCOMPLETE），botId = profile_id，env 强制 `{}`（真实 OMB_DATA_DIR 绝不参与）；claude 的 settings 层按 home_root / repo_root 默认解析。
3. **verify 不重写 gate**：委托 `scripts/s0-gate.mjs`，避免第二份 gate 实现漂移。
4. **矩阵只列有实例或 unknown 的 scope 列**：ADMIN/SYSTEM/PLUGIN 在 codex-fail 中已枚举但为 0 实例时不单独成列；完整性由 Coverage 行（5/5）与 unknown 列表承担。

## 已知局限

- `--engine/--cwd` 需要 profile 文件；真实仓库的一键扫描（无 profile）不在本任务范围，属 T010/后续。
- OMB 的 botId 取 profile_id；多 Bot 同一 profile 的审计需多 profile 文件。
- HTML 矩阵为单 profile 单行；多 profile 对照报告不在本任务范围。
- `oracle_result_sha256` 恒为 null；Oracle 对照只在 S0 gate 与测试里跑。
- 截图依赖本机 Playwright 缓存的 headless Chromium；缓存缺失时 demo 跳过截图并记录，不失败（本次实测生成 1280×1100 PNG，136,209 字节）。

## 证据（03_evidence/T009/demo/，SHA-256 前 16 位）

- codex-fail.report.json `62796cd1b905b7c3`（FAIL，audit `948f94149b3a451f…`）
- codex-fail.report.html `3093097c2eee3255`
- codex-fail.report.png `b88e872be6583be2`（1280×1100，已目视确认：FAIL 横幅、矩阵、Coverage、Finding、实例、哈希齐全）
- claude-pass.report.json `865a35b6feee9d1d` / .html `b0fea4333dc3edc6`
- openmausbot-incomplete.report.json `377dfa612e1a818b` / .html `d3caa60195d534e6`
- demo-stdout.log `9b174cc52d527a44`、external-scan.log `59f55bd4ddf190e6`（三份报告各 0 外部资源命中）
