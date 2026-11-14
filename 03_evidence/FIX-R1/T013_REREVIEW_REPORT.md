# P023 SkillScope — T013 独立复审报告（第二轮，FIX-R1 后）

- **复审人：** Muse（独立复审子代理，只读复审，未修改任何源码、fixture、spec 或证据文件；验收运行改写的 `03_evidence/T012/` 5 个文件已用 `git checkout --` 恢复，`03_evidence/S0/` 无改动）
- **复审时间：** 2026-11-13 ~18:37–19:00 GMT
- **复审对象：** FIX-R1 输出 commit `98b06fd`（记录提交 `24a5883`），基线 `d36480a`（冻结 `a4b83ab`）
- **依据：** R1 裁决原文 `~/workspace/p023-R1-verdict.md`；独立核实报告 `~/workspace/p023-gpt-R1-verification-2026-11-13.md`；FIX 报告 `03_evidence/FIX-R1/FIX_R1_REPORT.md`（32,136 B，sha256 `1f30102e…`，已全文读完）；Muse 验收记录 `~/workspace/coordinator-logs/muse-fix-r1-verify.md`（仅供参考，本报告全部结论均为自己重跑、自己复现得出）
- **环境：** Node v24.22.1（项目要求 >=24），npm 10.9.4，Python 3.12.3；root 会话，权限复现一律以 `nobody`（uid 65534）运行（与核实方既定模式一致）

## 总判定

| 类别 | 数量 | 结论 |
|---|---|---|
| P0 | **0** | R1 的 4 个 P0 全部修复并验证通过（§1） |
| P1 | **1** | **新增 P1-T013R-01（§7）：Codex PoC 的 symlink 逃逸守卫测的是未解析路径，逃逸技能被跟随并归属到包含它的 scope，可绕过禁 scope 策略——已用真实输入演示 false PASS。FIX-R1 未引入，是冻结版本即有的旧缺陷，R1 未发现。** |
| P2 | 16 | R1 的 17 项中 2 项关闭（T013-08、R1-17）、1 项 FALSE（R1-13）、14 项仍登记；新增 P2-T013R-02 1 项（Oracle synced 检查窄边差异）；T013 原 10 项中 1 项已关、9 项仍登记（§6） |

**结论：STATUS = FAIL。** 8 个 R1 修复项全部属实，全部验收命令退出码 0，S0 gate 通过且 SHA 不变是正确结果；但新发现的 P1-T013R-01 是可演示的策略绕过（false PASS），按 T013 分级标准（“规则实现与冻结规格不符、或在可达输入上产生错误结论”）为 P1，阻断。修复范围极小（两个实现各改一行守卫判断 + 回归样本），修后重跑本轮验收与新 T013 复核即可进入 T014/R2。

## §1 逐项复核 8 个修复（全部通过）

每项均读了改动源码、跑了对应回归样本（`npx vitest run tests/regression/r1-fix.test.ts` 22/22，见 §2），确认 R1 场景已翻转为预期值。

| 项 | 改动核对 | 回归验证（亲自跑） |
|---|---|---|
| **P0-R1-01** Codex 不可读根三态 | `src/adapters/codex/codex-poc.ts`：`listSkillDirs` 返回 `{dirs} \| {error:"unreadable"}`，不再静默 `[]`；`scanSkillsDir` 返回 `ok/missing/unreadable`；REPO 循环的返回值现被检查（旧代码忽略）；`noteUnknown` 按 scope 去重。`src/fsutil/index.ts` 新建（`classifyPath`/`classifyError`/`isContentUnknownSkip`），映射正确（ENOENT/ENOTDIR → missing，其余 fail-closed → unreadable）。Oracle 同步镜像。 | r1-01：PoC 与 kernel 均为 **INCOMPLETE**，unknownScopes [REPO]，SOURCE_NOT_ENUMERATED；对照（可读）检出 private-skill ELIGIBLE + SCOPE_LEAK。 |
| **P0-R1-02** 不可读 SKILL.md 转 finding | `skill-scan.ts` 与 `discovery.ts` 的 skip 项现记 errno（`code`）；Claude PoC 对 `isContentUnknownSkip` 的条目推 SOURCE_NOT_ENUMERATED（无论 required 与否），根不计入已枚举；`resolver/discoveryFindings()` 除 SYMLINK_OUTSIDE_ROOT 外另转内容未知 skip；ROOT 跳过不重复转（已通过 coverage 上报）。`scanSingleSkillDir` 返回 `{scanned, unreadable}`。 | r1-02：PoC、kernel、完整适配器三层均为 **INCOMPLETE**，unknownScopes [PROJECT]；对照（无 SKILL.md 的容器目录）仍 PASS，ENOENT 跳过静默。 |
| **P0-R1-03** synced/ 识别 + ACCOUNT_SYNC 门禁 | `claude-poc.ts` 新增 `accountSyncDir` 输入：未声明 ACCOUNT_SYNC 根时检查 synced/——缺失为已知无此来源；含技能、不可读、或根不可读 → UNKNOWN + SOURCE_NOT_ENUMERATED，且 `requiredSources += 1`；已声明根时以声明为准。`adapter.ts` 把 `accountSyncDir` 传给 PoC。Oracle 同步镜像。 | r1-03：**INCOMPLETE**，unknownScopes [ACCOUNT_SYNC]，coverage 2/3；对照（synced 缺失）PASS；对照（已声明快照）PASS；不可读 synced/ 目录 → INCOMPLETE。 |
| **P0-R1-04** OMB 只读 `features` 嵌套 | `openmausbot-poc.ts` 只读 `features` 对象：缺失 → 默认关闭；非对象/开关非布尔 → FAIL_OPEN_CONFIG + INCOMPLETE；顶层键被忽略。Oracle 同步镜像（detail 字符串与 TS 逐字相同，parity 仍 48/48）。PoC 与内核的行内策略比较改为仅 ELIGIBLE（ADR-023，见下）。 | r1-04 嵌套：PoC/kernel/完整适配器均为 **FAIL**（SCOPE_LEAK，实例 ELIGIBLE）；对照（顶层-only）三层均为 PASS（读作默认关闭）；非布尔/非对象 features → INCOMPLETE。 |
| **P1-R1-01** OMB CLI 显式 bot_id/data_dir/snapshot_path | `schemas/skillscope-profile-v1.json` 新增可选字段 `bot_id`/`config_path`/`data_dir`/`snapshot_path`（`required` 列表未变，向后兼容）；`src/cli/audit.ts`：`bot_id` 必填（缺失 → 退出码 3）；`data_dir` 显式值优先于 OMB_DATA_DIR（CLI 现传 `process.env`，不再强制 `env: {}`）；`snapshot_path` 显式值优先于 `./snapshot.json`；显式路径缺失 → 退出码 3；解析结果打印在摘要中。 | 回归 CLI 用例通过；真实 CLI 子进程验证见 §4（OMB_DATA_DIR 生效、缺 bot_id 退出 3、显式 data_dir 缺失退出 3）。 |
| **P1-R1-02** EACCES/ENOENT 区分 | OMB 配置与 opt-out 检查改用 `classifyPath`：不可读 → FAIL_OPEN_CONFIG + INCOMPLETE；opt-out 不可读时实例仍保持 ELIGIBLE（宿主语义，官方文档：bot keeps every every-bot skill），审计 INCOMPLETE。快照技能路径检查同样改用 `classifyPath`（缺失分支保留旧 detail 措辞）。 | r1-02a：三层均为 **INCOMPLETE**，FAIL_OPEN_CONFIG，configSource "invalid"，实例 DISCOVERED；r1-02b：PoC/kernel **INCOMPLETE**，实例仍 ELIGIBLE；对照（opt-out 列出 / 缺失）行为不变。 |
| **P1-R1-03** Claude 来源自动派生 | `adapter.ts` step-0 `deriveStandardRoot`：PERSONAL/PROJECT 在 profile 漏列且目录含技能、有不可验证 skip、或不可读时自动派生（id `personal`/`project`，冲突加后缀）；缺失/空目录不派生；NESTED、ENTERPRISE 不派生（已文档化）。 | r1-03b：漏列 PERSONAL 时派生后检出，**FAIL**（SCOPE_LEAK，PERSONAL + PROJECT 两实例）；对照（无个人技能）PASS。 |
| **P1-R1-04** Codex CLI 读真实用户配置 | `resolveCodexConfig`：显式 `config_path` > profile 目录 `config.toml` > `<home_root>/.codex/config.toml` > 缺失；存在或不可读视为已找到（交 PoC 失败关闭）；显式路径缺失 → 退出码 3；解析路径与来源打印在摘要中。 | 回归 CLI 用例通过；真实 CLI 子进程验证见 §4（home 配置生效、deploy DISABLED；profile 配置优先、deploy ELIGIBLE；显式 config_path 缺失退出 3）。 |

**对齐项 ADR-023：** Claude 与 OMB 两个 PoC 的行内策略比较由 ELIGIBLE-or-DISCOVERED 改为仅 ELIGIBLE，与内核（ADR-006）一致；Oracle `_claude_shared_findings` 镜像；`tests/rules/resolver.test.ts` 中钉住旧分裂行为的测试已按新规则重写（重命名注明 ADR-023）。r1-04 嵌套行证实内核由 PASS 翻转为 FAIL，与 PoC 一致。行为变更已文档化，不是严重度调整。**通过。**

## §2 验收命令（全部亲自跑，退出码 0）

2026-11-13 ~18:37–18:45 GMT，Node v24.22.1；完整日志 `~/workspace/t013-rereview-logs/acceptance.log`（+ `npm-test.log`）。

| 命令 | 退出码 | 亲自看到的关键输出 |
|---|---|---|
| `npm run typecheck` | 0 | `tsc --noEmit` 无错误 |
| `npm test` | 0 | 30 文件，**558/558 通过**（533 基线 + 22 回归 + 3 新增单元） |
| `npm run test:oracle` | 0 | **53/53 通过**（42 原有 + 11 新增 TestFixR1Oracle），0.099s |
| `npm run s0:gate` | 0 | PASS；48 fixture（24 控制，24 植入）；parity 48/48；golden 48/48；检出 24/24；误报 0；incomplete sources 11（10 fixture）；100 次重放 1 哈希；gate_sha256 `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca` **不变** |
| `npm run test:e2e` | 0 | PASS — **28/28** 检查通过 |
| `npm run test:offline` | 0 | offline-check: PASS — no account, no LLM, no network, no real skills needed |
| `npm run test:performance` | 0 | PASS；scan 中位数 239 ms（目标 ≤5000）；HTML 中位数 340 ms（目标 ≤2000）；峰值 RSS 82.2 MiB（目标 ≤300）；500/500 实例，hash 稳定 |
| `npm run verify:all` | 0 | PASS — **8/8** 步骤通过；42 包 inventoried |
| `npx vitest run tests/regression/r1-fix.test.ts`（单独重跑，针对自己刚构建的 dist） | 0 | **22/22 通过**（6 个 nobody 权限用例 + 12 个进程内用例 + 4 个 CLI 契约用例） |

注：性能数字三轮实测均有波动（FIX 报告 312/689/82.3；Muse 验收 421/525/83.2；本轮 239/340/82.2），均在目标内，属正常运行间波动。

## §3 OMB fixture 迁移核对（亲自验算）

脚本逐个对照基线 `d36480a` 的顶层 flags 与新版 `features` 嵌套值：

- **30 个 config.json 迁移，开关布尔值逐个一致，无一错漏；顶层键已全部移除。**（S0 14 个 + T007 15 个 + demo 1 个）
- **2 个损坏配置保持不变**（S0 o15 `{not json`、T007 a11-corrupt-config `{not json`），仍为无效 JSON。
- **0 个 `expected.json` 改动**——迁移只改结构不改开关值，预期判定不变，合理。
- S0 + T007 + demo 共 32 个 OMB config.json：30 迁移 + 2 跳过，与 FIX 报告一致。
- FIX 报告称“S0 15 个”——实为 14 个迁移 + o15 跳过，口径差异，无实质问题。

## §4 CLI 契约（真实 CLI 子进程，5 项全部通过）

用 `node dist/cli/index.js audit --profile … --format json --out …`（新构建的 dist，Node 24.22.1）亲自跑，回归套件的进程内 `runAudit` 用例只作交叉印证：

| # | 场景 | 实测结果 |
|---|---|---|
| CLI-1 | OMB profile 缺 `bot_id` | 退出码 **3**，stderr：`openmausbot profile requires explicit "bot_id"…` |
| CLI-2 | Codex home 配置（`home/.codex/config.toml` 禁用 deploy，无 profile 旁 config） | 退出码 **0**，摘要 `config: …/home/.codex/config.toml (source: home)`，deploy 标记 `✗`（DISABLED；`statusMark`：✗ = 非 ELIGIBLE/DISCOVERED）；进程内回归用例断言 deploy DISABLED，二者一致 |
| CLI-3 | OMB_DATA_DIR 指向 library-ON 配置（`OMB_DATA_DIR=…/env-data`） | 退出码 **1**，`RESULT: FAIL`，`data dir: …/env-data (source: env)`，`bot: real-bot-7`，`SCOPE_LEAK [P1]`，shared-skill ELIGIBLE |
| CLI-4 | 显式 `config_path` 指向缺失文件 | 退出码 **3**，`explicit config_path … does not exist` |
| CLI-5 | 显式 `data_dir` 指向缺失目录 | 退出码 **3**，`explicit data_dir … does not exist` |

FIX 报告的已知局限 3（“CLI 回归用例在进程内调 `runAudit`，未走真实 CLI 子进程”）已被本轮真实子进程检查**关闭**。

## §5 覆盖矩阵与 review-inputs 验算

### 5.1 覆盖矩阵（本轮实际阅读情况）

T013 原标准：31 个核心文件 + 10 个配置文件全部 READ。本轮复审范围是 FIX 变更集（126 个文件），阅读情况如下：

| 类别 | 文件 | 状态 |
|---|---|---|
| 核心（FIX 改动） | `src/fsutil/index.ts`（新建，全文）、`src/adapters/codex/codex-poc.ts`、`src/adapters/claude/claude-poc.ts`、`src/adapters/claude/adapter.ts`、`src/adapters/openmausbot/openmausbot-poc.ts`、`src/adapters/shared/skill-scan.ts`、`src/discovery/discovery.ts`、`src/resolver/index.ts`、`src/cli/audit.ts`、`src/cli/index.ts`（摘要/状态标记/用法部分） | **READ**（diff 全文或关键段落，逐项核对见 §1） |
| 核心（FIX 相关） | `src/adapters/openmausbot/snapshot.ts`（`loadSnapshotFile` 段）、`src/adapters/openmausbot/adapter.ts`（snapshot 处理段） | **READ**（相关段落） |
| Oracle | `oracle/python/reference_resolver.py`（diff 全文 373 行，含 classify/features/account_sync/对齐） | **READ** |
| 配置 | `schemas/skillscope-profile-v1.json`（diff 全文，仅新增 4 个可选字段） | **READ** |
| 回归 | `tests/regression/r1-fix.test.ts`（全文 785 行）、`tests/regression/r1-driver.mjs`（全文） | **READ** |
| 文档 | `01_spec/PROJECT_BOOK.md`（FIX 相关 §4.3/§4.4/§4.5/§5.1/§5.2/§6.1/§6.4 + 发现段落）、`01_spec/IMPLEMENTATION_PLAN.md`（FIX-R1 节 + §0 规则 13）、`00_control/DECISION_LOG.md`（ADR-019–023 全文） | **READ**（相关章节；其余章节未逐字重读，沿用 T013 的 READ 记录） |
| 证据 | `03_evidence/FIX-R1/FIX_R1_REPORT.md`（全文）、`03_evidence/FIX-R1/repro-after.log`（状态行抽查，sha256 `1975e549…` 与报告一致）、R1 裁决原文、R1 核实报告（全文）、Muse 验收记录（全文） | **READ** |
| 未全文读 | `src/adapters/openmausbot/adapter.ts`（除 snapshot 段外）、`src/adapters/openmausbot/snapshot.ts`（除 loadSnapshotFile 外）、`oracle/tests/test_reference_resolver.py`（新增 11 测试仅 grep 核对）、`tests/fsutil/fsutil.test.ts`（未读源码；行为由 558/558 与回归覆盖） | **NOT_READ**——均非 FIX 的判定路径；其行为由全量测试与本轮复现覆盖，无未覆盖的判定逻辑 |

### 5.2 review-inputs.sha256 重新验算（针对新 HEAD `24a5883`）

`sha256sum -c 03_evidence/T013/review-inputs.sha256`（旧清单，638 项，冻结基线）：**587 OK / 51 FAILED**。

51 个 FAILED 全部分解，无意外项：

- **50 个是 FIX 改动文件**（与 `git diff d36480a 98b06fd` 在清单内的文件一一对应，逐项比对无遗漏、无多余）：3 个控制记录 + 2 个 spec + Oracle 2 个 + schema 1 个 + src 9 个 + 测试 3 个 + S0 OMB config 14 个 + T007 OMB config 15 个 + demo 2 个。
- **1 个是冻结时已有的差异**（`00_control/PROJECT_STATE.json`）：FIX 未改它（`git diff d36480a 98b06fd` 为空）；它是 R1 已确认的 3 个 T014 回填文件之一（另 2 个在 FIX 中又改了，故计入 50 个内）。属预期内。
- 新文件（`src/fsutil/index.ts`、回归套件、`LICENSE` 等）不在旧清单内，不计入 FAILED；T012 再生证据文件不在清单内（0 命中）。

**结论：** 与冻结基线的差异只应是 FIX 相关文件 + 记录文件——成立。新 T014 冻结时须重新生成 review-inputs 清单。

## §6 P2 登记（逐项确认）

### 6.1 R1 的 17 项 P2

| 项 | 状态 |
|---|---|
| P2-T013-01 localeCompare 排序 | **仍登记**（FIX 未改） |
| P2-T013-02 三实现 canonical/哈希约定分裂 | **仍登记**（FIX 未改） |
| P2-T013-03 OMB finding detail 含绝对路径 | **仍登记**（FIX 新增的 detail 同样含绝对路径；CLI 写盘前 redact，导出物无泄露） |
| P2-T013-04 OMB `unknownScopes` 可重复计数 | **仍登记**（`scanSingleSkillDir` 分支加了 `includes` 守卫，但快照技能缺失分支仍无守卫） |
| P2-T013-05 ProfileV1 接口与 schema 漂移 | **仍登记**（FIX 未改；新增 4 字段只在 schema 一侧） |
| P2-T013-06 Codex 跨来源 realpath 归并丢 scope | **仍登记**（与 §7 的 P1-T013R-01 同族，见该节说明） |
| P2-T013-07 PoC frontmatter 无保留词规则 | **仍登记**（FIX 未改） |
| P2-T013-08 release-build/verify 不存在 | **已关闭**（T014，R1 前已关） |
| P2-T013-09 未使用的 marketplace/dedupeRootIds 代码 | **仍登记**（FIX 未改） |
| P2-T013-10 build-lock stale-steal TOCTOU | **仍登记**（FIX 未改） |
| P2-R1-11 PROJECT_BOOK/PLAN 仍写 NOT_IMPLEMENTED / READY_FOR_S0_ONLY | **仍登记**（亲查：PROJECT_BOOK 行 7–9、581，PLAN 行 6–7、56、790 仍为该措辞；FIX 未改。属 spec 文档头状态，非代码缺陷） |
| P2-R1-12 review-inputs 635/638 | **仍登记**（冻结时控制文件漂移是机制使然；新冻结须重验，见 §5.2） |
| P2-R1-13 Drive T014 报告旧冻结 | **FALSE（按原文表述），不列为修复项**——亲查本地 `03_evidence/T014/T014_FREEZE_REPORT.md` 第 5、15–16 行已是最终冻结 `a4b83ab` / `894bebe7…`；"714dd40" 出现处均为历史迭代说明（行 43、55–57），叙述正确；与 R1 核实结论一致 |
| P2-R1-14 PROJECT_BOOK 示例用 `id` 而接口要求 `sourceRootId` | **仍登记**（亲查：PROJECT_BOOK 行 309–310 仍用 `"id"`，行 330 接口为 `sourceRootId`） |
| P2-R1-15 干净目录重建未验证 `npm ci` | **仍登记**（FIX 未改） |
| P2-R1-16 Windows 未真机验证 | **仍登记**（FIX 未改） |
| P2-R1-17 LICENSE 待 Sam 决定 | **已关闭**——Sam 2026-11-13 ~18:02 GMT 决定全部 MIT；仓库根 `LICENSE`（1,065 B，sha256 `50b8b302…`，与 P021 同哈希），PROJECT_BOOK/PLAN 已同步为 MIT |

### 6.2 其余

- PLAN 的 FIX-R1 节存在（行 584 起，`### FIX-R1｜终审 R1 返工（S5，2026-11-13）`），FIX 报告称“§5.5”仅为 loose 的节号指代，内容齐全，非缺陷。
- T013 FINDINGS.md 未被 FIX 改动（`git diff` 为空），原登记完整。

## §7 新发现（本轮复审独立发现，不在 R1 清单内）

### P1-T013R-01 —— Codex PoC 的 symlink 逃逸守卫测的是未解析路径，逃逸技能被归属到包含它的 scope（阻断）

**位置：** `src/adapters/codex/codex-poc.ts` `addSkillDir`（约 389–393 行）；Oracle `oracle/python/reference_resolver.py` `add_skill_dir`（约 442–444 行）——两侧镜像同一写法。

**代码：**

```ts
const realSkillPath = realpathSync(skillMdAbs);   // 已解析的真实路径
const relFromRoot = relativePosix(rootDir, skillMdAbs);  // ← 测的是未解析路径
if (relFromRoot === null) {
  // Discovered path escapes its source root; do not follow it out.
  return true;
}
```

`skillMdAbs` 是 `join(skillsDir, folderName, "SKILL.md")`，按构造恒在 `rootDir` 词法内部，故 `relFromRoot` 永不为 null——守卫是死代码。注释称“不跟随逃出”，实现却跟随并读取了根外文件。

**违反的规格：** PROJECT_BOOK §5.2 findings 表：`SYMLINK_OUTSIDE_ROOT | 符号链接指向未授权扫描根目录 | P1 / INCOMPLETE`；§12 风险表：`symlink loop / path escape | P0 | 限界扫描；不越权读取`。实现既越权读取，又不产生该 finding。

**演示（亲自跑，新构建 dist，Node 24.22.1；复现树 `~/workspace/t013-rereview-logs/symlink-escape/` 与 `symlink-launder/`）：**

1. 逃逸技能被跟随：`repo/.agents/skills/evil` → 符号链接到仓库外的 `outside/real-skill`。TS 与 Oracle **一致**输出 PASS，`secret` 技能被报为 REPO ELIGIBLE——逃逸内容未被拦截，双方均然。
2. 策略绕过（对照完整）：同一物理技能位于 `home/.agents/skills/evil-skill/`（USER scope）。无符号链接时：正确归属 USER ELIGIBLE，策略禁 USER → kernel **FAIL（SCOPE_LEAK）**。加符号链接 `repo/.agents/skills/link` → 该技能后：归属变为 REPO ELIGIBLE，kernel **PASS、无 finding**——禁 USER 的策略被完整绕过。Oracle 在 laundered 输入上输出完全相同（REPO ELIGIBLE，PASS），故**无 TS/Oracle parity 破裂**，两侧共享同一缺陷。
3. 冻结版本即有：该行在 FIX 前已是同一写法（FIX 只把返回值由 void 改为 boolean），故为**旧缺陷，非 FIX-R1 引入**；R1（GPT 与独立核实）与原 T013 均未发现。

**定级理由（P1，非 P2）：** 按 T013 分级标准，P1 = “规则实现与冻结规格不符、或在可达输入上产生错误结论”——本项两条都满足：实现与 PROJECT_BOOK 的 SYMLINK_OUTSIDE_ROOT 规则不符；可达输入（项目书明言 Codex“支持 symlink”）上产生错误结论（false PASS）。与 P2-T013-06（跨根归并丢 scope）的区别：T013-06 称“两者在生产路径中永不相遇”，本项则在**生产审计路径**上被实际演示出策略绕过。

**修复要求：** 守卫改为测解析后路径（`relativePosix(rootDir, realSkillPath)` / Oracle 同理）；逃逸时按规格产生 SYMLINK_OUTSIDE_ROOT（P1/INCOMPLETE，来源未知），不得静默丢弃、也不得归属到包含它的 scope；补正反回归样本（逃逸技能、跨 scope laundering 对照）；重跑 S0（无 S0 夹具有逃逸 Codex 符号链接，gate SHA 应不变，须实测确认）、Oracle、全量测试；新 T013 复核确认。

### P2-T013R-02 —— Oracle 的 accountSyncDir 检查漏掉 synced/ 内不可读的技能子目录（TS 侧已覆盖）

**位置：** Oracle `resolve_claude_native` 的 account_sync 检查（约 867–885 行）vs TS `claude-poc.ts` 的 accountSyncDir 检查。

**代码核对（未跑 nobody 实测，以代码为准）：** synced/ 可读、仅含一个 chmod 000 的技能子目录时：TS 经 `scanSkillRoot` 得 SKILL_MD_UNREADABLE/EACCES → `hasUnverifiable` → UNKNOWN；Oracle 经 `_codex_list_skill_dirs` 得 `{"error": "unreadable"}` → `"dirs" not in listed` → `has_skill` 保持 False → 无 finding。两侧在 synced/ 整体不可读（`access == "unreadable"` 分支）与含可读技能时一致，分歧仅限“synced/ 内仅有不可读技能子目录”这一窄边。

**定级：P2**（窄边 parity 差异，TS 侧 fail-closed 正确；无夹具覆盖；不影响任何现有结论）。修复：Oracle 在该检查中把 `_codex_list_skill_dirs` 的 error 视为未知（与 TS 的 `hasUnverifiable` 对齐），并补回归样本。

## §8 已知局限裁定（FIX 报告列出的 5 项）

| # | 局限 | 裁定 |
|---|---|---|
| 1 | `loadSnapshotFile` 把不可读与缺失的 snapshot 混为同一 reason "missing" | **接受为已知局限。** 亲查 `src/adapters/openmausbot/snapshot.ts`：reason 混用，但错误文本为 `"snapshot file is missing or unreadable"`、docstring 明写两者同义；适配器对两种情况均走 INCOMPLETE（ADR-007），状态正确，仅措辞不精确。超出 R1 范围。 |
| 2 | Oracle 回归的 EACCES 分支用 mocked PermissionError | **接受。** root 下无法产生真实 EACCES 是环境事实；真实权限行为由 TS 侧 nobody 驱动覆盖，本轮重跑 22/22（含 6 个 nobody 用例）全部通过。 |
| 3 | 回归 CLI 用例在进程内调 `runAudit`，未走真实 CLI 子进程 | **已关闭。** 本轮跑了 5 项真实 CLI 子进程检查（§4），全部符合预期。 |
| 4 | OMB 实例的 logicalName 取 snapshot 名而非 frontmatter 名 | **接受为已知局限。** 既有行为（FIX 前即然）；parity 48/48 与 Oracle 53/53 均通过，两侧一致；未发现由此导致的错误结论。 |
| 5 | FIX 不更新 T014_FREEZE_REPORT（另派 T014） | **接受。** 属 T014 职责；新冻结将重新生成报告与发布包，R2 须用新冻结产物。 |

**补充观察（非 finding）：** Claude PoC 在多个同 scope 根均有不可读 skip 时，`unknownScopes` 可能重复计入同一 scope（无 `includes` 守卫；OMB 侧部分分支已加）。实际触发需同 scope 多根且均不可读，无夹具覆盖；与已登记的 P2-T013-04 同族，不新立项。

## §9 S0 gate SHA 不变——核实为正确

FIX 报告与 Muse 验收均称 gate SHA 不变（`a11d2a4c…`）是正确结果，本轮亲自重跑证实：OMB 迁移只改结构不改开关值；S0 无不可读文件、无 DISCOVERED+禁策略组合、无 synced/ 目录、无非技能子目录；48/48 判定输出全未变。R1 核实报告的附加观察称“修复后 S0 gate SHA 必然变化”——该推断不成立：gate SHA 是 48 个审计结论的哈希，结论未变则 SHA 不变；不应为“变化”而强行改 SHA。

## 交付文件清单

- 本报告：`03_evidence/FIX-R1/T013_REREVIEW_REPORT.md`（本文件）
- 复现树（复审工作区，不在仓库内）：`~/workspace/t013-rereview-logs/`（验收日志 `acceptance.log`、`npm-test.log`、回归重跑日志 `r1-regression-rerun.log`、review-inputs 验算 `review-inputs-check.txt`、CLI 报告 `cli/r1.json`、`cli/r2.json`、`cli/r3.json`、symlink 复现 `symlink-escape/`、`symlink-launder/`）
- 仓库内无其他改动：复审结束时 `git status` 为空（除本报告文件外；T012 再生证据已恢复）

## 复审结论重申

- R1 的 4 P0 + 4 P1 **全部修复属实**（§1），回归 22/22，全量 558/558，S0 gate PASS 且 SHA 不变正确（§9），OMB 迁移 30/30 值一致（§3），CLI 契约经 5 项真实子进程验证（§4）。
- 阻断项只有新发现的 **P1-T013R-01**（Codex symlink 逃逸守卫死代码，可演示策略绕过）。修后须重跑本轮验收、补回归样本、由新的独立 T013 复核确认，再进新 T014 冻结与 R2（第 2/5 轮）。
