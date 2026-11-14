# P023 规格回复原文（GPT-6 + Extra High，2026-11-13 ~12:56 GMT）

对话：https://chatgpt.com/g/g-p-6ade5013e8ec8191b55dca46c27772e1-agent-project-automatic/c/6af6fc6f-e818-83ed-a355-3c0a05c32e57
标题：P023-SkillScope（浏览器方已改名；GPT 称自己无法操作标题编辑）
思考用时：页面显示 23m 24s
模型：GPT-6 + Extra High（Pro 锁定不可用）

以下为 GPT 回复原文，一字不改：

---

# P023 SkillScope｜正式规格编制

方向已锁定：GO　规格版本：1.0.0

项目正式名称：SkillScope 技能作用域镜

英文定位：Know exactly which skills each agent can load, where they came from, and whether the effective scope matches your configuration.

本轮将按照正式立项处理，不再重新比较候选方向。

## 一、先冻结三个关键工程决定

外部官方资料核查带来一个重要修正：不同 Agent 的技能加载规则并不相同，不能用一个通用目录扫描器冒充真实加载器。

| 平台 | 已核实的规则 | 对 SkillScope 的影响 |
|---|---|---|
| Codex | 项目 .agents/skills、用户 ~/.agents/skills、管理员 /etc/codex/skills、系统内置技能；项目路径沿当前目录向仓库根目录扫描 | 必须按来源和规范路径识别，不能只按技能名称去重 |
| Claude Code | 用户、项目、嵌套目录、企业、额外目录、插件及账号同步技能存在不同加载范围 | 必须保留来源优先级、命名空间和会话类型 |
| OpenMausBot | Bot 技能开关、原生技能、共享技能库、个人技能及插件来源可能存在不同路径 | 必须把 Bot 配置与实际引擎技能来源分开核对 |

特别是 Claude Code：同名技能并非一律冲突覆盖。插件技能使用命名空间，项目根目录和嵌套技能也可以同时存在。SkillScope 必须按照平台规则处理，而不是强行统一。

第二个关键决定：只读，不代替宿主执行权限控制。

SkillScope 输出的是配置与有效作用域的一致性证据，不会替 Codex、Claude 或 OpenMausBot 禁用技能、修改权限或拦截模型调用。

第三个关键决定：未知不等于安全。

如果账号同步技能、远程插件或运行时技能无法完整枚举，结果必须标记 UNKNOWN 或 INCOMPLETE，不能把静态目录扫描通过写成运行时隔离通过。

## 二、最新核查到的重要证据

OpenMausBot #5449 确实存在，2026-11-11 创建，当前页面仍显示 Open。它列出的九类问题包括：

- 按名称禁用导致同名技能误伤。
- 配置无法读取时 fail-open。
- ~/.agents/skills 漏列。
- 导入技能关闭后原始目录仍被加载。
- 插件技能进入 Bot 会话但缺少对应开关。

不过，这个 Issue 后续已有部分修复提议及提交，插件问题也有后续处理。因此，规格将它作为真实故障模式和合成测试来源，而不会声称九项问题目前全部仍未修复。

官方依据：

- Codex / ChatGPT Skills 文档
- Claude Code Skills 官方文档
- Agent Skills 开放规范
- OpenMausBot #5449

这些资料将作为规格中的规范依据，而不是把某个平台的实现推断成其他平台的行为。

## 三、两份正式规格已生成并归档

Google Drive 上传成功，已回读核验

P023-skillscope

agent project auto / P023-skillscope / 00_spec

打开 P023 项目文件夹　打开 00_spec 子文件夹

PROJECT_BOOK.md　项目书 · 31,870 bytes　已核验　打开 Google Drive 文件　Open 下载 PROJECT_BOOK.md

IMPLEMENTATION_PLAN.md　实施计划 · 34,795 bytes　已核验　打开 Google Drive 文件　Open 下载 IMPLEMENTATION_PLAN.md

两份文件均已通过 Drive 回读，确认文件名、MIME 类型和正文内容。临时重复文件已清理，00_spec 最终保留两份正式 Markdown 文件。

## 四、规格冻结摘要

| 项目 | 冻结决定 |
|---|---|
| 项目编号 | P023 |
| 产品 | SkillScope 技能作用域镜 |
| 版本 | 1.0.0 |
| 宿主 | Codex / Claude Code / OpenMausBot |
| 真人参与 | 0 |
| 独立 Oracle | Python Reference Oracle |
| S0 | T001–T004，48 个合成案例 |
| 后续任务 | T005–T014 |
| 阶段 | S0–S5 |
| 基准工时 | 72h |
| 缓冲 | 16h |
| 总工时预算 | 88h |
| 许可证 | PENDING_SAM_DECISION |

特别强调：目前只完成规格编制与归档，没有启动 T001，也没有声称 S0 已通过。

## 五、尚未完成的两项操作

1. ChatGPT 对话标题：我无法直接操作当前界面的标题编辑功能。请将标题设为 P023-SkillScope。
2. ChatGPT 项目来源：尚未将这两个 Drive 文件链接加入「量产项目」的项目来源；文件本身已经归档到 Drive。

下一步应由 Muse 按 T001–T004 开展 S0 概念验证。

48/48 Oracle 对照、24/24 缺陷检出、0/24 控制误报及 100 次单一哈希全部通过，才允许进入 T005。

---

## Muse 记录

- Drive 信息经 Muse 亲自核实（2026-11-13 ~12:57 GMT）：文件夹 P023-skillscope（id 1e7G3achqvlbIpu5rTSxEk2jvrsRlJIFS）/ 00_spec（id 15IiNTdyBBEPkRc6dE1MH9GjmsM4AgLb8）真实存在；PROJECT_BOOK.md 31,870 B（id 1t_dAMpCSTiRGYqHsXViuGA3kLb0DQNcp，sha256 73b9baa7…）、IMPLEMENTATION_PLAN.md 34,795 B（id 1Z4lCAmki7V2SVZaHoUAoP92mSfgAHU5T，sha256 f9fab1b1…）——与 GPT 声称的字节数完全一致，00_spec 内仅此两文件，无重复。本地副本已存 ~/workspace/P023_PROJECT_BOOK.md 与 ~/workspace/P023_IMPLEMENTATION_PLAN.md。
- 对话标题已由浏览器方改名为 P023-SkillScope（侧边栏、顶部与标签均已显示），GPT 的第 1 项未完成事项实际已解决。
- 第 2 项（加入「量产项目」项目来源）未完成，留待以后统一处理（P012–P022 同样未加）。
- 规格内容核实：见 ~/workspace/P023_SPEC_VERIFICATION.md。
