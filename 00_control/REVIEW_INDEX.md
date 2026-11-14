# REVIEW_INDEX.md — P023 SkillScope 独立复核索引（T013）

- 任务：P023 SkillScope T013（S5 独立复核）
- 审查者：独立审查会话（未参与 T001–T012 实现）
- 冻结候选：`8a7f736`（`P023: T012 control note`）
- S0 gate 哈希：`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`（本轮重跑，不变）
- 日期（UTC）：2026-11-13
- 结论：**T013 PASS**。P0 = 0，P1 = 0，P2 = 10（非阻塞，见 FINDINGS.md）。**T014 可以解除 BLOCKED。**

## 审查包

| 文件 | 内容 |
|---|---|
| `03_evidence/T013/REVIEW_PACK_01.md` | 规格、控制、宿主规则、Schema、文档、CI 工作流 |
| `03_evidence/T013/REVIEW_PACK_02.md` | 内核、适配器、CLI（`src/` 全文） |
| `03_evidence/T013/REVIEW_PACK_03.md` | Python Oracle、S0 gate、全部 scripts、T012 修复复核 |
| `03_evidence/T013/COVERAGE_MATRIX.csv` | 逐文件 READ / NOT_READ / RUN / GATE_VALIDATED；核心生产文件 + 配置 100% READ |
| `03_evidence/T013/INDEPENDENT_REVIEW.md` | 独立复核主文档（方法、语义决策核对、结论） |
| `03_evidence/T013/FINDINGS.md` | P0=0、P1=0、P2=10 清单（含位置、实测证据、影响、建议） |
| `03_evidence/T013/T013_REPORT.md` | 任务报告（验收命令、探针、局限） |
| `03_evidence/T013/review-inputs.sha256` | 638 个冻结输入文件的 SHA-256（`sha256sum -c` 全部 OK） |

## 验收命令（本轮亲自跑，退出码均为 0）

- `npm run verify:all` — 8/8 步骤通过
- `npm run test:oracle` — 42 测试 OK
- `npm run s0:gate` — gate PASS，哈希不变，48/48 parity、24/24 检出、0 误报、100 次重放 1 哈希
- `npm run test:e2e` — 28/28 通过
- `npm run test:offline` — PASS
- `sha256sum -c 03_evidence/T013/review-inputs.sha256` — 638 行全部 OK

另：`npm test` 独立一次，28 文件 525/525 通过。

> 路径说明：任务书与计划 §5 T013 写 `evidence/T013/...`，仓库实际为 `03_evidence/T013/`；本审查按实际路径执行。

## 关键核对

- ADR-005（kernel 拥有策略比较权）：通过，CLI 与两完整适配器均传 policy。
- ADR-006（有效集 = ELIGIBLE）：通过。
- ADR-015（先 NFC 再排序；碰撞 fail-closed）：通过，Python 锚点已验证。
- ADR-011/ADR-012 后续遵守：通过，但有 P2-T013-02 与 P2-T013-03。
- T012 两处修复（23 个 `.gitkeep`；并行竞态三轮修复）：通过，**均未降低正确性门槛**。

## P2 清单（10 项，非阻塞）

P2-T013-01 `localeCompare` 排序；P2-T013-02 canonical 约定分裂；P2-T013-03 OMB 适配器透传绝对路径 detail；P2-T013-04 OMB PoC `unknownScopes` 重复；P2-T013-05 `ProfileV1` 接口漂移；P2-T013-06 Codex PoC 与 registry 归并键不同；P2-T013-07 PoC 无保留词规则；P2-T013-08 `release:build`/`release:verify` 目标文件不存在（T014 自有）；P2-T013-09 死代码；P2-T013-10 `build-lock.mjs` TOCTOU。

## 局限

全量 mutation 本轮未重跑（T011 证据 20/20 完整）；property 为固定 seed 有限抽样；Windows 未实测；性能基线只适用于本 VM。详见 INDEPENDENT_REVIEW.md §6 与 T013_REPORT.md §9。
