# REVIEW_PACK_02 — 内核、适配器与 CLI（P023 T013 独立复核）

- 任务：P023 SkillScope T013（S5 独立复核）
- 冻结候选：`8a7f736`；S0 gate `a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca`
- 日期（UTC）：2026-11-13
- 本包范围：`src/` 全部 29 个代码/配置文件 + `src/adapters/codex/README.md`。
- 结论：本包范围内未发现 P0/P1。发现 7 项 P2（P2-T013-01、-03、-04、-05、-06、-07，及 P2-T013-09 的一部分），均见 FINDINGS.md。

## 1. 读过的文件（src/ 全文，29/29）

resolver/index.ts、policy/index.ts、findings/index.ts、canonical/index.ts、contracts/index.ts、
identity/identity.ts、identity/source-graph.ts、discovery/discovery.ts、manifest/manifest.ts、
io/index.ts、privacy/index.ts、report/index.ts、cli/audit.ts、cli/index.ts、cli/init.ts、cli/verify.ts、
adapters/codex/codex-poc.ts、adapters/claude/claude-poc.ts、adapters/claude/adapter.ts、
adapters/claude/marketplace.ts、adapters/claude/settings.ts、adapters/claude/rules.ts、
adapters/claude/index.ts、adapters/shared/skill-scan.ts、
adapters/openmausbot/openmausbot-poc.ts、adapters/openmausbot/adapter.ts、
adapters/openmausbot/snapshot.ts、adapters/openmausbot/index.ts，
外加 adapters/codex/README.md。逐文件结论见 §2–§8。

## 2. 内核（resolver / policy / findings）

- `resolver/index.ts`：kernel 唯一入口。`resolveCodexAudit` / `resolveClaudeAudit` / `resolveOpenMausBotAudit` 均先剥离 PoC 的内联 SCOPE_LEAK finding、再经 `src/policy` 重算（ADR-005）；`dedupeFindings` 用码点 `<` 重排去重；`unknownScopes` 排序但**不去重**（见 P2-T013-04）；`CONFIG` 未知 scope 仅在无其他未知源时补（Codex 探针：已有 4 个未知源时不补）。状态优先级 INCOMPLETE > FAIL > PASS（Property P7 覆盖）。
- `policy/index.ts`：`effectiveInstances` 只取 `status === "ELIGIBLE"`（ADR-006）；`normalizePolicy` 拒绝非法策略（scope 又允许又禁止、空名、非数组）而非静默修复；`comparePolicy` 按精确逻辑名匹配（`deploy` 不匹配 `acme:deploy`，反之亦然）；`expectedCount = effectiveCount − 违规实例数`。实测：`resolveCodexAudit(poc, null)` 抛 `invalid policy: policy must be an object`——kernel 要求 policy 对象，CLI 永远传 profile policy（schema 要求 policy 必填）。
- `findings/index.ts`：finding 目录冻结；severity 取自目录；未知 id 与空 detail 抛错（Property P5 覆盖）。`NAME_SELECTOR_BLAST_RADIUS`、`SAME_NAME_COLLISION`、`FAIL_OPEN_CONFIG`、`SCOPE_LEAK`、`DISABLE_MISMATCH`、`SOURCE_NOT_ENUMERATED` 的 P1/P2 分级与 PROJECT_BOOK §5.2 一致。

## 3. 适配器（Codex / Claude / OpenMausBot）

### Codex PoC（`codex-poc.ts`）
- 五源枚举、path/name selector（last match wins）、bundled enabled 开关、symlink 实路径归并（alias 保留）、`configReadable === false` 时全部实例 UNKNOWN + `FAIL_OPEN_CONFIG` + INCOMPLETE——均与 host-rules.md 一致，**已用合成探针实测**（非法 `config.toml` → 见 PACK_01 §4）。
- `addSkillDir` 按**实路径**跨所有源根归并：同一物理文件在两个根下出现时，第二个根的 scope 丢失、alias 记在首次见到的实例上。`IdentityRegistry` 按 `(sourceRootId, canonicalPath)` 键控，同一文件在两个根下会是两个实例。两者在生产路径中永不相遇（CLI 用 PoC，不用 registry；registry 只被 `scripts/identity-evidence.mjs` 使用），S0 夹具亦一致。记为 P2-T013-06（潜在身份模型分歧）。
- 最小 frontmatter 解析器只取顶层 `name:`，**不拒绝含 `anthropic`/`claude` 的保留词名**；完整 T005 解析器（`manifest.ts`）拒绝。完整审计路径上 Claude 适配器（§6d）与 OMB 适配器重检会补上，但 S0 gate（仅 PoC）不会标记保留词名。记为 P2-T013-07（分层分歧，与 ADR-006 同类）。
- `canonicalPath` 在逃出布局根时回退为绝对实路径（PoC 输出中的机器本地值；kernel 用 canonical key 重写 instanceId，不把 canonicalPath 带入 `NormalizedInstance`）。备注，非 finding。

### Claude 适配器（`claude-poc.ts` / `adapter.ts` / `settings.ts` / `marketplace.ts` / `rules.ts`）
- PoC 与完整适配器分层清晰：PoC 做来源枚举与内联策略检查，完整适配器做 settings 层合并、marketplace 枚举、manifest 重检、信任门控，再把 policy 交给 kernel。
- `sanitizeDetail` 把 finding detail 中的 fixtureDir 改写为 `<FIXTURE_DIR>`；`mergeEffectiveDisables` 中高优先级 `true` 可重新启用插件，但 `skillOverrides` 无重新启用路径（设计如此，仅 "off"）。
- `marketplace.ts::resolveMarketplaces` 把 `skipped` 数组传进 `enumerateMarketplacePlugins` 但**从不 push**（`skippedPlugins` 恒为空）。记为 P2-T013-09（死记账， cosmetic）。
- `adapter.ts::dedupeRootIds`：派生根 id 与调用方提供的 id 碰撞时，原样 push 后在步骤 4 被静默跳过（其路径永不扫描）；id 按构造唯一（`plugin-<market>-<plugin>`），应为死代码。记为 P2-T013-09。
- `rules.ts` 与 `claude-rules.json` 的镜像关系由 `tests/claude/rules.test.ts` 断言（版本、scope 列表、precedence、文件名、disable mechanisms、不含 `disabledPlugins`）。通过。
- 发现排序用 `localeCompare`（`claude-poc.ts:302-303`）：locale 相关；kernel `dedupeFindings` 会用 `<` 重排，gate 不受影响；原生 PoC finding 顺序在不同默认 locale 下可能不同。记为 P2-T013-01。

### OpenMausBot 适配器（`openmausbot-poc.ts` / `adapter.ts` / `snapshot.ts`）
- PoC：config flags、library opt-out、snapshot 三源；缺失 snapshot skill → `unknownScopes.push(scope)`，**同一 scope 的两个缺失 skill 会产生重复条目**。**实测**：两个缺失的 repo skill → PoC `unknownScopes ["CONFIG","REPO","REPO"]`。kernel 只排序不去重；完整适配器经 `sortedUnique` 去重后才调 kernel；S0 golden 无重复。记为 P2-T013-04。
- PoC finding detail 嵌入绝对路径（`${configPath}`、`${optOutPath}`、`${skill.path}`、`${skill.originalPath}`）；`adapter.ts` 原样透传，不像 Claude 适配器那样 sanitize。**实测**：适配器返回的 AuditResult 中 3 条 finding 含绝对 `/tmp/...` 路径（`FAIL_OPEN_CONFIG` + 2× `SOURCE_NOT_ENUMERATED`），与其文件头注释“Finding details never contain absolute paths（§4.2 rule 5）”矛盾。导出物由 CLI `redactReport` 兜底（demo HTML 实测 0 绝对路径），控制台摘要会打印原始 detail。记为 P2-T013-03。
- `snapshot.ts` 校验器与 `openmausbot-snapshot-v1.json` 的镜像关系由 `tests/openmausbot/snapshot.test.ts:183` 断言（required/枚举一致）。通过。
- 发现排序用 `localeCompare`（`openmausbot-poc.ts:488-489`）：同 Claude，记为 P2-T013-01。

### 共享 skill-scan（`skill-scan.ts::parseFrontmatter`）
- 见 §3 Codex 小节：无保留词规则（P2-T013-07）。

## 4. Canonical / 隐私 / IO（ADR-011 / ADR-012 遵守情况）

- `canonical/index.ts`：UTF-8、LF（写盘时补一个 LF，canonical 字符串本身无尾 LF）、码点键序（非 UTF-16 码元序）、全部字符串 NFC、`-0`→`0`、非 JSON 值抛错；键先 NFC 再排序（ADR-015/T011 修复）；NFC 碰撞键 fail-closed 抛 `TypeError`。15 个冻结向量三方一致；Python 锚点 `e85a9a77…` 已验证。**后续任务遵守 ADR-011/ADR-012**：`report/index.ts` 与 `io/index.ts` 均经 canonical 函数写盘；`privacy/index.ts` 的 redaction（敏感键扁平名、密钥值模式、绝对路径 → `<HOME>`/`<CWD>`/`<ROOT>`/`<ABS_PATH>`、用户名 → `<USER>`）被 CLI、demo、e2e 一致使用。
- **跨语言边角分歧**（P2-T013-02，详见 PACK_03 §3）：TS `canonicalSha256` 对无 LF 字节哈希；Python `sha256_hex` 与 `s0-canonical.mjs::sha256Hex` 对带一个尾 LF 的字节哈希；`s0-canonical.mjs` 的 `normalise` 用默认 `.sort()`（UTF-16 码元序）而 TS/Python 按码点排序——**实测**：astral 键 `{U+10000, U+E000}`，Python 与 TS 均以 U+E000 在前，s0-canonical 以 U+10000 在前；Python `canonical_json(-0.0)` 得 `"-0.0"`，TS 得 `"0"`。无任何实时跨实现比较（gate 只比较经同一 s0-canonical 规范化后的字符串；报告哈希只用 TS），故为潜在分歧，非实时缺陷。另：孤 surrogate 输入使 Python `canonical_bytes` 抛 `UnicodeEncodeError`，TS 可处理——仅病态输入。

## 5. 身份 / 发现 / Manifest（T005）

- `discovery/discovery.ts`：有界遍历；symlink loop（SYMLINK_LOOP）、逃出根（SYMLINK_OUTSIDE_ROOT）、dangling（CANONICAL_PATH_UNRESOLVABLE）、超大（SKILL_MD_TOO_LARGE）、目录型 SKILL.md（SKILL_MD_UNREADABLE）均有记录且终止；树外内容永不读取（T005 证据脚本断言）。
- `identity/identity.ts` + `source-graph.ts`：registry 按 `(sourceRootId, canonicalPath)` 键控；alias 归并、同名碰撞、同内容组、实例排序均有 Property P3 覆盖。注意：registry 与 Codex PoC 的归并键不同（见 §3，P2-T013-06），但生产路径只用其一。
- `manifest/manifest.ts`：完整 frontmatter 解析（YAML）；保留词名（`anthropic`/`claude`）拒绝；INVALID 实例保留在 registry 中不丢弃；`tests/manifest` 19/19（T005 证据）。

## 6. CLI 与报告（T009/T010）

- `cli/audit.ts`：profile 加载 → schema 校验 → 按 engine 分发适配器 → **policy 必传 kernel**（ADR-005，见 PACK_01 §3）→ `redactReport` → 写 JSON/HTML → 控制台摘要 → 退出码。`mapProfilePolicy` 处理 `allowed_scopes`、`forbidden_scopes`、`forbidden_names` 三者。
- `cli/index.ts` / `init.ts` / `verify.ts`：`init` 只写合成 home（永不指向真实 home）；`verify --fixtures s0` 跑 gate；`--ci` 仅 audit 可用（`verify --ci` 应 exit 3，T012 竞态修复中曾以此为回归信号）；退出码 PASS 0 / FAIL 1 / INCOMPLETE 2 / 输入 3 / 内部 4，INCOMPLETE 永不弱化（ADR-014）。
- `report/index.ts`：`inventory_sha256` = canonicalSha256(audit.instances)；`audit_sha256` 对自身为 null 的 report 哈希；`oracle_result_sha256` 恒为 null（诚实标注，CLI 从不跑 Oracle）；INCOMPLETE 时 `observed_count` 为 null；HTML 内嵌 JSON 与 JSON 报告逐字节相同（e2e 断言）；`scanExternalResources` 检 0 外部资源。
- `contracts/index.ts`：`ProfileV1.policy` 只列 `allowed_scopes` + `forbidden_names`，而冻结 schema 另有 `forbidden_scopes`（“T006 扩展”）。`mapProfilePolicy` 处理三者，故仅接口漂移、无运行时影响。记为 P2-T013-05。

## 7. 配置文件

- `package.json`：运行时依赖仅 smol-toml 1.9.1 + yaml 2.9.1（均精确锁定，无 `latest`/浮动）；`private: true`；`engines node >=24`。脚本表见 PACK_03 §5；`release:build`/`release:verify` 目标文件缺失（P2-T013-08）。
- `tsconfig.json` / `tsconfig.build.json`：strict、noUncheckedIndexedAccess、NodeNext；build 只含 `src`。`npm run typecheck` 本轮通过（verify:all 步骤 1）。
- `vitest.config.ts`：仅声明 globalSetup（dist 只构建一次）；测试发现为默认（全部 `*.test.ts`）。

## 8. 本包未发现 P0/P1 的依据

- 三宿主 PoC + 完整适配器 + kernel 的行为与 PROJECT_BOOK §4.1–§4.5、§5.2 及 host-rules.md 逐条对照，无规则缺失或反向实现。
- ADR-005/006/011/012/013/014/015 在代码中均有对应实现且经实测或测试锁定。
- 全部 7 项 P2 均为：排序 locale 相关性、跨语言边角分歧、PoC 层重复/绝对路径、接口漂移、身份模型潜在分歧、死代码/死记账——无一改变审计状态、finding 或 gate 结果。
