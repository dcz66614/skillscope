# T008b 证据报告：Snapshot I/O、隐私脱敏与规范化哈希

- 任务：P023 SkillScope T008b（S2，补齐计划 §5 T008 原文；OPEN-004）
- OUTPUT_COMMIT：841e251f2f76c03bad1f2c28d7f268f06db55e6a
- S0 gate 哈希：`a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`（不变，由验收命令核实）

## 1. Canonical 向量（TS 实现 vs 冻结 fixture vs Python 独立实现）

- 向量总数：15；三方一致：15；不一致：0
- schema fixture 的 canonical 哈希（profile / report / audit-result / snapshot）：TS 与 Python 一致 4/4
- Python 独立实现：`json.dumps(sort_keys=True, ensure_ascii=False)` + NFC + `hashlib.sha256`，与 TS 的码点键序、NFC、无空白规则逐项对照。

## 2. Schema 校验

- 用例：6；通过：6
- 覆盖 profile / report / audit-result / openmausbot-snapshot 四个 schema id；valid 与 invalid fixture 均按预期通过/失败。
- snapshot 导入（loadSnapshot，真实加载器）：4/4 通过。

## 3. PII 扫描

- 植入密钥：9 个（均为公开示例或明显伪造的测试值）；原始扫描命中：9 条，模式：aws-access-key, bearer-token, credential-assignment, github-pat, google-api-key, jwt, openai-key, private-key, slack-token
- 脱敏后扫描：0 条；残留密钥值：0；残留绝对路径：0；`<HOME>` 占位符保留。
- 扫描结果只记录模式名、JSON 路径与匹配长度，从不记录密钥值。

## 已知局限

- 密钥扫描只认已知模式（见 `SECRET_PATTERNS`）；未命中已知模式的未知格式密钥不在保证内。
- 通用绝对路径脱敏只覆盖已知文件系统根（`/home`、`/tmp`、`/etc` 等）与 Windows 盘符/UNC；T009 传入额外扫描根可扩大覆盖。
- JSON Schema 校验器只实现本工程 schema 用到的子集（无 `$ref`）；新 schema 必须保持自包含。
