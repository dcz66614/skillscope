# P023 SkillScope — FIX-R2 Report (final review R2 rework)

- **Task:** FIX-R2 (final review R2, `FINAL_VERDICT: FAIL`, P0 0 / P1 2 / P2 12, GPT-6 + Extra High, 2026-11-13 ~19:49 GMT)
- **Base commit:** `9b06a96` (T014 round-2 freeze; tree clean at start)
- **Output commit:** `7cd1edb` (amended twice before the record commit to fold in two harness fixes found by the extracted-tree run itself: the verify-extracted-tree work dir 0700 → 755, and `checkoutS0` no-op without `.git` — see P1-R2-01)
- **Verdict:** `~/workspace/p023-R2-verdict.md`; Muse's first-hand verification: `~/workspace/p023-gpt-R2-verification-2026-11-13.md`
- **Scope:** the two new R2 P1s only. The other 12 P2s stay registered; P2-R1-13 remains FALSE, not a fix item. R1's 8 fixes, P1-T013R-01 and P2-T013R-02 all still hold (re-run below).
- **Constraints honoured:** zero humans; synthetic dirs/configs only; no network/model calls; no credentials in files, logs or replies. No empty scripts, fixed exit 0, or print-only-PASS stubs. Nothing was closed by adding logs, changing severity, or editing expected results.

## P1-R2-01 — source.zip missing empty dirs regression fixtures need

### Root cause

`git archive` does not package empty directories, and the file-SHA manifest (`RELEASE_FILE_LIST.csv`) only hashes files, so it cannot see a lost directory. T012 added 23 `.gitkeep` files for the S0 fixtures only; the R1/R2 regression fixtures were missed. Missing vs empty is not cosmetic: `scanSkillsDir` returns `missing` for an absent skills dir (USER/ADMIN → unknown → INCOMPLETE) but `ok` for an existing empty one — so a dropped empty dir changes audit outcomes.

### Full audit (not just GPT's 7 named dirs)

Every empty directory in the whole tree was audited (working-tree walk + `find -type d -empty`, cross-checked against the freeze gate `emptyDirsMissingGitkeep`). **25 empty dirs total, all now carry an empty `.gitkeep`:**

| Group | Count | Directories |
|---|---|---|
| r1 fixtures | 15 | `cli-codex-home-config`: `admin/`, `admin/skills/`, `home/.agents/`, `home/.agents/skills/`; `cli-codex-profile-config`: same 4; `cli-omb-env-data-dir`: `assigned/`, `home/`; `r1-01-codex-repo-readable`: `admin/`, `home/`; `r1-01-codex-repo-unreadable`: `admin/`, `home/`; `r1-02-claude-container-dir`: `home/.claude/skills/synced/`; `r1-02-claude-skill-md-unreadable`: `home/`; `r1-02b-omb-optout-missing`: `data/skill-state/`; `r1-03-claude-synced-absent`: `home/`; `r1-03b-claude-personal-absent`: `home/` |
| r2 fixtures | 7 | `r2-01-codex-symlink-escape`: `etc-codex/`, `home/`; `r2-01b-codex-symlink-launder`: `etc-codex/`; `r2-01c-codex-launder-control`: `etc-codex/`, `repo/`; `r2-01d-codex-symlink-alias-in-root`: `etc-codex/`, `home/` |
| Top-level placeholders | 3 | `02_source/`, `04_review/`, `05_release/` |

GPT's 7 named dirs are a subset of the 22 regression dirs above (r2-01c `repo/`, `etc-codex/skills/`; r2-01d `home/.agents/skills/`, `etc-codex/skills/`; r1 `cli-codex-home-config` `home/.agents/skills/`, `admin/skills/`; `cli-omb-env-data-dir/assigned/`). S0, T007, T008 and demo fixture trees were audited too: no other genuinely empty directory exists (an early gate draft flagged ~60 dirs, all false positives — its skip list excluded any directory *named* `release` at any depth, and fixture skill dirs are named `release`, e.g. `project/release/`; the skip now applies at the repo root only, and the corrected gate returns `[]`).

### Freeze-script gates (so it cannot recur)

- **`scripts/release-build.mjs` — new pre-archive gate** `emptyDirsMissingGitkeep()` (exported for testing): fails the build before `git archive` if any leaf-empty directory in the frozen tree lacks `.gitkeep`. Build outputs (`.git`, `node_modules`, `dist`, `release`) are skipped at the top level only.
- **`scripts/release-verify.mjs` — new directory-set check:** compares the directory set implied by the frozen commit (every ancestor of every shipped file) against the directory entries actually present in `source.zip` (`git archive --format=zip` emits 1,126 directory entries in the R2 zip, verified). File SHAs all matching but a directory missing now FAILs. Backward-compatible: against the R2 artifacts it passes (`source.zip directory set matches frozen commit (empty dirs included)`), because the R2 commit and the R2 zip lack the new dirs together.
- **New script `scripts/verify-extracted-tree.mjs`** (`npm run verify:extracted-tree [source.zip]`, default `release/source.zip`): extracts source.zip to a clean temp dir, compares the extracted directory set against the working tree's (empty dirs included; `.git`/`node_modules`/`dist`/`release` top-level and `__pycache__` anywhere excluded), symlinks the repo's `node_modules` (the only deviation from a cold checkout — no network), builds in place, then runs the r1+r2 regression suites and the full `npm test` in the extracted tree. Exit 0 only when every step passes.

### Reproduction — before (R2 source.zip, sha `30b6a581…`)

`npm run verify:extracted-tree` against the R2 `release/source.zip` (before this fix):

- `[FAIL] extracted directory set matches working tree (1205 dirs)` — missing: `02_source`, `04_review`, `05_release`, the r1/r2 fixture dirs above.
- `[FAIL] extracted-tree r1 + r2 regression suites` — exit 1, **13 failed / 14 passed (27)**, matching Muse's R2 verification (r2-fix.test.ts 4 failed / 1 passed).
- `[FAIL] extracted-tree full npm test` — exit 1, **14 failed / 549 passed (563)**.
- `npm run build` in the extracted tree still passed (exit 0) — the loss is silent at build time, which is why the gate is needed.

### Reproduction — after (source.zip built from the FIX-R2 output commit `7cd1edb`)

`git archive --format=zip --prefix=skillscope/ 7cd1edb` → `/tmp/fix-r2-source.zip`, 5,385,485 B, sha256 `6e5ad4cc7a5af0b3bdc9280c1bd0eace99d003c039ca75fb36f0ba43b73cf494`. `npm run verify:extracted-tree /tmp/fix-r2-source.zip`:

- `[PASS] extract source.zip`
- `[PASS] extracted directory set matches working tree (1204 dirs)` — missing: (none); extra: (none)
- `[PASS] extracted-tree npm run build`
- `[PASS] extracted-tree r1 + r2 regression suites` — exit 0, **2 files, 27/27**
- `[PASS] extracted-tree full npm test` — exit 0, **32 files, 567/567**
- `verify-extracted-tree PASS — 0 failure(s)`

Two harness defects surfaced while getting this run green, both fixed inside the FIX-R2 output commit (not by weakening any assertion):

1. **Work-dir permissions:** `verify-extracted-tree.mjs` created its temp dir with `mkdtemp` (0700). The r1/r2 suites stage their `nobody` permission repros into the repo root's parent — i.e. that work dir — so `nobody` could not traverse it and all 7 permission cases failed with `MODULE_NOT_FOUND` for the staged driver (the same staging artifact Muse noted in the R2 verification). Fix: `fs.chmodSync(work, 0o755)` after `mkdtemp`, same pattern the suites use for their own staging dirs.
2. **Git-dependent test helper:** `tests/helpers/test-infra.ts` `checkoutS0` restored `03_evidence/S0/` with `git checkout`, which fails in an extracted tree (`fatal: not a git repository`). Fix: no-op when `repoRoot/.git` is absent — the gate still runs and must pass; only the restore is skipped, and the extracted tree is disposable. In-repo behaviour is unchanged (git restore still runs; working-tree suite still 567/567).

Pre-fix comparison (same script, R2 source.zip): 13 r1+r2 failures / 14 full-suite failures → post-fix: 0 / 0.

## P1-R2-02 — Codex cross-source realpath merge drops USER scope, forbidden USER still PASS

### Root cause

`resolveCodexSkills()` in `src/adapters/codex/codex-poc.ts` deduplicated by a single global `byRealPath` map: the second scan of the same physical file only appended an alias and returned, discarding the second `sourceScope`. With `repo_root == home_root == "."`, REPO and USER both scan `./.agents/skills`; the shared skill appeared only as REPO, the forbidden USER policy never saw it, and the kernel PASSed with `findings: []`. The Oracle `reference_resolver.py` `add_skill_dir` mirrored the merge exactly. (Upgraded from P2-T013-06.)

### Fix — physical identity and source attribution separated

**TS (`src/adapters/codex/codex-poc.ts`, `resolveCodexSkills` → `addSkillDir`):**

- New `byRealPathAndScope` map keyed by `realSkillPath + "\0" + sourceScope`, consulted after the FIX-T013R escape guard and before the cross-scope branch: same physical file + same scope → merge as alias (c06 behaviour unchanged).
- If the file was already seen under a *different* scope, fall through and create a **second instance** for this scope (own `sourceRootId` / `sourceScope` / `relativePath` / `instanceId`; same `contentSha256` / `canonicalPathHash`). `byRealPath` now keeps only the first instance as the same-scope merge anchor (`byRealPath.set` only when `existing === undefined`). No scope's policy outcome is decided by whichever scan ran first.
- No new finding id: the violation is covered by the kernel's `SCOPE_LEAK`. Config selectors match by `realPath`, so both instances are affected together (correct); a name selector hitting both instances reports `NAME_SELECTOR_BLAST_RADIUS` with `affectedCount: 2` (pre-existing intended behaviour, c10/c14).

**Oracle (`oracle/python/reference_resolver.py`, `add_skill_dir`):** same logic derived independently — `by_real_path_and_scope` dict keyed `(real_skill_path, source_scope)`, same scoped-lookup-then-cross-scope-instance flow, same comments. TS/Oracle parity is pinned by mirrored tests.

**Checked, no fix needed:**

- **Claude adapter:** `claude-poc.ts` contains no `realpath`/`byReal` dedup at all; it calls the shared `scanSkillRoot` once per source root, and `scanSkillRoot` (`src/adapters/shared/skill-scan.ts`) builds a fresh `byCanonical` map per call — the merge is scoped to one root, so a file reachable from two Claude roots is already two instances.
- **IdentityRegistry (`src/identity/identity.ts`):** the identity key is `(sourceRootId, canonicalPath)` — two scopes are two registry keys by construction; the "first-registered access path wins" rule applies only within one key (same root + same canonical path), i.e. the correct same-scope alias case.
- **S0 canonicaliser (`scripts/s0-canonical.mjs`):** canonical identity is `(sourceRootId, canonicalPath)` — the two instances stay distinct in the gate. S0 has no cross-scope same-physical-file fixture, so the gate SHA is unaffected (verified below).

### Regression samples

- **Fixtures** `tests/fixtures/regression/r3/`: `r3-01-codex-cross-scope-merge` (home_root == repo_root == `shared/`, one `shared/SKILL.md`, empty `etc-codex/skills/` with `.gitkeep`, `bundled.json`/`plugins.json`, plus `config.toml` disabling name `shared` for the selector test); `r3-01b-codex-cross-scope-disjoint` (separate REPO/USER skills, control); `r3-01d-codex-overlapping-roots` (home_root nested inside repo_root, USER skills dir IS the physical dir the REPO walk finds first). No symlinked home dir — that would trip the FIX-T013R escape guard instead.
- **TS** `tests/regression/r3-fix.test.ts` (4 tests): home==repo → 2 instances (REPO + USER), same content SHA / canonical path, distinct instanceIds, empty aliases; no-policy kernel PASS with 2 instances; forbidden-USER kernel FAIL with exactly 1 `SCOPE_LEAK` (USER, `expectedCount` 1 / `effectiveCount` 2); overlapping roots → same; disjoint control → 2 distinct names, forbidden USER fails with 1 `SCOPE_LEAK` on `user-skill`; name selector `shared` disables BOTH instances, blast `affectedCount` 2, PoC FAIL.
- **Oracle** `oracle/tests/test_reference_resolver.py`, new `TestFixR2Oracle` (4 tests): same-dir, overlapping-roots, disjoint control, name-selector-hits-both — mirrored assertions (2 instances, scopes `{REPO, USER}`, same SHA, `affectedCount` 2, FAIL on the selector case).

### Reproduction — before (frozen R2 dist, sha `bdab37a5…`, Muse's record)

```
✓ repo/.agents/skills/shared/SKILL.md (aliases: .agents/skills/shared/SKILL.md)
coverage: 5/5 sources enumerated
RESULT: PASS
```
`report.json`: `status: PASS`, `findings: []`, expected 1 / observed 1. One physical skill shown only as REPO.

### Reproduction — after (FIX build, first-hand CLI run, Node 24.22.1)

Staging `~/workspace/r2-verify/fix/` (profile `skillscope.profile/v1`, `repo_root == home_root == "."`, REPO + USER both `./.agents/skills`, `forbidden_scopes: ["USER"]`, ADMIN/SYSTEM/PLUGIN normal), CLI `dist/cli/index.js audit --profile profile.json`:

```
CODEX / profile: r2-02-fix-check
  config: none (source: absent)
  ✓ repo/.agents/skills/shared/SKILL.md
  ✓ user/.agents/skills/shared/SKILL.md
  ! SCOPE_LEAK [P1] (USER): scope USER is forbidden by policy but skill 'shared' (user:.agents/skills/shared/SKILL.md) is ELIGIBLE
  coverage: 5/5 sources enumerated
RESULT: FAIL
```
CLI exit 1; `report.json`: `status: FAIL`, `findings: [{id: SCOPE_LEAK, severity: P1, source_scope: USER, status: CONFIRMED}]`.

No-policy control (same staging, `forbidden_scopes: []`): both instances listed, `RESULT: PASS`, exit 0, `findings: []`.

## Re-runs (working tree, real exit codes)

| Command | Result |
|---|---|
| `npm run typecheck` | exit 0 |
| `npm test` | exit 0 — **32 files, 567/567** (was 563; +4 r3) |
| `npm run test:oracle` | exit 0 — **62/62** (was 58; +4 TestFixR2Oracle) |
| `npm run s0:gate` | exit 0 — PASS, `gate_sha256: a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca` **UNCHANGED** (100 runs, 1 hash) |
| `npm run test:e2e` | exit 0 — **28/28** |
| `npm run test:offline` | exit 0 — PASS |
| `npm run test:performance` | exit 0 — 500/500 instances, hash stable, HTML median 344 ms, peak RSS 82.3 MiB |
| `npm run verify:all` | exit 0 — **8/8** steps |
| `npx vitest run tests/regression/r1-fix.test.ts tests/regression/r2-fix.test.ts tests/regression/r3-fix.test.ts` | exit 0 — **3 files, 31/31** (r1 22 + r2 5 + r3 4; r1 includes 6 nobody permission cases, r2 includes 1 nobody case) |
| `npm run release:verify` (against R2 artifacts, pre-commit tree) | Gate B `[PASS] source.zip directory set matches frozen commit (empty dirs included)`; the only FAILs are the two expected dirty-tree checks (working tree holds uncommitted FIX-R2 changes) |
| `node -e … emptyDirsMissingGitkeep()` | `[]` — no empty dir without `.gitkeep` remains |
| `npm run verify:extracted-tree` (R2 source.zip, pre-fix) | FAIL, 3 failures (see P1-R2-01 before-section) |
| `npm run verify:extracted-tree` (FIX-R2 source.zip `6e5ad4cc…`, 5,385,485 B, from output commit `7cd1edb`) | **PASS — 0 failures**: dir set 1204/1204, build exit 0, r1+r2 27/27, full npm test 567/567 |

Evidence-write hygiene: `s0:gate` / `verify:all` rewrote `03_evidence/S0/` (3 files) and `03_evidence/T012/` (5 files) with only base-commit labels / timestamps changed; both were restored with `git checkout --` after the runs, so the committed tree contains only FIX-R2 work.

## Deliverables

- `src/adapters/codex/codex-poc.ts` — `byRealPathAndScope` scoped merge (P1-R2-02, TS)
- `oracle/python/reference_resolver.py` — `by_real_path_and_scope` (P1-R2-02, Oracle, independently derived)
- `oracle/tests/test_reference_resolver.py` — `TestFixR2Oracle` (4 tests)
- `tests/regression/r3-fix.test.ts` + `tests/fixtures/regression/r3/` (r3-01 / r3-01b / r3-01d) — 4 tests
- 25 empty `.gitkeep` files (22 regression fixture dirs + `02_source/` + `04_review/` + `05_release/`)
- `scripts/release-build.mjs` — `emptyDirsMissingGitkeep()` pre-archive gate + header doc
- `scripts/release-verify.mjs` — source.zip directory-set comparison
- `scripts/verify-extracted-tree.mjs` + `package.json` (`verify:extracted-tree`) — extracted-tree reproduction (work dir chmod 755 so the suites' `nobody` staging can traverse it)
- `tests/helpers/test-infra.ts` — `checkoutS0` no-ops when the tree has no `.git` (extracted trees cannot `git checkout` to restore S0 evidence; gate assertions unchanged)
- `01_spec/PROJECT_BOOK.md` — §4.2 rule 3 refined, §4.3 cross-scope paragraph (FIX-R2)
- `00_control/DECISION_LOG.md` — ADR-027 (cross-scope merge), ADR-028 (empty-dir freeze gate)
- This report: `03_evidence/FIX-R2/FIX_R2_REPORT.md`

## Known limits

- The post-fix `verify:extracted-tree` run was done against a `git archive` of the output commit (sha `6e5ad4cc…`, all green). The authoritative reproduction is repeated at the new T014 freeze, which archives the frozen commit through `release:build` (with the new pre-archive gate) and verifies through `release:verify` (with the new directory-set check).
- `verify-extracted-tree` compares the extracted tree against the *working* tree, so it must run on a committed tree (uncommitted fixture additions would report as missing dirs — by design).
- The 12 remaining P2s are untouched (registered, non-blocking); P2-R1-13 stays FALSE.
- The new T014 freeze + R3 (round 3/5) follow after Muse's personal verification and the independent T013 re-review.
