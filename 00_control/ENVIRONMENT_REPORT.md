# ENVIRONMENT_REPORT.md — P023 SkillScope (T001)

- 探测时间 (UTC)：2026-11-13T13:00:23Z
- 探测脚本：`scripts/env/probe.mjs`（只读）
- 原始记录：`03_evidence/T001/env-probe.json`（sha256 `b512532dba48ebb3ae739d5f938347c9aa6af1815bbabfd536e21eb1399c9d57`）
- 工作区绝对路径：`/home/hatch/workspace/p023-skillscope`

## 操作系统与硬件（实测）

| 项目 | 实测值 |
|---|---|
| OS | Linux htch-runtime 7.0.0-44-generic #1 SMP PREEMPT_DYNAMIC Fri Nov 6 01:23:31 UTC 2026 x86_64 |
| CPU | 4 核，AMD EPYC 9D25 126-Core Processor |
| 内存总量 | 8,319,893,504 B（约 7.75 GiB） |
| 探测时空闲内存 | 640,999,424 B（约 611 MiB）——偏紧，重型测试需注意峰值 |
| 磁盘总量 | 161,042,399,232 B（约 150 GiB） |
| 磁盘可用 | 139,979,546,624 B（约 130 GiB） |
| 平台 | linux x64 |

## 工具链（实测）

| 工具 | 实测版本 |
|---|---|
| Node.js | v24.22.1（符合 Node.js 24 LTS 要求） |
| npm | 10.9.4 |
| Python | 3.12.3（GCC 13.3.0，2026-08-31 构建） |
| git | 2.43.0 |
| PyYAML（系统） | 6.0.1（Oracle 可用；优先标准库） |
| Node 内置 TOML | absent——Node 24.22.1 标准库无 TOML 解析器，T002 需锁定 TOML 依赖 |

## 浏览器

- 系统 PATH 内无 chromium / chromium-browser / google-chrome / firefox。
- `~/.cache` 内有 Chrome-for-Testing headless 与 Playwright chromium 缓存（chromium-1248、chromium-1254、chromium_headless_shell-1248），未在本轮探测其可运行性；T012（E2E）自行决定是否使用，测试过程不得下载浏览器或外部依赖。
- Windows 未实测：本 VM 为 Linux；Windows 路径语义只用合成 fixture 测试，未真机运行不得声称 Windows 已实测。

## 网络与依赖来源

- npm registry（https://registry.npmjs.org/）可达；T001 依赖由此安装并锁定于 package-lock.json。
- 产品运行时保持离线（audit 命令不得发起外部请求）；依赖准备只在施工环境进行。

## 版本锁定（T001 冻结）

| 依赖 | 锁定版本 | 说明 |
|---|---|---|
| typescript | 5.9.3 | 规格要求 TypeScript 5.x；registry 最新为 7.0.2，未采用 |
| vitest | 5.1.0 | 测试框架（见 ADR-002） |
| @types/node | 24.19.2 | 与 Node 24 运行时对应 |

## 注意事项

- 本 VM 存在 EPERM 存储抖动：写文件后须验证大小 + SHA-256，失败重试；git 遇 index.lock 报错时重试。
- 探测时空闲内存仅约 611 MiB；后续全量测试（T011/T012）如遇内存不足，先降并发再排查，不得把失败误判为产品缺陷。
- 历史环境记录不代替本轮实测；本报告即本轮实测。
