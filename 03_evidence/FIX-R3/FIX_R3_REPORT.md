# P023 SkillScope — FIX-R3 Report (final review R3 rework)

- **Task:** FIX-R3-LICENSE (final review R3, `FINAL_VERDICT: FAIL`, P0 0 / P1 1 / P2 13, GPT-6 + Extra High, returned ~21:12 GMT 2026-11-13)
- **Base commit:** `59ff9d5` frozen / `5afd74e` release commit (T014 round-3 freeze; tree clean at start)
- **Output commit:** `b89f786` (fix code; this report + TASK_BOARD row + regenerated artifacts in the record commit)
- **Verdict:** `~/workspace/p023-R3-verdict.md`; Muse's first-hand verification: `~/workspace/p023-gpt-R3-verification-2026-11-13.md`
- **Scope:** the one new R3 P1 (P1-R3-01) + the one new R3 P2 (P2-R3-01) only. The other 12 P2s stay registered; P2-R1-13 remains FALSE, not a fix item. R2's two P1s, R1's eight fixes, P1-T013R-01 and P2-T013R-02 all still hold (re-run below; the Oracle 62/62 and the S0 gate cover them).
- **Constraints honoured:** zero humans; no network/model calls; no credentials in files, logs or replies. No empty scripts, fixed exit 0, or print-only-PASS stubs. Nothing was closed by adding logs, changing severity, or editing expected results.

## P1-R3-01 — dist.zip ships no MIT LICENSE, README still claims the license is pending

### Root cause

The MIT decision (Sam, 2026-11-13 ~18:02 GMT, all projects MIT) was applied to the repo root (`LICENSE`, sha `50b8b302…`, FIX-R1) and to the freeze gates for **source.zip** (ADR-026: the frozen tree must carry LICENSE with the canonical hash), but the **dist** packaging path never included it. `collectDistEntries()` in `scripts/release-build.mjs` packed `package.json`, `package-lock.json`, `README.md`, `dist/`, `schemas/` and the OpenMausBot snapshot JSON — no `LICENSE` entry — and neither `release-build` nor `release-verify` checked for one. The README License section and `package.json` still carried the pre-decision state ("Pending Sam's decision — no LICENSE file is included yet, and no license is claimed in `package.json`"; no `"license"` field), so the standalone dist.zip contradicted the manifest's `license: "MIT"` in three places at once.

Note: ADR-026 (in `00_control/DECISION_LOG.md`) states "第二轮冻结的 source.zip / dist.zip 均含 LICENSE". That was wrong for dist.zip — the R2/R3 dist.zips never contained a LICENSE entry (R3 verdict + Muse's first-hand check both confirm). The error is in the decision log's claim, not in the freeze; this report records the correction and does not rewrite the log.

### Fix

- **`scripts/release-build.mjs` — `collectDistEntries()` now includes `LICENSE` at the dist root** (exported, so the regression suite can pin it) and walks `docs/` (see P2-R3-01 below). New gates after the dist zip is written (all must pass for `release:build` exit 0):
  - dist.zip contains a `LICENSE` entry whose SHA-256 equals `EXPECTED_LICENSE_SHA256` (`50b8b302ffcb53aec1866ad4b94721c200400e6aac8cee12db03b85f24e39ed2`);
  - dist `package.json` claims `"license": "MIT"`;
  - dist README License section matches `^## License\n\nMIT` and contains no "Pending Sam" claim;
  - dist.zip contains `docs/quickstart.md`, `docs/host-rules.md`, `docs/images/scope-matrix.png`.
  - Header comment (§4) and the manifest's `generation.dist_zip` text updated to describe the new entries.
- **`scripts/release-verify.mjs`** re-checks all four on the shipped dist.zip (LICENSE presence + SHA-256, package.json license, README License section, docs/ presence), and the "no unexpected entries" allowlist now admits `LICENSE` and `docs/`. The stale header line claiming source.zip must have "no … LICENSE entry" is corrected (LICENSE is expected in source.zip — it is part of the frozen tree, ADR-026).
- **`README.md`** — License section is now `MIT — see [LICENSE](LICENSE) (Copyright (c) 2026 dcz66614).` The "no LICENSE file" sentence is deleted. The source README and the dist README are the same file, so they cannot drift again.
- **`package.json`** — added `"license": "MIT"`.
- **`scripts/verify-all.mjs`** — the recorded `product_license` was still the pre-decision `PENDING_SAM_DECISION (no LICENSE file; must not be invented)` label; it now reads `MIT (LICENSE, sha256 50b8b302…)`, and the header comment is corrected the same way.
- **New regression suite `tests/regression/r4-license.test.ts` (6 tests)** pins: repo-root LICENSE is the canonical MIT text (1,065 B, sha `50b8b302…`, Copyright (c) 2026 dcz66614); `package.json` claims `"license": "MIT"`; the README License section states MIT with no "Pending Sam" / "no LICENSE file" / "no license is claimed" text; `collectDistEntries()` includes `LICENSE` with the canonical hash, a MIT `package.json` and a MIT README; and every `docs/` file the README links is a dist entry (both by explicit list and by scanning every relative `docs/` link in the README). New declaration file `scripts/release-build.d.mts` (repo `.d.mts` precedent: `build-lock.d.mts`, `perf-fixture.d.mts`) so the suite can import `release-build.mjs` without `noImplicitAny` errors. Two test bugs found by running the suite itself, fixed in the output commit (not by weakening assertions): the docs-link regex missed the `(` between `]` and the URL, and the imported entries needed explicit types.

### Reproduction — before (R3 frozen dist.zip, sha `4c941595…`, Muse's record)

GPT's exact checks, confirmed first-hand by Muse on the R3 frozen release: `unzip -Z1 dist.zip | grep -E '(^|/)LICENSE$'` → no output; dist README lines 114–116 read "Pending Sam's decision — no LICENSE file is included yet, and no license is claimed in `package.json`."; `grep '"license"' package.json` → no output; source.zip `skillscope/LICENSE` sha `50b8b302…` present.

### Reproduction — after (regenerated dist.zip, sha `f405795b…`, see §Regenerated release artifacts)

The same checks on the regenerated dist.zip, run first-hand in this task:

- `unzip -Z1 release/dist.zip | grep -E '(^|/)LICENSE$'` → `LICENSE` (exit 0);
- extracted `LICENSE` sha256 `50b8b302ffcb53aec1866ad4b94721c200400e6aac8cee12db03b85f24e39ed2`;
- extracted README lines 114–116: `## License` / blank / `MIT — see [LICENSE](LICENSE) (Copyright (c) 2026 dcz66614).`;
- extracted `package.json` line 11: `"license": "MIT"`;
- `unzip -Z1 release/dist.zip | grep '^docs/'` → `docs/host-rules.md`, `docs/images/scope-matrix.png`, `docs/quickstart.md`.

## P2-R3-01 — dist.zip README links docs/ files that dist.zip does not contain

### Fix

Chose bundling over rewriting the links to repository URLs: the README links `docs/quickstart.md`, `docs/host-rules.md` and `docs/images/scope-matrix.png`, and dist.zip now ships the whole `docs/` directory (3 files), so the links resolve offline — consistent with the project's local-first, no-network stance. The change is the `walk(ROOT/docs, "docs/")` line in `collectDistEntries()` plus the gate/verify checks listed under P1-R3-01. dist.zip grows 364,569 B → 513,226 B (+148,657 B, almost all of it `docs/images/scope-matrix.png`).

## Re-runs (working tree, real exit codes, Node v24.22.1)

| Check | Result |
|---|---|
| `npm run typecheck` | exit 0 (0 errors) |
| `npm test` (full vitest) | **573/573** (33 files; was 567/567, +6 new r4-license tests) |
| `npm run test:oracle` (Python Oracle) | **62/62**, `OK` |
| `npm run s0:gate` | PASS; 48 fixtures (24 control, 24 planted); parity 48/48; golden 48/48; detected 24/24; false alarms 0; 100 replays, 1 hash; **gate_sha256 `a11d2a4c…` UNCHANGED** |
| `npm run verify:all` | **8/8 PASS** (typecheck, test, oracle, e2e, offline, performance, s0:gate, license-inventory 42 packages); `product_license` now MIT; head `b89f786` |
| `npm run test:e2e` | **28/28 PASS** |
| `npm run test:offline` | PASS — no account, no LLM, no network, no real skills |
| `npm run test:performance` | PASS; scan median 411 ms (target ≤5000); HTML median 326 ms (target ≤2000); peak RSS 82.3 MiB (target ≤300); 500/500 instances, hash stable |
| `npm run verify:extracted-tree` (regenerated source.zip) | **PASS, 0 failures** — 1204 dirs; r1+r2 27/27; full `npm test` 573/573 (see below) |

The audit hash is unchanged by the fix: clean-room / repo / dist `audit_sha256` is `948f9414…` in the regenerated manifest — the same value as the R3 frozen manifest — because the fix touches packaging and metadata only, not the audit logic.

## Regenerated release artifacts

`release:build` pins the frozen commit from the existing manifest, so running it in the main tree would re-freeze the R3 commit (and a fresh freeze is T014's job, explicitly out of scope here). The regeneration was therefore proven in a scratch worktree at the fix commit, exactly as FIX-R2 proved its fix against a `git archive` of its output commit:

- Scratch worktree `/tmp/p023-fixr3-freeze` at `b89f786`, with `release/` dropped and a scratch commit, so `release:build` froze HEAD. (The scratch commits touch nothing but the `release/` deletion and the untracked `node_modules` symlink; no content changes.)
- **`npm run release:build` → exit 0, 39/39 PASS, 0 FAIL.** source.zip 2,886,320 B sha `850c5713778c188c350faf86e4ef2a5e58eb77eb1c426e6f5abebde1e57553c4` (848 files: R3's 846 + the 2 new files); dist.zip 513,226 B sha `f405795b4428d133ae6a211991938068fcf9256d3dfc47a067a4c828fbbd05a7` (41 entries); manifest sha `ad8195e990d64925ac868f26a4362eca042ac99d398343b77b4097f5e7ba00ad`; `sha256sum -c SHA256SUMS.txt` all OK. The new dist LICENSE gates all PASS (LICENSE sha, package.json MIT, README MIT, docs/ present).
- **Determinism:** re-running `release:build` produced byte-identical `source.zip`, `dist.zip` and `RELEASE_MANIFEST.json` (hashes compared, no diff).
- **`npm run release:verify` → exit 0, 57/57 PASS, 0 FAIL** (frozen `f6b35a8`, the scratch commit).
- **`npm run verify:extracted-tree` on the regenerated source.zip → PASS, 0 failures** (1204 dirs; r1+r2 27/27; full `npm test` 573/573).
- Full logs in this directory: `p023-fixr3-freeze-build2.log`, `p023-fixr3-freeze-verify.log`, `p023-fixr3-freeze-extracted.log`; the regenerated artifacts themselves in `regenerated-release/` (`source.zip`, `dist.zip`, `SHA256SUMS.txt`, `RELEASE_MANIFEST.json`, `RELEASE_FILE_LIST.csv`).

One honest failure on the way: the first scratch `release:build` run failed exactly one check (`no node_modules/.git/dist/release in source.zip`) because my scratch setup had committed the `node_modules` symlink into the scratch tree with `git add -A`, so `git archive` packaged the symlink and the extracted tree saw a `node_modules/` entry. That was a harness/setup error, not a product defect: the symlink was untracked and the build re-run clean after fixing the scratch commit. The contaminated first-run artifacts were discarded, not kept.

**`release/` in the main tree is untouched** — it still holds the R3 frozen artifacts (source.zip sha `6ca98ec7…`, dist.zip sha `4c941595…`). The next T014 freeze re-runs `release:build` from the fix+record commits and commits the new `release/`; its `dist.zip` will be byte-identical to the regenerated one here (determinism proven above), while `source.zip` will additionally contain the record-commit files. The regenerated manifest names the scratch commit `f6b35a8` as frozen — that is the scratch worktree's HEAD, not the fix commit `b89f786`; the content it froze is the fix commit plus two scratch-only bookkeeping commits.

## Deliverables

- Output commit: `b89f786` — README.md, package.json, `scripts/release-build.mjs`, `scripts/release-build.d.mts`, `scripts/release-verify.mjs`, `scripts/verify-all.mjs`, `tests/regression/r4-license.test.ts` (7 files, +214/−18).
- This report: `03_evidence/FIX-R3/FIX_R3_REPORT.md` (+ `regenerated-release/` artifacts and the three freeze logs).
- TASK_BOARD.csv: new `FIX-R3` row (record commit).
- T012 evidence refreshed by the re-runs (`03_evidence/T012/verify-all.json` / `verify-all.log` / `licenses.json` / `e2e.json` / `performance.json` — head `b89f786`, product license MIT).

## Known limits

- The other 12 carried P2s are untouched (including P2-R1-11: `01_spec/PROJECT_BOOK.md` §10.2 still shows a `PENDING_SAM_DECISION` license row — a frozen-spec snapshot, out of scope for this fix).
- P2-R1-13 remains FALSE.
- No T014 freeze was performed (separate task): the main tree's `release/` still holds the R3 frozen artifacts until T014 re-freezes from the fix commit. Muse's verification and the independent T013 re-review run against the output commit + the regenerated artifacts in this directory.
