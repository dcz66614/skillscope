# T013_REPORT.md — 独立代码、规则与证据复核（S5）

- TASK_ID: T013（S5）
- BASE_COMMIT: `8a7f736`（`P023: T012 control note`；T001–T012 已 PASS，树干净）
- OUTPUT_COMMIT: `a3ff7f4`（审查文件提交；本行由控制提交回填）
- 审查者：独立审查会话（未参与 T001–T012 实现；未修改源码、fixtures、golden、Oracle 或 release 文件）
- 完成时间（UTC）：2026-11-13 ~16:40
- 状态：**PASS**（P0=0，P1=0，P2=10，非阻塞；见 §3）
- 本报告为审查者自写；Muse 的验收记录由 Muse 亲自另写，不在本文件。

## 1. 验收命令与真实结果（全部亲自跑，退出码均为 0）

| # | 命令 | 退出码 | 关键输出 |
|---|---|---|---|
| 1 | `npm run verify:all` | 0 | 8/8 步骤通过：typecheck 0、test 0、test:oracle 0、test:e2e 0、test:offline 0、test:performance 0、s0:gate 0、license-inventory 0（42 个包）；总耗时 ~54 s |
| 2 | `npm run test:oracle` | 0 | Python Oracle 单元测试 `Ran 42 tests … OK`（0.048 s） |
| 3 | `npm run s0:gate` | 0 | S0 gate PASS；**gate_sha256 不变：`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`**；parity 48/48；golden production 48/48、oracle 48/48；检出 24/24；误报 0；未枚举源 11（跨 10 夹具）；外部请求 0；源写 0；重放 100 次 1 个哈希 |
| 4 | `npm run test:e2e` | 0 | `e2e: PASS — 28/28 checks passed`（三 demo 冻结退出码 1/0/2；HTML 内嵌 JSON 逐字节相同；外部资源 0；夹具树前后相同；截图 136,209 B） |
| 5 | `npm run test:offline` | 0 | `offline-check: PASS — no account, no LLM, no network, no real skills needed`（静态扫描、死代理三态 1/0/2、文档扫描均 OK） |
| 6 | `sha256sum -c 03_evidence/T013/review-inputs.sha256` | 0 | 638 行全部 OK（见 §4） |

另跑：`npm test` 独立一次（verify:all 之外）：28 个测试文件，**525/525 通过**，exit 0（~20 s）。两次全量均通过，无 flake。

> 路径说明：任务书验收命令原文为 `sha256sum -c evidence/T013/review-inputs.sha256`，仓库实际证据目录为 `03_evidence/T013/`（计划 §5 T013 的 `evidence/T013` 写法与仓库实际不符）。本审查按实际路径执行并通过。

## 2. S0 gate 哈希

- 冻结 gate：`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`
- 本轮实测（verify:all 内一次 + 独立 `npm run s0:gate` 一次）：两次均为同一哈希，**不变**。
- S0 指标：48 夹具（control 24 / planted 24；16/宿主）、parity 48/48、golden 48/48、检出 24/24、误报 0/24、重放 100 次 1 个哈希。

## 3. 发现统计

| 级别 | 数量 | 清单 |
|---|---|---|
| P0 | 0 | — |
| P1 | 0 | — |
| P2 | 10 | P2-T013-01 `localeCompare` 排序；P2-T013-02 canonical 字节形式/哈希约定分裂；P2-T013-03 OMB 适配器透传绝对路径 detail；P2-T013-04 OMB PoC `unknownScopes` 重复；P2-T013-05 `ProfileV1` 接口漂移；P2-T013-06 Codex PoC 与 registry 归并键不同；P2-T013-07 PoC 无保留词规则；P2-T013-08 `release:build`/`release:verify` 目标文件不存在（T014 自有）；P2-T013-09 死代码（`skipped` 数组、`dedupeRootIds` 碰撞分支）；P2-T013-10 `build-lock.mjs` stale-steal TOCTOU |

全部 10 项见 `03_evidence/T013/FINDINGS.md`（每项含位置、实测证据、影响与建议）。无一改变审计状态、finding 或 gate 结果，故不阻塞 T014。

## 4. review-inputs 清单

- 文件：`03_evidence/T013/review-inputs.sha256`（84,334 B；sha256 `776c084b032b23d2f456d64417d08a88c2c80a7a96ec66689862f322978c14c1`）
- 范围：`git ls-files` 下的 640 个冻结输入文件（`00_control`、`01_spec`、`schemas`、`src`、`oracle`、`scripts`、`tests`、`docs`、`.github`、README.md、package.json、package-lock.json、tsconfig.json、tsconfig.build.json、vitest.config.ts），其中 **638 个常规文件**已哈希并全部验证 OK。
- 排除的 2 个文件（均为 git 跟踪的 symlink，`sha256sum` 跟随链接到目录而无法哈希；已用 git blob hash 另行记录）：
  - `tests/fixtures/s0/codex/c06-symlink-alias/layout/repo/.agents/skills/alpha-alias` → `alpha`（mode 120000，blob `7e74e68b2a782a3aead46d987a63ca1c91091c13`）
  - `tests/fixtures/t008/claude/b18-symlink-escape/plugin-acme/escape` → `../shared/secret`（mode 120000，blob `fab9b7c7352e4b0e2dd5f92eac1856eaebcdfc12`）
- `03_evidence/` 整体不在清单内（证据为输出；T012 文件在重跑验收命令时会被改写时间戳字段，T013 不把它们当作冻结输入）。

## 5. 交付文件

| 文件 | 字节 | 说明 |
|---|---|---|
| `00_control/REVIEW_INDEX.md` | 见文件 | 审查索引（审查范围、包清单、结论、T014 解锁） |
| `03_evidence/T013/REVIEW_PACK_01.md` | 10,701 | 规格、控制、宿主规则、Schema、文档、CI |
| `03_evidence/T013/REVIEW_PACK_02.md` | 11,833 | 内核、适配器、CLI（`src/` 全文） |
| `03_evidence/T013/REVIEW_PACK_03.md` | 13,315 | Oracle、S0 gate、全部 scripts、T012 修复复核 |
| `03_evidence/T013/COVERAGE_MATRIX.csv` | 10,444 | 逐文件 READ / NOT_READ / RUN / GATE_VALIDATED |
| `03_evidence/T013/INDEPENDENT_REVIEW.md` | 7,318 | 独立复核主文档（方法、语义决策核对、结论） |
| `03_evidence/T013/FINDINGS.md` | 10,298 | P0=0、P1=0、P2=10 清单 |
| `03_evidence/T013/T013_REPORT.md` | 本文件 | 任务报告（验收记录由 Muse 亲自写，不在此） |
| `03_evidence/T013/review-inputs.sha256` | 84,334 | 638 个冻结输入文件的 SHA-256（全部验证 OK） |

## 6. 实测探针（合成输入、只读、/tmp 内）

| 探针 | 结论 |
|---|---|
| Codex 非法 `config.toml` | PoC INCOMPLETE，`unknownSources [USER,ADMIN,SYSTEM,PLUGIN]`，`FAIL_OPEN_CONFIG/GLOBAL` + 4× `SOURCE_NOT_ENUMERATED`，REPO 实例 UNKNOWN；kernel 承接为 `unknownScopes [ADMIN,PLUGIN,SYSTEM,USER]`；文档“SYSTEM / PLUGIN 报告 unknown”成立 |
| OMB 两个缺失 snapshot skill（同 scope）+ 无效 config | PoC `unknownScopes ["CONFIG","REPO","REPO"]`（重复，P2-T013-04）；适配器 AuditResult 中 3 条 finding 含绝对路径（P2-T013-03） |
| Canonical 跨语言边角 | U+2028/emoji：TS 与 Python canonical 字符串逐字节相同；astral 键：Python 与 TS 以 U+E000 在前，s0-canonical 以 U+10000 在前；`-0.0`：Python `"-0.0"` vs TS `"0"`；孤 surrogate：Python 抛 `UnicodeEncodeError`，TS 可处理（P2-T013-02） |
| demo HTML 脱敏 | `03_evidence/T009/demo/*.html` 中 `/home/hatch` 出现 0 次；CLI redaction 有效 |
| Codex `resolveCodexAudit(poc, null)` | 抛 `invalid policy: policy must be an object`（fail-closed，不静默丢 finding） |

## 7. 语义决策核对（任务书点名项）

- ADR-005（kernel 拥有策略比较权）：通过——CLI 与两完整适配器均传 policy；见 INDEPENDENT_REVIEW.md §3。
- ADR-006（有效集 = ELIGIBLE）：通过——`effectiveInstances` 只取 ELIGIBLE；PoC 分歧已记录、kernel 重算。
- ADR-015（先 NFC 再排序；碰撞 fail-closed）：通过——Python 锚点 `e85a9a77…` 已验证；分歧只影响病态输入。
- ADR-011/ADR-012 后续遵守：通过——但有 P2-T013-02（跨语言边角）与 P2-T013-03（OMB 未 sanitize）。
- T012 两处修复：通过——23 个 `.gitkeep` 仍在（`git ls-files "**/.gitkeep"` 23 个）；竞态修复后两次全量 525/525 无 flake；**均未降低正确性门槛**。

## 8. 证据恢复

验收命令重写的 `03_evidence/T012/`（e2e.json、licenses.json、performance.json、verify-all.json、verify-all.log）与 `03_evidence/S0/` 已按惯例 `git checkout --` 恢复；提交前树中只有 T013 审查文件为新增/修改。

## 9. 已知局限

1. 全量 mutation 本轮未重跑（T011 证据 20/20 = 100% 完整；gate/全量套件已重跑通过）；mutation 只覆盖 kernel 规则。
2. Property 测试为固定 seed 有限抽样，非穷举。
3. Windows 未实测；性能基线只适用于本 VM。
4. 测试文件与夹具的覆盖标注诚实区分 READ / RUN / GATE_VALIDATED（见 COVERAGE_MATRIX.csv）；`scripts/release-build.mjs`、`scripts/release-verify.mjs` 与 `docs/images/scope-matrix.png` 为 NOT_READ（前两者不存在，后者为二进制图片）。
5. T013 审查文件本身的提交不改变任何源码、fixture、golden 或 Oracle 文件。
