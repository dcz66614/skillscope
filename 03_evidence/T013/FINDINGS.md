# FINDINGS.md — P023 T013 独立复核发现清单

- 冻结候选：`8a7f736`
- 日期（UTC）：2026-11-13
- 统计：**P0 = 0，P1 = 0，P2 = 10**。无 P0/P1，故 T013 按通过标准为 PASS；10 项 P2 全部登记于此，供后续任务（非阻塞）处理。
- 分级依据：P0 = 改变审计结论、漏报/误报、数据泄露或 gate 失败；P1 = 规则实现与冻结规格不符、或在可达输入上产生错误结论；P2 = 潜在分歧、接口漂移、死代码、文档/工具链 hygiene，无一改变本轮审计状态、finding 或 gate 结果。

## P2-T013-01 — 发现排序用 `localeCompare`（locale 相关）

- 位置：`src/adapters/claude/claude-poc.ts:302-303`、`src/adapters/openmausbot/openmausbot-poc.ts:488-489`（finding 排序）；另 `scripts/e2e.mjs:79`、`scripts/verify-all.mjs:139,146`（名排序，仅影响输出顺序）。
- 证据：代码阅读。`localeCompare` 的比较结果依赖运行时的默认 locale；同一输入在不同 locale 下可能产出不同顺序的 finding 列表。
- 影响：无实时影响——kernel `dedupeFindings` 会用码点 `<` 重排去重，S0 gate 的 canonicaliser 亦用 `<` 重排，100 次重放 1 个哈希；原生 PoC finding 顺序在另一台默认 locale 不同的机器上可能不同。
- 建议：finding 与名称排序改用码点比较（与 `compareCodePoints` / `sortInstances` 的做法一致）。

## P2-T013-02 — canonical 字节形式与哈希约定在三实现间分裂

- 位置：`src/canonical/index.ts`（TS）、`oracle/python/canonical.py`（Python）、`scripts/s0-canonical.mjs`（gate）。
- 证据（本轮实测）：
  1. 同一值 `{a:"x\u2028y", b:"line\u2028sep", c:"emoji😀"}`：TS `canonicalizeJson` 与 Python `canonical_json` 产出**逐字节相同**的 canonical 字符串（U+2028 均为原始 `e2 80 a8`；emoji 相同）。但 sha 助手约定不同：TS `canonicalSha256` 对**无尾 LF**字节哈希；Python `sha256_hex` 与 `scripts/s0-canonical.mjs::sha256Hex` 对**带一个尾 LF**的字节哈希。冻结向量的 `expectedSha256` 是无 LF 哈希（与 TS 及 `py-canonical-check.py` 一致）；`oracle/tests/test_canonical.py` 的 `test_sha256_matches_independent_hashlib_computation` 把 Python 助手钉在 `b'{"a":1}\n'` 上。
  2. astral 键 `{U+10000, U+E000}`：Python 与 TS 均以 U+E000 在前（码点序）；`s0-canonical.mjs:287` 的 `normalise` 用 `Object.keys(value).sort()`（默认 UTF-16 码元序），以 U+10000 在前——与两者皆不同，违背其文件头“must match oracle/python/canonical.py exactly”。
  3. `-0.0`：Python `canonical_json(-0.0)` 得 `"-0.0"`；TS `canonicalizeJson(-0)` 得 `"0"`。`py-canonical-check.py` 的 `canon` 对 0 返回 `"0"`（与 TS 一致）；`oracle/python/canonical.py` 无 -0 测试。
  4. 孤 surrogate 输入（`\ud800`）：Python `canonical_bytes` 抛 `UnicodeEncodeError`；TS `JSON.stringify` 可处理。仅病态输入。
- 影响：无实时影响——gate 用 `canonicalEquals` 比较经**同一** s0-canonical 规范化后的两侧值（Oracle 输出先解析为 JS 值再规范化）；报告哈希只用 TS 函数；冻结向量钉住无 LF 约定。分歧只在未来有人直接拿 TS 报告哈希与 Python 哈希、或拿 s0-canonical 的 canonical 字符串与 Python/TS 的对应物比较时才会显现。
- 建议：统一字节形式（或在三处文档中明确两种哈希函数的输入不同、不可互比）；`s0-canonical.mjs` 的键排序改用码点比较；给 Oracle 补 -0 向量。

## P2-T013-03 — OpenMausBot 适配器把含绝对路径的 finding detail 透传到 AuditResult

- 位置：`src/adapters/openmausbot/openmausbot-poc.ts`（detail 含 `${configPath}`、`${optOutPath}`、`${skill.path}`、`${skill.originalPath}`）；`src/adapters/openmausbot/adapter.ts`（原样透传）。
- 证据（本轮实测，合成探针 `/tmp/t013-omb-*`）：无效 `config.json` + 两个缺失 snapshot skill（同为 repo）→ 适配器返回的 AuditResult 中 **3 条 finding 含绝对路径**：`FAIL_OPEN_CONFIG`（`config.json at /tmp/t013-omb-EaIlmN/data/config.json is invalid-json…`）与 2× `SOURCE_NOT_ENUMERATED`（`points at missing or unreadable directory /tmp/t013-omb-EaIlmN/missing-a|b`）。`adapter.ts` 文件头注释称“Finding details never contain absolute paths（§4.2 rule 5）”——与实测矛盾。Claude 适配器有 `sanitizeDetail`（fixtureDir → `<FIXTURE_DIR>`），OMB 适配器没有。
- 影响：导出物无泄露——CLI `runAudit` 在写盘前对整个 report 做 `redactReport`；本轮核查 demo HTML 中 `/home/hatch` 出现 0 次。但内存中的 AuditResult 违反适配器自身的文档约定；控制台摘要会打印原始 detail；任何不经 CLI redaction 而直接写 AuditResult 的消费者都会泄露路径。
- 建议：在 OMB 适配器中加与 Claude 适配器相同的 sanitize（或在 kernel 入口统一 scrub）。

## P2-T013-04 — OpenMausBot PoC 的 `unknownScopes` 可含重复条目

- 位置：`src/adapters/openmausbot/openmausbot-poc.ts`（每个缺失 snapshot skill `unknownScopes.push(scope)`）；`src/resolver/index.ts`（kernel 只排序、不去重）。
- 证据（本轮实测，同 P2-T013-03 探针）：两个缺失的 repo skill → PoC `unknownScopes ["CONFIG","REPO","REPO"]`。
- 影响：S0 夹具不触发（golden 无重复）；完整适配器经 `sortedUnique` 去重后才调 kernel；gate 的 `incompleteSourceCount` 在触发时会多计（`+= unknownScopes.length`）。审计状态不受影响（已是 INCOMPLETE）。
- 建议：在 PoC 或 kernel 中对 `unknownScopes` 去重（与完整适配器一致）。

## P2-T013-05 — `ProfileV1` TS 接口与冻结 JSON schema 漂移

- 位置：`src/contracts/index.ts`（`ProfileV1.policy` 只列 `allowed_scopes` + `forbidden_names`）；`schemas/skillscope-profile-v1.json`（另有 `forbidden_scopes`，注明为“T006 扩展”）。
- 证据：代码与 schema 对照；`src/cli/audit.ts` 的 `mapProfilePolicy` 处理三者。
- 影响：仅接口漂移，无运行时影响。
- 建议：把 `forbidden_scopes` 补进 `ProfileV1.policy` 接口（或在 schema 注释中说明接口滞后）。

## P2-T013-06 — Codex PoC 与 IdentityRegistry 的归并键不同

- 位置：`src/adapters/codex/codex-poc.ts::addSkillDir`（按实路径跨**所有**源根归并；第二个根的 scope 丢失，alias 记在首次见到的实例上）vs `src/identity/identity.ts`（按 `(sourceRootId, canonicalPath)` 键控；同一物理文件在两个根下是两个实例）。
- 证据：代码对照；`grep` 确认 `IdentityRegistry`/`discoverSkillRoot` 在生产路径中只被 `scripts/identity-evidence.mjs` 使用，CLI 用 PoC 适配器。
- 影响：两者在生产路径中永不相遇；S0 夹具一致。若将来把 registry 接入审计路径，实例数会变化。
- 建议：在 `codex-poc.ts` 或 DECISION_LOG 中记录该分歧为已知分层约定；若 registry 未来接入审计，需先统一归并键并重跑 S0。

## P2-T013-07 — PoC 最小 frontmatter 解析器无保留词规则

- 位置：`src/adapters/shared/skill-scan.ts::parseFrontmatter`（不拒绝含 `anthropic`/`claude` 的名）；`src/manifest/manifest.ts`（完整解析器拒绝）。
- 证据：代码对照。
- 影响：完整审计路径上 Claude 适配器（§6d）与 OMB 适配器的 manifest 重检会补上；S0 gate（仅 PoC）不会标记保留词名。分层分歧，与 ADR-006 同类。
- 建议：在 `skill-scan.ts` 中补保留词检查，或在 DECISION_LOG 中记录 S0 层不覆盖该规则。

## P2-T013-08 — `package.json` 声明的 `release:build` / `release:verify` 目标文件不存在

- 位置：`package.json`（`"release:build": "node ./scripts/release-build.mjs"`、`"release:verify": "node ./scripts/release-verify.mjs"`）；`scripts/` 中只有 `release-rehearsal.mjs`。
- 证据：`ls scripts/release*` 仅得 `release-rehearsal.mjs`；计划 §3.3 冻结脚本表与 T014 验收命令均引用这两个脚本。
- 影响：现时调用会 ENOENT。T014 的验收命令依赖它们；T014 拥有其创建（计划 T014 卡的交付物含打包脚本）。
- 建议：T014 创建这两个脚本（不得为占位）；T013 不开 FIX。

## P2-T013-09 — 死代码：`skipped` 数组与 `dedupeRootIds` 碰撞分支

- 位置：`src/adapters/claude/marketplace.ts::resolveMarketplaces`（`skipped` 数组传进 `enumerateMarketplacePlugins` 但从不 push，`skippedPlugins` 恒为空）；`src/adapters/claude/adapter.ts::dedupeRootIds`（派生根 id 与调用方提供的 id 碰撞时原样 push，后在步骤 4 被静默跳过，其路径永不扫描；id 按构造唯一 `plugin-<market>-<plugin>`，应为死代码）。
- 证据：代码阅读。
- 影响：无；纯 cosmetic。
- 建议：删除 `skipped` 透传，或真正填充它；给 `dedupeRootIds` 的碰撞分支加显式处理或断言。

## P2-T013-10 — `build-lock.mjs` 的 stale-steal TOCTOU 与无条件释放

- 位置：`scripts/build-lock.mjs`（`releaseBuildLock` 无条件 `rmSync` 锁目录；`lockHolderAlive` 检查-删除之间有竞态窗口）。
- 证据：代码阅读。
- 影响：仅测试基建（globalSetup + s0-gate）；120 s 超时 vs 约 4 s 构建，实际触发概率极低；即使触发也只影响测试进程，不影响产品。
- 建议：释放时校验 holder pid 仍是自己；或给锁目录加唯一 token 再比对删除。

## 未列为 finding 的备注（已核查，无行动项）

- s0-gate 的网络扫描是启发式（`node:http/https/net` 导入 + `fetch(`）；离线性的强证据是 `offline-check.mjs` 的死代理实测。
- `offline-check.mjs` 把自身文件排除在静态扫描之外（注释说明：其模式列表本身含禁用词）；诚实排除，非掩盖。
- `writeJsonFile` 的临时文件名用 pid + Date.now()；不在哈希内容中。
- Codex PoC 的 `canonicalPath` 在逃出布局根时回退为绝对实路径；kernel 不把它带入 `NormalizedInstance`。
- `00_control/ENVIRONMENT_REPORT.md` 有一处历史 mojibake（`probe.mjs���只读`）；历史证据文件，不改。
- `docs/images/scope-matrix.png` 为二进制图片，未做代码级审查。
