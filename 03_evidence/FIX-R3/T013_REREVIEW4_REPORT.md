# P023 SkillScope — T013 独立复核（第 5 轮，FIX-R3-LICENSE）

- **STATUS = PASS**
- 复核人：独立审查员（T013，第 5 轮；亲自执行，非转述修复员报告）
- 复核时间：2026-11-13 ~21:36–21:47 GMT
- 裁决：`~/workspace/p023-R3-verdict.md`（FINAL_VERDICT: FAIL，P0 0 / P1 1 / P2 13）
- 修复输出 commit：`b89f786`（`FIX-R3-LICENSE: dist.zip carries MIT LICENSE; README + package.json agree; dist LICENSE gate`）
- 记录 commit：`83de918`（工作树 HEAD，干净；除下述 5 个 T012 证据刷新文件外无未提交改动）
- 复核环境：Node v24.22.1，Python 3.12.3（GPT 轮次为 Python 3.13.5；Oracle 在本环境仍 62/62）
- 工作目录：`~/workspace/p023-skillscope/`

## 结论

- **P1-R3-01 = 已修复**：在再生 dist.zip（sha `f405795b…`）上按 GPT 原命令逐项复现，4 项检查全部通过；并在 R3 冻结 dist.zip（sha `4c941595…`）上复现修复前失败形态作为对照，前后翻转确认。
- **P2-R3-01 = 已修复**：dist.zip 含 `docs/` 三文件，README 的三个 `docs/` 链接全部可达。
- **无回归**：全量 `npm test` 573/573、Python Oracle 62/62、S0 门禁 PASS（gate SHA `a11d2a4c…` 不变）、`verify:all` 8/8；并在再生 dist 上用 GPT R3 §3.1 的原方法实测 P1-R2-02 跨来源场景，结果与 R3 裁决逐字一致（FAIL，exit 1）。
- **门禁真实有效**：两次负向验证（均在一次性 scratch worktree 中完成，已丢弃，主树未动）证明新门禁会在 LICENSE 篡改或缺失时让构建失败；新版 `release:verify` 对主树仍为 R3 冻结的 `release/` 实测返回 FAIL，恰好命中 5 项新 dist 检查，进一步证明核查门禁不是摆设。
- **无新问题**：未发现新的 P0/P1/P2。P2-R1-13 仍为 FALSE，不计入。其余 12 项 P2 未动（输出 commit 未触及任何 spec 文件）。
- 主树 `release/` 未动，仍为 R3 冻结产物（source.zip sha `6ca98ec7…`、dist.zip sha `4c941595…`），与修复记录一致；T014 重新冻结后方可进入 R4。

## 1. P1-R3-01 复现：再生 dist.zip（GPT 原命令，亲自执行）

再生 dist.zip：`03_evidence/FIX-R3/regenerated-release/dist.zip`，513,226 B，41 条目，
sha256 `f405795b4428d133ae6a211991938068fcf9256d3dfc47a067a4c828fbbd05a7`；
同目录 `SHA256SUMS.txt` 亲自 `sha256sum -c`：source.zip OK、dist.zip OK、RELEASE_MANIFEST.json OK。

| GPT 原检查 | 实测结果 |
|---|---|
| `unzip -Z1 dist.zip \| grep -E '(^|/)LICENSE$'` | `LICENSE`（exit 0） |
| 解出 LICENSE 的 sha256 | `50b8b302ffcb53aec1866ad4b94721c200400e6aac8cee12db03b85f24e39ed2` ✓（与 source.zip 内 `skillscope/LICENSE` 同值，与裁决一致） |
| dist.zip 内 README 第 114–116 行 | `## License` / 空行 / `MIT — see [LICENSE](LICENSE) (Copyright (c) 2026 dcz66614).` |
| README 全文 `grep -ci 'pending sam'` | 0 |
| dist.zip 内 package.json `grep -n '"license"'` | 第 11 行：`"license": "MIT"` |

对照——R3 冻结 `release/dist.zip`（364,569 B，sha `4c94159587e5e9209510b07f2df10f425412a57a0c00822b6dd942e6e1e2c7cc`，37 条目）：

| 同一检查 | 实测结果（修复前形态，与裁决一致） |
|---|---|
| LICENSE 条目 | 无输出（exit 1） |
| README 第 114–116 行 | `## License` / 空行 / `Pending Sam's decision — no LICENSE file is included yet, and no license is claimed in package.json.` |
| package.json `"license"` | 无输出（exit 1） |
| `docs/` 条目 | 无输出（exit 1） |

前后翻转确认：4 项检查在冻结 dist 上全失败、在再生 dist 上全通过。

条目级 diff（`unzip -Z1` 两版 dist.zip 逐行比对）：再生 dist 相对 R3 冻结 dist 恰好只多 4 条——`LICENSE`、`docs/host-rules.md`、`docs/images/scope-matrix.png`、`docs/quickstart.md`，无其他新增/删除条目。source.zip 条目 diff：再生版相对 R3 冻结版恰好只多 2 个文件——`skillscope/scripts/release-build.d.mts`、`skillscope/tests/regression/r4-license.test.ts`（846 → 848 文件）。

## 2. P2-R3-01 复现：dist.zip 内 README 文档链接

- `unzip -Z1 dist.zip | grep '^docs/'` → `docs/host-rules.md`、`docs/images/scope-matrix.png`、`docs/quickstart.md`（3/3）。
- 再生 dist 内 README 的全部 `docs/` 链接（用 `](docs/...)` 模式抽取）：`docs/quickstart.md`、`docs/host-rules.md`、`docs/images/scope-matrix.png`——逐项核对，3/3 在 dist.zip 内存在。README 中无其他 `docs/` 引用。
- 结论：P2-R3-01 已修复（选择了随包打包，而非改写链接，与项目 local-first 立场一致）。

## 3. 改动范围审查：输出 commit b89f786

`git show b89f786 --stat`：7 文件，+214/−18。逐文件 diff 已通读：

- `README.md`：仅 License 节 1 行改动（Pending Sam → MIT）。
- `package.json`：仅增 1 行 `"license": "MIT"`。
- `scripts/release-build.mjs`：`collectDistEntries()` 增加 `LICENSE` 根条目与 `docs/` 遍历；新增 4 项 dist 门禁（LICENSE 存在 + sha256 等于 `EXPECTED_LICENSE_SHA256`（全文 `50b8b302ffcb53aec1866ad4b94721c200400e6aac8cee12db03b85f24e39ed2`）、package.json 为 MIT、README License 节匹配 `^## License\n\nMIT` 且无 "Pending Sam"、三个 docs/ 文件齐全）；manifest 的 `generation.dist_zip` 文案同步更新。无其他逻辑改动。
- `scripts/release-verify.mjs`：对已发货 dist.zip 复核上述 4 项；"no unexpected entries" allowlist 接纳 `LICENSE` 与 `docs/`；修正一条过期注释（source.zip 中 LICENSE 是预期的，ADR-026）。无其他逻辑改动。
- `scripts/verify-all.mjs`：仅 `product_license` 标签由 `PENDING_SAM_DECISION (no LICENSE file; must not be invented)` 改为 `MIT (LICENSE, sha256 50b8b302…)` 及对应注释。
- `tests/regression/r4-license.test.ts`（新增，6 测试）：LICENSE 字节（1,065 B、sha `50b8b302…`、Copyright (c) 2026 dcz66614）、package.json MIT、README MIT 且无三句旧文案、`collectDistEntries()` 含规范哈希的 LICENSE、三个 docs/ 文件、README 全部 `docs/` 链接可达。断言均为精确值，无弱化痕迹。
- `scripts/release-build.d.mts`（新增）：仅为测试 import 声明 `collectDistEntries` 等导出（仓库已有 `.d.mts` 先例）。

未发现扩大重构、测试弱化、预期结果篡改。未触及任何现有测试文件、适配器、解析器、策略内核、Oracle 或 spec 文件；因此其余 12 项 P2 未被改动（包括 P2-R1-11 的 PROJECT_BOOK §10.2 PENDING 行，仍为冻结 spec 快照）。

观察（非缺陷，不编号）：`release-build.mjs` 的 dist 门禁中 `distPkg` 一行用 `distEntries.find((e) => e.path === "package.json").data` 未做空值守卫——若某天 `package.json` 从 dist 条目中消失，该行会抛错而非输出 `[FAIL]`。实际无法触发（同一函数始终先把 `package.json` 加入条目），且抛错同样会使构建以非零退出失败（fail-closed，只是报错较丑）；`release-verify.mjs` 的对应位置已用 try/catch 处理。建议 T014 冻结前顺手加守卫，不阻断本轮 PASS。

## 4. 门禁负向验证（两次，均在 scratch worktree，主树未动）

### 4a. 篡改 LICENSE 内容 → 冻结树门禁拦截

方法：`git worktree add /tmp/p023-t013r5-neg2 b89f786`，向 `LICENSE` 追加 `TAMPERED`（sha 变为 `a48a69cdbd94…`），删除 `release/` 后提交为 scratch commit，运行 `npm run release:build`。
结果：exit 1；`[FAIL] MIT LICENSE exists in frozen commit with the canonical content hash — LICENSE present: true, sha256 a48a69cdbd9439145cec8b508c6fdf35468daad47ff53a41cd8f92df5c6be967`。哈希钉死是真实的，不是硬编码 PASS。scratch worktree 已删除。

### 4b. 模拟 R3 缺陷回归（dist 条目丢 LICENSE）→ dist 门禁拦截

方法：新建 scratch worktree（同上），仅把 `scripts/release-build.mjs` 中 `collectDistEntries()` 的根文件列表改回不含 `LICENSE`（模拟 R3 打包遗漏重现），提交为 scratch commit。首次运行因 scratch worktree 缺 `node_modules` 而在 `npm run build (fresh)` 报 `tsc: not found`、未能到达 dist 门禁——按修复记录的同款做法以未提交的 `node_modules` 符号链接补齐后重跑。
结果：exit 1；冻结树 LICENSE 门禁 `[PASS]`（sha `50b8b302…` 正确），但 dist 门禁 `[FAIL] dist.zip contains MIT LICENSE with the canonical content hash — LICENSE entry missing`，构建失败。证明 dist 门禁独立于树门禁，专门防范打包回归。scratch worktree 已删除。

### 4c. 新版 release:verify 对 R3 冻结 release/ 的实测（附带验证）

方法：在主树直接运行 `npm run release:verify`（主树 `release/` 仍为 R3 冻结产物）。
结果：exit 1，共 7 项 FAIL——其中 5 项恰为新增 dist 检查（LICENSE 条目、LICENSE 哈希、package.json MIT、README MIT、docs/ 齐全），其余 2 项为已知的记账类 FAIL（"tracked tree clean at verify"、"working tree matches frozen commit"，因工作树已含 fix + record commit 而超前于冻结 commit，与此前各轮同类）；其余 49 项 `[PASS]`。这从反方向证明新核查门禁对真实产物是活的：它能当场抓出 R3 dist 的原缺陷。运行未改动工作树（前后 `git status` 一致）。

## 5. 关键验收命令实测（输出 commit 所在树，亲自运行）

| 检查 | 实测结果 |
|---|---|
| `npm run typecheck`（经 verify:all 内含） | exit 0，0 错误 |
| `npm test` | **573/573**（33 文件；含新增 r4-license 6 测试；原 567 + 6） |
| Python Oracle（`npm run test:oracle`） | **62/62**，OK |
| `npm run s0:gate` | PASS；48 fixtures（24 control / 24 planted）；parity 48/48；检出 24/24；误报 0；100 次重放 1 哈希；**gate_sha256 `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca` 不变** |
| `npm run verify:all` | **8/8 PASS**（typecheck、test、oracle、e2e、offline、performance、s0:gate、license-inventory 42 包） |
| `npm run verify:extracted-tree`（对再生 source.zip） | 构建 PASS、r1+r2 回归 27/27、全量 npm test 573/573；唯一 1 项失败为已知的记账类目录集差异：`missing: 03_evidence/FIX-R3; 03_evidence/FIX-R3/regenerated-release`——记录 commit `83de918` 在 scratch 冻结之后新增的证据目录所致，与 Muse 核实记录一致，不是产品缺陷 |

## 6. 回归抽查：R2 的 P1-R2-02 在再生 dist 上第一手复现

方法（GPT R3 §3.1 原方法）：在 `/tmp/t013r5-xscope` 建合成目录，`.agents/skills/shared/SKILL.md` 为唯一物理文件；profile 的 REPO 与 USER 两个 source root 指向同一路径，policy 禁止 USER；用再生 dist 的 CLI（`node dist/cli/index.js audit --profile ./profile.json --out ./report.json`；dist.zip 内无 node_modules，按其设计在解压目录以符号链接接入仓库 node_modules 后运行）执行。首次运行因 profile 只定义 2 个 root 而其余 3 个来源未枚举，得到 INCOMPLETE（exit 2）——属我方 fixture 不完整，非产品问题；补齐 ADMIN/SYSTEM/PLUGIN 三个 root（取 demo fixture 的 `bundled.json`、`plugins.json` 与空 `admin/skills/`）后重跑。
实测结果（与 R3 裁决逐字一致）：

```
CODEX / profile: r3-dist-cross-scope-repro
  ✓ repo/.agents/skills/shared/SKILL.md
  ✓ user/.agents/skills/shared/SKILL.md
  ! SCOPE_LEAK [P1] (USER): scope USER is forbidden by policy but skill 'shared' (user:.agents/skills/shared/SKILL.md) is ELIGIBLE
  coverage: 5/5 sources enumerated
RESULT: FAIL
CLI_EXIT=1
```

报告 JSON：`status: FAIL`，findings 仅 `[SCOPE_LEAK P1 USER]`。P1-R2-02 在新的 dist 产物上仍成立，无回归。R1 的 8 项修复、P1-T013R-01、P2-T013R-02 由 Oracle 62/62（含相关回归用例）与全量 573/573（含 r1/r2/r3 回归套件）覆盖，未逐项另做 CLI 复现。

## 7. 再生发布物与清单一致性

- 再生 manifest（`03_evidence/FIX-R3/regenerated-release/RELEASE_MANIFEST.json`）：`license: "MIT"`；`frozen_commit: f6b35a8a5fc7f0e801e223fafe737fa6996eaaff`（scratch commit，报告已写明，非 fix commit 本身）；source.zip 2,886,320 B / sha `850c5713778c188c350faf86e4ef2a5e58eb77eb1c426e6f5abebde1e57553c4` / 848 文件；dist.zip 513,226 B / sha `f405795b4428d133ae6a211991938068fcf9256d3dfc47a067a4c828fbbd05a7`；`clean_room_audit_sha256` = `repo_audit_sha256` = `dist_zip_audit_sha256` = `948f94149b3a451f25c93ff2587e3f009e79ca4be0f960a964fbd95b314f9fce`，与 R3 冻结 manifest 完全一致（修复只动打包与元数据，未动审计逻辑）。
- 修复员的冻结日志已抽查：`p023-fixr3-freeze-build2.log` 末尾 source/dist 哈希与再生文件一致；`p023-fixr3-freeze-verify.log` 末尾 `release:verify PASS — frozen f6b35a8…`。确定性重跑（两次构建字节一致）未由我重跑，采信日志；T014 冻结时会再次完整执行。
- ADR-026 “第二轮冻结的 source.zip / dist.zip 均含 LICENSE”对 dist.zip 不实的更正：修复员已在报告中记下，未改写决策日志原文。处理正确。

## 8. 工作树状态与证据边界

- 复核开始时工作树已有 5 个未提交修改（`03_evidence/T012/e2e.json`、`licenses.json`、`performance.json`、`verify-all.json`、`verify-all.log`），系 Muse 核实重跑刷新 T012 证据所致；复核结束时仍为同一 5 文件，未新增改动。它们不在输出 commit `b89f786` 内，不影响本复核结论。
- 未发现新的 P0/P1/P2。P2-R1-13 仍为 FALSE，不计入。
- 未做 T014 冻结，未碰 GitHub/Drive，未替 Muse 写核实记录。

## 下一步

通过本复核后，按既定流程派新 T014 冻结（第 4 轮），再申请 R4（第 4/5 轮）。
