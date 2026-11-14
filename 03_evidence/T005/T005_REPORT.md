# T005 验收报告 — 技能实例身份、来源图与 canonical path（S1）

- TASK_ID: T005（S1）
- STATUS: PASS
- BASE_COMMIT: 9232d10（S0 已通过，gate a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca）
- OUTPUT_COMMIT: 38f09ff（P023 T005 PASS: skill instance identity, source graph, canonical path）
- SPEC_VERSION: 1.0.0
- 规则依据：PROJECT_BOOK.md §4.2–§4.5、§5.2、§6；IMPLEMENTATION_PLAN.md §5 T005、§2.1

## 合成证据树（固定路径 /tmp/skillscope-t005-evidence，脚本重建，运行后删除）

| 路径 | 内容 | 预期 |
|---|---|---|
| deploy/SKILL.md | name: deploy | 实例 1 |
| Deploy/SKILL.md | name: deploy | 实例 2（同名不同路径） |
| release/SKILL.md | name: release | 实例 3 |
| alias → release | symlink | 归并为实例 3 的 alias |
| copy-a / copy-b | 相同字节 | 实例 4、5 + DUPLICATE_CONTENT |
| bad/SKILL.md | name: Bad_Name | INVALID 实例，不丢弃 |
| loop/back → 树根 | symlink loop | SYMLINK_LOOP，终止 |
| esc → 树外 secret | symlink escape | SYMLINK_OUTSIDE_ROOT，永不读取 |
| ghost → 不存在 | dangling | CANONICAL_PATH_UNRESOLVABLE |
| big/SKILL.md | >1 MiB | SKILL_MD_TOO_LARGE |
| weird/SKILL.md/ | 目录 | SKILL_MD_UNREADABLE |

## 结果摘要

- 发现技能：7 个；实例：6 个；alias：1 个
- 同名冲突：2 组（deploy；copy-shared——copy-a/copy-b 既同名又同内容）；同内容组：1 组（copy-a/copy-b）
- 跳过：5 条（CANONICAL_PATH_UNRESOLVABLE、SKILL_MD_TOO_LARGE、SKILL_MD_UNREADABLE、SYMLINK_LOOP、SYMLINK_OUTSIDE_ROOT）
- INVALID 实例：1 个（bad，保留在 registry 中）
- source graph：7 个节点（1 root + 6 instance），10 条边；sha256 `280693172898e669828b8ec2f517d69579aa4111c585eb6df822d6028d2d6eb6`

## 不变量（全部通过才算 PASS）

- [x] discovered skills == 7 (deploy, Deploy, release, alias, copy-a, copy-b, bad)
- [x] instances == 6 (alias merges into release)
- [x] deploy vs Deploy are two instances
- [x] release instance has exactly the two access paths alias + release
- [x] copy-a/copy-b are two instances
- [x] duplicate-content group == 1 (copy-a, copy-b)
- [x] same-name collisions == 2 (deploy, copy-shared)
- [x] bad manifest is an INVALID instance, not dropped
- [x] loop recorded SYMLINK_LOOP
- [x] escape recorded SYMLINK_OUTSIDE_ROOT
- [x] dangling link recorded CANONICAL_PATH_UNRESOLVABLE
- [x] oversize recorded SKILL_MD_TOO_LARGE
- [x] dir named SKILL.md recorded SKILL_MD_UNREADABLE
- [x] outside secret never appears in any output
- [x] no absolute path in the source graph

## 验收命令（由协调员亲自跑，见主报告）

- `npm run test:identity -- --run`
- `npm run test:symlink -- --run`
- `npm run test:oracle`
- `npm run s0:gate`（gate hash 必须仍为 a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca）

## 已知局限

- 证据树是合成的；真实宿主目录的 identity 行为由 T006+ 的适配器集成验证。
- 权限不可读（chmod 000）在 root 运行时无法复现，改用 dangling symlink 与目录型 SKILL.md 覆盖不可读分支。
- instanceId 含本机 /tmp 固定路径，换机重跑会变；同一机器上重跑可复现。

