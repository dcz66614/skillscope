# P023 SkillScope — T014 Freeze Report（第四轮正式冻结，为 R4 终审）

- TASK_ID: T014（第四轮）
- STATUS: **PASS**
- Frozen commit（冻结 commit）: `58875164f4481653b468cd4e7b4e751420b2ba1d`（冻结 commit 日期 2026-11-13T21:45:17+00:00）
- SPEC_VERSION: `1.0.0`
- License: `MIT`（Sam 于 2026-11-13 ~18:02 GMT 决定全部项目许可证均为 MIT；FIX-R1 已把 MIT LICENSE 加入仓库根，内容哈希 `50b8b302ffcb53aec1866ad4b94721c200400e6aac8cee12db03b85f24e39ed2`，与 P021 的 LICENSE 字节一致）
- 生成命令：`npm run release:build`（scripts/release-build.mjs）、`npm run release:verify`（scripts/release-verify.mjs）、`npm run verify:extracted-tree`（scripts/verify-extracted-tree.mjs）
- 生成时间（UTC）：2026-11-13 ~21:45–21:47（build 与 verify 在冻结 commit 上各跑一次；manifest 内时间戳取冻结 commit 的 committer date，故重跑产物字节相同）
- 上一轮冻结报告：本文件覆盖上一轮（R3 冻结 commit `59ff9d5`，source.zip 2,881,616 B sha `6ca98ec7…`）；上一轮报告全文保留在 git 历史中，上一轮冻结产物保留在 Drive 03_release 的文件版本历史中。
- 本轮冻结背景：终审 R3 FINAL_VERDICT: FAIL（P0 0 / P1 1 / P2 13），唯一阻断项 P1-R3-01（dist.zip 缺 MIT LICENSE）与非阻断 P2-R3-01（dist README 引用的 docs/ 未打包）。FIX-R3（输出 commit `b89f786`，记录 commit `83de918`）已修复两者；Muse 亲自核实通过（`~/workspace/coordinator-logs/muse-fix-r3-verify.md`）；独立 T013 复核第 5 轮 STATUS = PASS（`03_evidence/FIX-R3/T013_REREVIEW4_REPORT.md`，P1-R3-01 与 P2-R3-01 均经前后对照复现确认修复，0 新问题）。

## 产物

| 文件 | 字节 | SHA-256 |
|---|---:|---|
| `release/source.zip` | 5,611,624 | `15b90a4c54637be16eef0d4c9d4b785c627db74ed3e3e65c7964442b49f94414` |
| `release/dist.zip` | 513,226 | `f405795b4428d133ae6a211991938068fcf9256d3dfc47a067a4c828fbbd05a7` |
| `release/RELEASE_MANIFEST.json` | 2,405 | `2c2f6fa1ec36af2c0bddc1348735cc49f85b4bad8c0e79856af8cc0ceba8f632` |
| `release/SHA256SUMS.txt` | 240 | `75e5bbb8c0fd952a890331f22772f9176b868e00910a421502871e538162b1ee` |
| `release/RELEASE_FILE_LIST.csv` | 149,973 | `7c4ec12e2e6ab921335b5829bdd377999ca03cc484f32bb1a8e7243607563920` |

- `source.zip`：`git archive --format=zip --prefix=skillscope/ 58875164…` 的完整树，858 个文件（另有 1,206 个目录条目，不含 ZIP 根目录口径；`unzip -l` 共 2,064 条目）。内容与 `RELEASE_FILE_LIST.csv`（858 行文件 + 1 行表头，每行 path、bytes、content SHA-256、git blob SHA）逐字节一致，verify 已从冻结 commit 重新生成并比对。
- `dist.zip`：41 个条目（1980-01-01 固定时间戳、按路径排序、STORE 无压缩，故字节可重现）：`package.json`、`package-lock.json`、`README.md`、`LICENSE` 在根目录，`dist/` 29 个编译产物、`schemas/` 4 个文件、`docs/` 3 个文件、`src/adapters/openmausbot/openmausbot-snapshot-v1.json` 1 个。解压后 `npm ci` 即可运行（`node dist/cli/index.js`）。
- **`dist.zip` 与 FIX-R3 再生 dist.zip 字节一致**：sha `f405795b…`、513,226 B、41 条目，与 `03_evidence/FIX-R3/regenerated-release/dist.zip` 逐字节相同（确定性已证；FIX-R3 报告称两次构建字节一致，本轮在正式冻结中第三次复现同一哈希）。
- `SHA256SUMS.txt` 覆盖 source.zip、dist.zip、RELEASE_MANIFEST.json 三者（`sha256sum -c` 全部 OK）。
- 三处烟囱审计的 `audit_sha256` 完全相同（路径无关脱敏的证明）：clean-room `948f94149b3a451f25c93ff2587e3f009e79ca4be0f960a964fbd95b314f9fce` = repo `948f9414…` = dist.zip `948f9414…`（demo codex-fail profile，均 exit 1）。该值与第一、第二、第三轮冻结完全相同——demo profile 未变，审计哈希稳定。

## 冻结门禁（构建时核对，全部通过）

- S0 gate：PASS，gate_sha256 `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`，seed `P023-SKILLSCOPE-S0-2026-11-13`（冻结 commit 内 `03_evidence/S0/S0_GATE.json` 实测）。
- T013 独立复核：原报告 P0=0、P1=0、P2=10（非阻塞；冻结 commit 内 `03_evidence/T013/T013_REPORT.md` 实测；manifest 的 `review` 段亦取此值）。第五轮复核（FIX-R3 后）STATUS = PASS：P1-R3-01 与 P2-R3-01 均已真正修复（复核者亲自复现前后翻转，含 R3 冻结 dist 对照），R1 的 8 项修复、P1-T013R-01、P2-T013R-02、R2 的两项 P1 均仍成立，0 新 P0/P1/P2（冻结 commit 内 `03_evidence/FIX-R3/T013_REREVIEW4_REPORT.md`，复核 commit `102609b`）。
- MIT LICENSE：冻结树根有 LICENSE，内容哈希为规范值 `50b8b302…`（build 与 verify 均核对，见 ADR-026）。
- dist LICENSE 门禁（FIX-R3 新增）：dist.zip 含 LICENSE 且 SHA 为规范值 `50b8b302…`；dist `package.json` 的 license 为 MIT；dist README License 节为 MIT 且无 "Pending Sam"；dist.zip 含 README 链接的三个 docs/ 文件（build 与 verify 均核对）。
- 空目录门禁（FIX-R2 新增，ADR-028）：`emptyDirsMissingGitkeep()` 打包前核对，冻结树内 51 个 `.gitkeep` 目录全部在位，叶空目录无缺 `.gitkeep` 者；`release-verify` 的目录集比对通过（冻结 commit 目录集 vs source.zip 目录条目，空目录亦计入）。

## 验收命令与退出码（全部真实跑出）

| 命令 | 退出码 | 关键输出 |
|---|---:|---|
| `npm run typecheck` | 0 | 通过（经 verify:all 内含；FIX-R3 核实亦实测 0 错误） |
| `npm test` | 0 | 33 文件，**573/573**（含新增 r4-license 6 测试；FIX-R3 核实与 T013 第 5 轮复核均实测） |
| `npm run test:oracle` | 0 | **62/62**（同上） |
| `npm run s0:gate` | 0 | PASS，gate_sha256 `a11d2a4c…` 不变（同上） |
| `npm run test:e2e` | 0 | 28/28（同上） |
| `npm run test:offline` | 0 | PASS（同上） |
| `npm run test:performance` | 0 | 500/500，hash 稳定，峰值 RSS 82.3 MiB（同上） |
| `npm run verify:all` | 0 | 8/8，42 包（同上） |
| `npm run release:build` | 0 | **39/39 通过**（38 项检查 + 1 行结尾汇总；frozen `58875164…`） |
| `npm run release:verify` | 0 | **57/57 通过**（56 项检查 + 1 行结尾汇总；frozen `58875164…`） |
| `npm run verify:extracted-tree release/source.zip`（正式冻结产物） | 0 | **PASS — 0 失败**：目录集 1206/1206，build exit 0，解压树内 r1+r2 27/27，全量 573/573 |
| `unzip -t release/source.zip` | 0 | No errors detected |
| `unzip -t release/dist.zip` | 0 | No errors detected |
| `sha256sum -c release/SHA256SUMS.txt`（在 release/ 内） | 0 | source.zip: OK；dist.zip: OK；RELEASE_MANIFEST.json: OK |
| `sha256sum -c 03_evidence/T014/review-inputs.sha256`（仓库根） | 0 | 769 行全部 OK（见下节） |
| `git status --short`（提交 release/ 与本报告后） | 0 | 空（树干净） |

注：release:build 与 release:verify 的计数沿用 FIX-R3 报告与 Muse 核实记录的口径——计数含结尾汇总行（Muse 核实记录已写明"其中各有 1 行为结尾汇总行，计数一致，无夸大"）。按检查项计：build 38/38、verify 56/56，0 FAIL。

## review-inputs 清单（本次重新生成）

- 文件：`03_evidence/T014/review-inputs.sha256`（102,824 B；sha256 `464f589bec21ee995e8e99b41e7b49b1d7af9fb9c524c0f6ae1559ad45b123fe`）
- 范围：冻结 commit 的 858 个文件，减去 `03_evidence/` 的 80 个证据文件（证据为输出，不当冻结输入）、`.gitignore` 与 3 个占位 `.gitkeep`（`02_source/.gitkeep`、`04_review/.gitkeep`、`05_release/.gitkeep`），余 774 个；其中 5 个目录符号链接无法用 `sha256sum` 哈希，排除后 **769 个常规文件已哈希，`sha256sum -c` 全部 OK**。
- 生成方法：以 `release/RELEASE_FILE_LIST.csv`（verify 已证实与冻结 commit 逐字节一致）为源，按上一轮范围过滤（`00_control/`、`01_spec/`、`schemas/`、`src/`、`oracle/`、`scripts/`、`tests/`、`docs/`、`.github/` + 根文件 README.md、package.json、package-lock.json、tsconfig.json、tsconfig.build.json、vitest.config.ts），**含根文件 LICENSE**（自第二轮起为冻结树的新输入），生成脚本为临时 Python（stdin 传入，不入仓库）。
- 排除的 5 个符号链接（均为 git 跟踪，mode 120000，`sha256sum` 跟随链接到目录而无法哈希；已用 git blob hash 另行记录，与上一轮相同）：
  - `tests/fixtures/regression/r2/r2-01-codex-symlink-escape/repo/.agents/skills/evil` → `../../../outside/real-skill`（blob `00660e687143cfd5e5f1d0a68ff10f566758aa09`）
  - `tests/fixtures/regression/r2/r2-01b-codex-symlink-launder/repo/.agents/skills/link` → `../../../home/.agents/skills/evil-skill`（blob `fa7aed76abb74082aa8d58014637bd4c45b40938`）
  - `tests/fixtures/regression/r2/r2-01d-codex-symlink-alias-in-root/repo/.agents/skills/alias` → `real`（blob `ac558a3e1bf44424bf2af97380ee201860ba8a58`）
  - `tests/fixtures/s0/codex/c06-symlink-alias/layout/repo/.agents/skills/alpha-alias` → `alpha`（blob `7e74e68b2a782a3aead46d987a63ca1c91091c13`）
  - `tests/fixtures/t008/claude/b18-symlink-escape/plugin-acme/escape` → `../shared/secret`（blob `fab9b7c7352e4b0e2dd5f92eac1856eaebcdfc12`）
- 注意：本清单描述的是冻结 commit `5887516`。随后提交 release/ 与本报告的 release commit 会翻动 `00_control/TASK_BOARD.csv` 与 `00_control/PROJECT_STATE.json`（T014 PASS 记账），届时重跑 `sha256sum -c` 会有这两行 FAILED——与上一轮冻结后相同的已知现象，不是冻结失效；R4 终审须用本清单 + 本报告注明的两处记账差异为准。

## 与上一轮冻结的差异

- 冻结 commit：`59ff9d5` → `5887516`（其间：FIX-R3 修复 P1-R3-01 + P2-R3-01、T013 复审第五轮 PASS、T012 证据刷新）。
- source.zip：2,881,616 B / 846 文件 → 5,611,624 B / 858 文件（+12 文件：FIX-R3 的 2 个新文件——`scripts/release-build.d.mts`、`tests/regression/r4-license.test.ts`——与记录提交的 10 个文件——`03_evidence/FIX-R3/FIX_R3_REPORT.md`、`T013_REREVIEW4_REPORT.md`、3 个冻结日志、`regenerated-release/` 的 5 个文件；字节增量主要来自记录提交把 FIX-R3 的再生 source.zip（2,886,320 B）本身作为证据文件收入了冻结树，属快照语义下的正常遗留，不是打包缺陷）。
- dist.zip：364,569 B / 37 条目 → 513,226 B / 41 条目（+4 条目：`LICENSE`、`docs/host-rules.md`、`docs/images/scope-matrix.png`、`docs/quickstart.md`；与 FIX-R3 再生 dist.zip 逐字节一致）。
- release:build 检查：34/34 → 39/39（新增 4 项 dist LICENSE 门禁 + 1 项 dist docs 门禁，按含汇总行口径计；按检查项计 33 → 38）；release:verify 检查：52/52 → 57/57（新增 5 项 dist 复核，按含汇总行口径计；按检查项计 51 → 56）。
- review-inputs：767 行 → 769 行（+2：`scripts/release-build.d.mts`、`tests/regression/r4-license.test.ts`；范围方法与上一轮相同）。
- manifest：`frozen_commit` 与 `source_zip.file_count` 相应更新；其余字段结构不变。
- audit_sha256：不变（`948f9414…`）。
- S0 gate SHA：不变（`a11d2a4c…`）。
- verify:extracted-tree 目录集：1204 → 1206（+2：`03_evidence/FIX-R3` 与 `03_evidence/FIX-R3/regenerated-release` 两个新目录），0 失败（本轮无记账类差异——解压树检查在 release commit 之前、对照当前工作树执行，目录集完全一致）。

## 环境（构建 VM 实测）

- OS：Linux htch-runtime 7.0.0-44-generic x86_64
- Node v24.22.1、npm 10.9.4、Python 3.12.3、git 2.43.0、linux x64
- CPU：AMD EPYC 9D25 126-Core Processor，4 核；内存 8,319,901,696 字节

## 冻结过程说明（沿用第三轮的基线做法，未发现新缺陷）

- 冻结前先提交待提交内容（commit `102609b`：T012 证据刷新 5 文件 + T013 第 5 轮复核报告），再以基线提交 `5887516` 把 release/ 移出跟踪树（`git rm -r --cached release/`，磁盘文件随后删除），再对新 HEAD 重新冻结——与第三轮冻结的基线 `59ff9d5` 同样不含 release/。原因同第三轮：`git archive` 会把旧发布包吞进新 source.zip，且 release/ 已跟踪会使 `tracked tree clean` 门禁误报。`release:build` 在磁盘无 release/ 时以 HEAD 为冻结 commit（无旧 manifest 钉住旧 commit 的脱节路径）。
- 本轮冻结未改动任何打包脚本或业务源码（冻结 commit 与上一轮 release commit 之间的 diff 只含 FIX-R3 的 7 个修复文件、记录文件、T012 证据刷新与 release/ 移除；`git diff 5afd74e..5887516 -- src oracle` 为空）。

## 交付文件清单

- `release/source.zip`、`release/dist.zip`、`release/SHA256SUMS.txt`、`release/RELEASE_MANIFEST.json`、`release/RELEASE_FILE_LIST.csv`
- `03_evidence/T014/T014_FREEZE_REPORT.md`（本报告）
- `03_evidence/T014/review-inputs.sha256`（769 行，全部 OK；上一轮清单已随本文件覆盖，旧版保留在 git 历史中）
- 控制文件：`00_control/TASK_BOARD.csv`（T014 第四轮 PASS，冻结 commit `5887516`）、`00_control/PROJECT_STATE.json`（S5_T014_PASS；`updated_utc` 2026-11-13T21:50:00Z）

## Drive 上传与重下载核对

- 上传方式：`hatch_gws_cli drive files update` 原位更新已有的五个文件（不新建），位于 P023-skillscope 的 03_release 文件夹（id `13b_NOx4SmjlDcQ7ABjG1JH0IgR30S-GB`；P023-skillscope 根文件夹 id `1e7G3achqvlbIpu5rTSxEk2jvrsRlJIFS`）：source.zip（id `1vtTZA6XQoyPwbol_BA-I1tsDUxabkY7m`）、dist.zip（id `1R1d-_jDxjKgnFqGggGkUMxS5VwVjUsd4`）、SHA256SUMS.txt（id `1U3hx_16CUBojKxch9GW8s3SGilbDF_4u`）、RELEASE_MANIFEST.json（id `1SDBoeBICaLmspp4E10eg2vlGKbQXHdsj`）、RELEASE_FILE_LIST.csv（id `1eMYVvJ_jtH3UKs2I7x0Vd8kSD_ydFy-g`）。
- 重下载核对：source.zip、dist.zip、SHA256SUMS.txt、RELEASE_FILE_LIST.csv 四个文件从 Drive 重新下载后 sha256 与本地完全一致（source.zip `15b90a4c…`、dist.zip `f405795b…`、SHA256SUMS.txt `75e5bbb8…`、RELEASE_FILE_LIST.csv `7c4ec12e…`），字节数亦一致。
- RELEASE_MANIFEST.json：`files get --alt media --output` 对该 JSON 文件未把内容写入输出文件（写出 0 字节，内容改由 stdout 返回，属该 CLI 对 JSON 文件的下载路径怪癖，非上传失败）。改用 Drive 返回的 `md5Checksum` 核对：Drive 端 `96573bb00c74bf761d04fb47459304bb` 与本地 `md5sum` 完全一致；Drive 端 size 2405 B 与本地一致，modifiedTime 2026-11-13T21:48:15Z 为本次上传时间。确认上传内容正确。

## 已知局限

1. 干净目录重建用 symlink 链接本仓库的 `node_modules` 代替 `npm ci`（本机不联网；与 T012 预演相同的唯一偏离，已在 manifest 中注明；P2-R1-15 已登记）。
2. dist.zip 烟囱审计用 demo codex-fail profile（Codex-only），它加载 profile/report/audit-result 三个 schema，但不加载 OpenMausBot 快照 schema——该文件在 dist.zip 中的存在性由 verify 的条目检查保证（同一 `loadSchema` 代码路径、同一 REPO_ROOT 计算），S0 的 OMB 夹具则由全量测试套件覆盖。
3. Secret 扫描排除含 TEST/EXAMPLE 的值与 jwt.io 公开示例——均为 T008b 夹具头声明的假 token；其余任何符合凭证 shape 的值仍会使 verify 失败。
4. 性能基线只适用于本 VM；Windows 未实测；`verify` 子命令（跑 S0 gate）是仓库内命令，不在 dist.zip 运行范围。
5. 计划 §10 布局草图里的 `05_release/` 只是空占位目录，未使用；交付物位置按 T014 验收命令为准（`release/`）。
6. 本次冻结的 source.zip 内含上一轮冻结报告（`03_evidence/T014/T014_FREEZE_REPORT.md`，记的是 `59ff9d5`）与 FIX-R3 的再生发布物（`03_evidence/FIX-R3/regenerated-release/source.zip`，记的是 scratch commit `f6b35a8`）：它们是冻结 commit 树的一部分，是快照语义下的正常遗留——冻结时新 T014 报告尚未写成；本次冻结的结论以 release/ 外的本报告与 manifest 为准。
7. review-inputs 清单的记账差异见上节末段（release commit 翻动 TASK_BOARD.csv 与 PROJECT_STATE.json 后重跑会有两行 FAILED，属已知现象）。
8. 非缺陷观察（T013 第 5 轮复核提出，仅记录，未改代码）：`release-build.mjs` 的 dist 门禁中 `distPkg` 一行用 `distEntries.find((e) => e.path === "package.json").data` 未做空值守卫——若某天 `package.json` 从 dist 条目中消失，该行会抛错而非输出 `[FAIL]`。实际无法触发（同一函数始终先把 `package.json` 加入条目），且抛错同样会使构建以非零退出失败（fail-closed，只是报错较丑）；`release-verify.mjs` 的对应位置已用 try/catch 处理。冻结只做冻结，未改代码；建议后续顺手加守卫。
