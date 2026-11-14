# README / Demo 证据报告（P023 T010）

- 任务：T010｜CI 模式、退出码、README 与开箱 Demo
- 基线：`fbc6521`（T009 PASS）
- 日期：2026-11-13

## README 截图

`03_evidence/T010/readme-first-screen.png`（213,564 B，sha `aebee291…`）——README 首屏的真实渲染截图，由 `scripts/t010-evidence.mjs` 用本机 Playwright 缓存的 headless Chromium 生成，已目视确认：标题、痛点提问、说明段、Read-only / Local-first / No LLM / No telemetry 标识、Scope Matrix 截图（FAIL 横幅、矩阵、Coverage、Finding、实例、哈希）、图注、Install 小节齐全。渲染用的 HTML 在同目录 `readme-first-screen.html`（图片路径已转绝对路径，仅渲染副本如此；README 本身保持相对路径）。

README 内嵌的矩阵图为 `docs/images/scope-matrix.png`（136,209 B，sha `b88e872b…`，与 T009 演示截图 `03_evidence/T009/demo/codex-fail.report.png` 同 sha，复制而来，未重生成）。

## 命令日志

完整日志见 `03_evidence/T010/command-log.txt`（10 条实测命令）。摘要：

```text
$ node dist/cli/index.js audit --profile .../codex-fail/profile.json --out ... → exit 1 (expected 1), stdout lines: 8
$ node dist/cli/index.js audit --profile .../codex-fail/profile.json --ci --out ... → exit 1 (expected 1), stdout lines: 1
$ node dist/cli/index.js audit --profile .../claude-pass/profile.json --out ... → exit 0 (expected 0), stdout lines: 6
$ node dist/cli/index.js audit --profile .../claude-pass/profile.json --ci --out ... → exit 0 (expected 0), stdout lines: 1
$ node dist/cli/index.js audit --profile .../openmausbot-incomplete/profile.json --out ... → exit 2 (expected 2), stdout lines: 5
$ node dist/cli/index.js audit --profile .../openmausbot-incomplete/profile.json --ci --out ... → exit 2 (expected 2), stdout lines: 1
$ node dist/cli/index.js audit --profile .../nope.json --ci --out ... → exit 3 (expected 3)
$ node dist/cli/index.js audit --profile .../claude-pass/profile.json --ci --out .../no-such-dir/out.json → exit 4 (expected 4)
$ node dist/cli/index.js init --ci --dir ... → exit 3 (expected 3)
$ node dist/cli/index.js audit --profile .../codex-fail/profile.json --ci --bogus → exit 3 (expected 3)
```

## Exit Code 矩阵

完整矩阵见 `03_evidence/T010/exit-code-matrix.json`（schema `skillscope.t010-exit-code-matrix/v1`，10 条）。全部实测退出码与合同一致：

| 场景 | 模式 | 退出码 | stdout 行数 |
|---|---|---|---|
| codex-fail（FAIL） | 正常 | 1 | 8 |
| codex-fail（FAIL） | --ci | 1 | 1 |
| claude-pass（PASS） | 正常 | 0 | 6 |
| claude-pass（PASS） | --ci | 0 | 1 |
| openmausbot-incomplete（INCOMPLETE） | 正常 | 2 | 5 |
| openmausbot-incomplete（INCOMPLETE） | --ci | 2 | 1 |
| 缺失 profile | --ci | 3 | 1（`RESULT=ERROR`） |
| 写报告路径不存在 | --ci | 4 | 1（`RESULT=ERROR`） |
| `--ci` 用于 init | — | 3 | — |
| 未知选项 `--bogus` | --ci | 3 | — |

INCOMPLETE 在 --ci 下仍为 2，未弱化；写盘失败时 CI 行印 `RESULT=ERROR` 而非 `RESULT=PASS`。

## Demo

`npm run demo` 退出 0：三演示 1/0/2 符合预期，外部资源 0/0/0，同一 profile 两次审计 JSON 字节相同，截图 136,209 B。Demo 不需要账号、LLM、网络或真实技能（离线检查第 2 项在死代理下重跑三演示，退出码不变）。

## 工作流

`.github/workflows/skillscope.yml`（58 行）：checkout → setup-node 24 → `npm ci` → `npm run build` → 用本地 CLI 审计 demo PASS profile（`--ci`）→ `verify --fixtures s0` → 上传报告 artifact。审计步骤只调用 `node dist/cli/index.js`，不调用远程 action、不下载、不上传报告内容以外之物。YAML 语法已用 Python `yaml.safe_load` 检查通过（本机无法运行真实 GitHub Actions，该步骤未在 GitHub 上跑过）。

## 离线证据

`npm run test:offline` 退出 0：静态扫描零网络调用点、`dist/` 零 `https://`、死代理三演示退出码不变且报告零 URL、HTML 外部资源 0 命中、README / docs / workflow 零 `https://`。
