# P023 规格核实记录（Muse 亲自核实，2026-11-13 ~12:57 GMT）

## Drive 归档核实：通过

- 文件夹：agent project auto / P023-skillscope（id 1e7G3achqvlbIpu5rTSxEk2jvrsRlJIFS，建于 12:34:08Z）/ 00_spec（id 15IiNTdyBBEPkRc6dE1MH9GjmsM4AgLb8，建于 12:34:10Z）
- PROJECT_BOOK.md：31,870 B，id 1t_dAMpCSTiRGYqHsXViuGA3kLb0DQNcp，sha256 73b9baa718c576cb01a61f2e88f82e49031729d648752b31a14004f8a29f0922
- IMPLEMENTATION_PLAN.md：34,795 B，id 1Z4lCAmki7V2SVZaHoUAoP92mSfgAHU5T，sha256 f9fab1b151f3e10c17ed452661a9557c0684441c52175464ee91bb6ed4b4fd08
- GPT 声称的字节数与 Drive 实际完全一致（本次没有虚报）；00_spec 内仅此两文件，无重复。
- 本地副本：~/workspace/P023_PROJECT_BOOK.md、~/workspace/P023_IMPLEMENTATION_PLAN.md（已从 Drive 下载，字节数与 SHA 一致）。

## 内容核实：通过（附注）

- SPEC_VERSION 1.0.0，SPEC_FROZEN / NOT_IMPLEMENTED，PLAN_STATUS READY_FOR_S0_ONLY，GO NOT DECLARED。
- LICENSE PENDING_SAM_DECISION（未擅自定死）。ZERO_HUMAN_PARTICIPANTS（零真人）。
- S0–S5、T001–T014 齐全；工时 72h + 16h 缓冲 = 88h；S0 = T001–T004（17h）。
- S0 硬门：固定 seed P023-SKILLSCOPE-S0-2026-11-13；48 个合成 fixture（每宿主 16：8 控制 + 8 植入偏差）；48/48 Oracle parity；24/24 植入检出；0/24 控制误报；100 次重放 1 个 gate hash；外部请求 0；源目录写操作 0；真人 0。
- 核心规则模型：三宿主独立 adapter（Codex / Claude Code / OpenMausBot），身份按规范路径 + 内容 SHA-256（不用逻辑名作唯一身份），name selector blast radius，fail-open 必须 INCOMPLETE / FAIL，UNKNOWN 不得折算 PASS。Python Reference Oracle 独立实现，不得共享生产算法。
- 证据边界诚实：痛点量化明确标注为规划假设（NOT_MEASURED，未实测）；#5449 标注了后续修复提议（#5450、#5454、#5488），不声称九项全部未修复；高 Star 潜力标注为产品假设、不是承诺；规格中不填虚构哈希。
- 三个关键工程决定已冻结：分宿主规则（不用通用目录扫描器冒充）、只读不控权、未知不等于安全。
- 实施计划 §1.1 称“Sam 明确授权启动后，才可派发 T001”——Sam 2026-11-13 11:59 GMT 已明确说“继续p023不用等我说”，视为启动授权，S0 按此推进。

## 发现与修正

- GPT 回复称对话标题无法由它改名——浏览器方已在界面上改名为 P023-SkillScope，实际已解决。
- GPT 未把两份 Drive 文件加入 ChatGPT 项目「量产项目」的项目来源——未完成，留待以后统一处理（P012–P022 同样未加）。

## 结论

规格 ACCEPTED，可进入 S0。工作目录 ~/workspace/p023-skillscope/，规格存入 01_spec/。下一步：派发 T001。
