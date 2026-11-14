# Codex Adapter PoC — Rule Sources & Design Notes (P023 T002)

## Rule sources

All rules implemented in `codex-poc.ts` come from PROJECT_BOOK.md §4.3,
which cites the official Codex / ChatGPT Skills documentation
(https://learn.chatgpt.com/docs/build-skills) and OpenMausBot issue #5449
(https://github.com/milind-soni/OpenMausBot/issues/5449) as the real-world
failure modes. No rule was inferred from another host's behaviour.

| Rule | Source | Where in code |
|---|---|---|
| Project sources: `<dir>/.agents/skills` from cwd up to repo root, never above | PROJECT_BOOK §4.3; Codex docs | `resolveCodexSkills` step 1 |
| User source `$HOME/.agents/skills` | PROJECT_BOOK §4.3; Codex docs | step 2 |
| Admin source `/etc/codex/skills` | PROJECT_BOOK §4.3; Codex docs | step 3 |
| System source: bundled skills | PROJECT_BOOK §4.3; Codex docs | step 4 |
| Symlink directories are followed; same physical file merges to one instance, aliases kept | PROJECT_BOOK §4.2, §4.3 | `addSkillDir` (realpath dedup) |
| `skills.config` entries select by `path` (exactly one instance) or `name` (all same-name instances) | PROJECT_BOOK §4.3; Codex docs | step 6 |
| Later entries override earlier ones ("last match wins") | PROJECT_BOOK §4.3; Codex docs | step 6, in file order |
| `[skills.bundled].enabled = false` disables bundled system skills | PROJECT_BOOK §4.3; Codex docs | step 6 |
| Name selector hitting >1 instance → NAME_SELECTOR_BLAST_RADIUS (P1) | PROJECT_BOOK §4.3, §5.2 | step 6 (`blastSeen` dedup by name) |
| Unreadable / invalid config → fail closed: skills UNKNOWN, audit INCOMPLETE, FAIL_OPEN_CONFIG | PROJECT_BOOK §4.3, §5.2; §0 rule 8 | step 6 (`configReadable === false`) |
| Unenumerated source → SOURCE_NOT_ENUMERATED, never silently dropped | PROJECT_BOOK §4.3, §5.2; §0 rule 8 | `noteUnknown` |

## Inputs are synthetic stand-ins, not real host state

- `bundled.json` stands in for the host's bundled-skill inventory;
  `plugins.json` stands in for the account plugin-sync inventory. Absent
  inventory file = that source is UNKNOWN, never "zero skills".
- Plugin skills have no local SKILL.md; their `contentSha256` is
  `sha256("plugin:<pluginId>:<skillName>")`, documented in code.
- The PoC reads only files under the fixture layout roots given in the
  input. It never writes, never touches a real Codex HOME, never executes
  skill content, and never contacts the network.

## Documented simplifications (PoC scope, not defects)

1. **Frontmatter**: a minimal strict reader extracts only the top-level
   `name:` scalar from a leading `---` block; a missing name falls back
   to the folder name. Full manifest parsing with INVALID status belongs
   to T005. No YAML dependency was added for the PoC.
2. **Unmatched selectors**: a `path` selector matching zero instances is
   ignored (no finding yet); T006 may add a finding for it.
3. **Name-selector ordering** is covered by a unit test (later entry wins)
   plus fixture c05 for path selectors; a name-selector ordering fixture
   would need same-name instances and therefore a blast finding, so it
   lives in unit tests, not in the 8 golden fixtures.
4. **Symlink loops / escaping targets**: `realpathSync` errors propagate
   (fail loudly) instead of being silently skipped. Bounded handling
   belongs to T005.
5. **Plugin skills** are enumerated as ELIGIBLE; the PoC models no
   disable path for them (per #5449, `turn/start` has no
   `disabledPluginIds`). The disable path belongs to T007.

## TOML parser (OPEN-001, closed by T002)

- Choice: `smol-toml` **1.9.1**, exact version pinned in `package.json`
  and `package-lock.json` (integrity
  `sha512-j7WyPdf0CJoutMzMoPLF/bVXHtKZIT9Rb4eGeEbWw8X2t5oirjPgpL+OpaENZrILYaXqYwnVH+qgUwVbl+pUJQ==`).
- Licence: BSD-3-Clause. Zero dependencies (verified in the lockfile:
  `node_modules/smol-toml` has no `dependencies` field).
- Rationale: actively maintained, tiny, no transitive dependencies;
  alternatives considered were `@ltd/j-toml` (larger) and a hand-rolled
  subset parser (rejected: subtle TOML incompatibilities would hide
  config errors the PoC must surface). Node 24.22.1 has no TOML parser
  in the standard library (confirmed by T001, OPEN-001).

## Fixtures

`tests/fixtures/s0/codex/c01…c08`, each with `layout/` (synthetic
filesystem), `input.json` (PoC input, layout-relative paths), and
`expected.json` (frozen expected result). See
`03_evidence/T002/T002_REPORT.md` for the per-case rule mapping and the
field-by-field golden review.

| Case | Kind | What it proves |
|---|---|---|
| c01-repo-discovery | control | Walk cwd → repo root inclusive; never above (outside/ secret not found) |
| c02-user-admin-system | control | USER / ADMIN / SYSTEM scopes classified correctly |
| c03-path-selector | control | `path` selector disables exactly one instance |
| c04-name-selector-blast | planted | `name` selector disables both same-name instances + blast finding |
| c05-last-match-wins | control | Later entry overrides earlier entry (path selectors) |
| c06-symlink-alias | control | Symlink alias merges to one instance, alias recorded |
| c07-bundled-disabled | control | `[skills.bundled].enabled = false` disables system skills |
| c08-unreadable-config | planted | Invalid TOML → fail closed (UNKNOWN, INCOMPLETE, FAIL_OPEN_CONFIG) + missing inventories UNKNOWN |

## How to run

```bash
npm run test:codex -- --run   # 8 golden fixtures + 3 unit tests (11 tests)
npm run test:oracle            # Oracle suite must keep passing (11 tests)
npm test                       # full suite (contracts + codex + claude + openmausbot)
npm run typecheck
npm run build
```
