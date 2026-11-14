# P023 SkillScope — 独立 T013 复核报告（第 4 轮，FIX-R2 后）

- **复核人：** 独立复核者（非 FIX-R2 作者；本轮只挑错，不为 FIX-R2 辩护）
- **复核时间：** 2026-11-13 ~20:20–20:45 GMT
- **复核对象：** FIX-R2，输出提交 `7cd1edb`（51 文件，+774/−13），记录提交 `4c0d7ba`；基线 `9b06a96`（T014 第二轮冻结）
- **依据：** R2 裁决全文（`~/workspace/p023-R2-verdict.md`）、Muse 的 R2 核实记录（`~/workspace/p023-gpt-R2-verification-2026-11-13.md`）、Muse 的 FIX-R2 验收记录（`~/workspace/coordinator-logs/muse-fix-r2-verify.md`）、`03_evidence/FIX-R2/FIX_R2_REPORT.md`、PROJECT_BOOK §4.2/§4.3/§5.2/§12、DECISION_LOG（ADR-027/028）
- **结论：STATUS = PASS。** 两项 R2 新 P1 均已真正修复（本人亲自复现前后翻转，含旧代码对照），R1 的 8 项修复、P1-T013R-01、P2-T013R-02 均仍成立，**0 新 P0/P1**，新增 P2 0 项（1 项已查证的微小观察见 §5，不入登记）。

## 1. P1-R2-02（Codex 跨来源归并丢 USER scope）— 已修复，本人亲自复现

### 代码审读（自己读 diff，不照抄报告）

- `src/adapters/codex/codex-poc.ts`：新增 `byRealPathAndScope`（key = realpath + `\0` + scope）。顺序已核对：realpath → FIX-T013R 逃逸守卫（先于任何归并/读取，不通过即返回）→ 同 scope 查表归并 alias（c06 不变）→ 跨 scope 落空后建第二实例（各自 sourceRootId/sourceScope/relativePath/instanceId；contentSha256 与 canonicalPathHash 相同）；`byRealPath` 只在 `existing === undefined` 时设首个实例作同 scope 锚点。
- `oracle/python/reference_resolver.py`：同款 `by_real_path_and_scope`（key 为 `(real_skill_path, source_scope)` 元组），顺序与 TS 一致（realpath → 守卫 → 同 scope 归并 → 跨 scope 新建实例）。两边写法独立，行为一致。
- Claude 适配器：亲自读代码确认无同款问题——`scanSkillRoot`（`src/adapters/shared/skill-scan.ts:151`）每次调用新建 `byCanonical` 去重表；`claude-poc.ts` 逐根调用后结果直推 `instances`（各带本根 sourceRootId），无跨根去重。IdentityRegistry 身份键确为 `(sourceRootId, canonicalPath)`（`src/identity/identity.ts:23-27, 61-71`），两 scope 天生两个键。OMB `openmausbot-poc.ts` 的 `scanSingleSkillDir` 无去重表，单文件夹直出实例；`src/resolver/` 无全局去重。报告的“无修复”结论属实。

### 本人 CLI 复现（Node 24.22.1，我自己的 staging，非报告的 staging）

Staging `~/workspace/t013r3-verify/home-is-repo/`（repo_root == home_root == "."，REPO 与 USER 均指向 `./.agents/skills`，内有 shared/SKILL.md，禁 USER；ADMIN/SYSTEM/PLUGIN 正常；profile 含 `engine`/`profile_id`/allowed_scopes（不含 USER）与完整 source_roots）：

**旧代码对照（`git worktree` 检出 `9b06a96`，现场 build，同一 staging）：**

```
✓ repo/.agents/skills/shared/SKILL.md (aliases: .agents/skills/shared/SKILL.md)
coverage: 5/5 sources enumerated
RESULT: PASS
```

exit 0——缺陷原样重现，与 R2 裁决及 Muse 的冻结 dist 复现一致。

**FIX 构建（HEAD 的 dist）：**

```
✓ repo/.agents/skills/shared/SKILL.md
✓ user/.agents/skills/shared/SKILL.md
! SCOPE_LEAK [P1] (USER): scope USER is forbidden by policy but skill 'shared' (user:.agents/skills/shared/SKILL.md) is ELIGIBLE
coverage: 5/5 sources enumerated
RESULT: FAIL
```

exit 1；report：`status: FAIL`，`findings: [(SCOPE_LEAK, USER)]`——已翻转。

**另两个本人复现：**

- 无策略对照（同一 staging，`forbidden_scopes: []`）：两实例均列出，`RESULT: PASS`，exit 0——双实例不破坏无策略审计。
- 重叠根（r3-01d 夹具，repo_root="."，home_root="./repo"，禁 USER）：两实例均列出，`SCOPE_LEAK [P1] (USER)`，`RESULT: FAIL`，exit 1。

回归样本已读并实跑：`tests/regression/r3-fix.test.ts` 4 项断言实质性（2 实例、同 content SHA、同 canonicalPath、不同 instanceId、alias 均空、禁 USER 内核 FAIL 且恰 1 个 SCOPE_LEAK、同名 selector 命中双实例 blast `affectedCount` 2）；Oracle `TestFixR2Oracle` 4 项同款断言（2 实例、scopes `{REPO, USER}`）。均在全量套件内通过（见 §4）。

## 2. P1-R2-01（source.zip 丢空目录）— 已修复，本人亲自复现

- 本人从 HEAD 打新鲜 `git archive`（sha `70c458b4…`，与 Muse 的验收 archive 逐字节一致——HEAD 自其验收后未变），`unzip -l` 核对：GPT 点名的 7 个目录**全部在列且含 `.gitkeep`**（r2-01c 的 `repo/`、`etc-codex/skills/`；r2-01d 的 `home/.agents/skills/`、`etc-codex/skills/`；r1 `cli-codex-home-config` 的 `home/.agents/skills/`、`admin/skills/`；`cli-omb-env-data-dir/assigned/`）。
- 本人跑 `npm run verify:extracted-tree /tmp/t013r3-source.zip`：**PASS，0 失败**——目录集 1204/1204 无缺失无多余、build exit 0、解压树内 r1+r2 27/27、全量 567/567。
- 三道门禁已读代码并做负向测试：
  - `release-build.mjs` 的 `emptyDirsMissingGitkeep()`：只报叶空目录（空链必以叶收尾，覆盖完整）；顶层跳过 `.git`/`node_modules`/`dist`/`release`，夹具内名为 `release` 的技能目录不再误报。本人负向测试：干净树返回 `[]`；临时建无 `.gitkeep` 的空目录 `tests/fixtures/regression/r2/t013r3-gate-probe` 后返回 `["tests/fixtures/regression/r2/t013r3-gate-probe"]`；删除后恢复 `[]`，树干净。门禁真实有效，非摆设。
  - `release-verify.mjs` 的目录集比对：冻结 commit 的逐祖先展开目录集 vs source.zip 目录条目，文件全对但目录缺失仍 FAIL；另有 `.gitkeep` 目录存在性核对（步骤 5）。已读逻辑，无取巧。
  - `scripts/verify-extracted-tree.mjs`：解压、比对目录集、链接 node_modules 现场 build、解压树内跑 r1+r2 与全量——本人实跑全绿（上）。
  - `release-build.mjs` 另有 `tracked tree clean at freeze` 门禁（行 317–321），冻结 commit 即 HEAD（或 manifest 钉住的 commit），门禁与打包操作同一干净树——“工作树门禁通过但冻结 commit 缺 .gitkeep”的脱节路径不存在。
- 全量审计复核：树内 `find -type d -empty`（除 `.git`/`node_modules`/`dist`/`release`）= 0；25 个新增 `.gitkeep` 与报告清单一致（22 回归夹具 + 02_source/04_review/05_release）。

## 3. R1 的 8 项修复、P1-T013R-01、P2-T013R-02 是否仍成立 — 成立

- r1+r2+r3 回归套件 31/31（含 7 个 nobody 权限用例），全量 567/567，Oracle 62/62（含 TestFixR2Oracle 4 项），S0 gate PASS（SHA 不变，见 §4）。
- 本人另以 nobody 亲自 CLI 复现 laundering 对照（r2-01b 夹具，FIX 构建 staged dist + `schemas/` + smol-toml/yaml；注：CLI 校验 profile 需 `schemas/`，仅复制 dist + 两个 node_modules 包是不够的——这是我 staging 时的实测教训，r2-driver 因直接 import dist 模块而不需 schemas）：

```
✓ user/.agents/skills/evil-skill/SKILL.md
! SCOPE_LEAK [P1] (USER): scope USER is forbidden by policy but skill 'evil-skill' (user:.agents/skills/evil-skill/SKILL.md) is ELIGIBLE
! SYMLINK_OUTSIDE_ROOT [P1] (REPO): symlink 'repo/.agents/skills/link/SKILL.md' resolves outside its source root (REPO); its target content was never enumerated as this scope
coverage: 5/5 sources enumerated
RESULT: INCOMPLETE
```

exit 2——技能保持真实 USER scope、无 REPO 实例、无跨 scope alias，禁 USER 策略命中，逃逸守卫命中，与 r2 套件的期望逐项一致。

## 4. 本人实跑的验收命令（工作树，真实退出码）

| 命令 | 结果 |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0 — 32 文件，**567/567** |
| `npm run test:oracle` | exit 0 — **62/62** |
| `npx vitest run tests/regression/r1-fix.test.ts r2-fix.test.ts r3-fix.test.ts` | exit 0 — 3 文件，**31/31** |
| `npm run s0:gate` | exit 0 — PASS，gate SHA **`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca` 不变** |
| `npm run test:e2e` | exit 0 — **28/28** |
| `npm run test:offline` | exit 0 — PASS |
| `npm run test:performance` | exit 0 — 500/500，hash 稳定，峰值 RSS 82.1 MiB |
| `npm run verify:all` | exit 0 — **8/8**（42 包） |
| `npm run verify:extracted-tree`（本人新鲜 archive，sha `70c458b4…`） | **PASS — 0 失败**（目录集 1204/1204，r1+r2 27/27，全量 567/567） |

`s0:gate` / `verify:all` 改写的 `03_evidence/S0/`、`03_evidence/T012/` 已用 `git checkout --` 恢复；复核后树干净（0 dirty）。复核 staging（`~/workspace/t013r3-verify/`、`git worktree` 的 before 检出、`/tmp/t013r3-source.zip`）已清理。

## 5. 新发现的问题 — 0 新 P0/P1/P2

逐项查证，未发现新阻断项：

- **已查证、无发现（不入登记）：**
  - `emptyDirsMissingGitkeep()` 对不可读目录静默跳过（`catch { return; }`）。理论上不可读的空目录会漏报；但冻结流程要求干净树且同一用户操作，git 本就无法提交无 `.gitkeep` 的空目录，脱节路径又被 `tracked tree clean` 门禁与 `verify-extracted-tree` 的端到端测试兜底——实际不可达，不构成缺陷。
  - 同 scope 多 sourceRootId 同指一目录时，第二根归并进第一根的实例（scoped key 只含 scope，不含 sourceRootId）。策略按 scope 比较，不影响策略结果；属 FIX 前就有的 c06 同 scope 语义，非回归。
  - `tests/helpers/test-infra.ts` 的 `checkoutS0` 在无 `.git` 时 no-op：仅跳过恢复，gate 断言不变；仓库内行为不变；解压树全量 567/567 已证无影响。
- **P2 登记复核（R2 后的 12 项）：** 均仍有效，无关闭、无升级。FIX-R2 的 diff 未触及其中任何一项（仅改 PROJECT_BOOK §4.2 规则 3 与 §4.3 跨来源段、DECISION_LOG 新增 ADR-027/028）。抽查确认：P2-R1-11 仍为真——PROJECT_BOOK 行 7 仍写 `SPEC_FROZEN / NOT_IMPLEMENTED`，行 8 仍写 `READY_FOR_S0_ONLY`；P2-R1-15（npm ci 未真正执行）仍为真——`verify-extracted-tree` 仍以 node_modules 符号链接代替 `npm ci`（设计如此）；P2-R1-16（Windows 未真机测试）仍为真。P2-R1-13 仍为 FALSE（R1 裁决原文：“Drive 中 T014_FREEZE_REPORT 仍记录旧冻结 commit 714dd40、旧 source.zip 哈希——否，但应更新正式报告”；FIX-R2 未改变该定性）。
- 其余 9 项（P2-T013-01/02/03/04/05/07/09/10、P2-R1-14）均不在 FIX-R2 改动文件之列，维持登记。

## 6. 给 R3 的提醒（非阻断，复核范围外）

- R2 裁决指出 R2 消息未附 RELEASE_MANIFEST.json、SHA256SUMS.txt、RELEASE_FILE_LIST.csv 原件，三份文件的字节哈希未独立复算。R3 打包时应附上这三份原件。
- `verify-extracted-tree` 比对的是工作树，须在已提交的干净树上运行；新 T014 冻结时须用正式冻结产物再跑一次。

## 交付文件

- 本报告：`03_evidence/FIX-R2/T013_REREVIEW3_REPORT.md`

## 已知局限

- 本轮复核未重跑 `npm ci`（无网络；与 R2 的环境限制相同，P2-R1-15 已登记）。
- 本轮复核未在 Windows 真机测试（P2-R1-16 已登记）。
- 权威的解压树重现仍须在新 T014 冻结时用正式冻结产物再跑一次（`release:build` 新门禁 + `release:verify` 新目录集核对把关）。
