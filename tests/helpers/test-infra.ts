/**
 * Shared test-infrastructure helpers (P023 T012, S4).
 *
 * `checkoutS0` restores 03_evidence/S0/ after a gate run (the gate
 * rewrites the base_commit label there). Two test files used to do
 * this with a bare `git checkout` and collided on .git/index.lock
 * under vitest's parallel workers (first seen 2026-11-13 ~15:50);
 * only index.lock errors are retried, with backoff — any other git
 * failure throws immediately.
 *
 * dist/ builds used to live here too (`buildDistOnce`, a lock
 * around `npm run build`). They were removed: the vitest
 * globalSetup (tests/helpers/global-setup.ts) builds dist/ once
 * before any test file runs, because a build starting mid-suite
 * could overlap CLI spawns from other files (a spawn landing
 * mid-write loads a truncated module and exits 1). The lock itself
 * still lives in scripts/build-lock.mjs and is used by the
 * globalSetup and by scripts/s0-gate.mjs step 1.
 */

import { execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";

function sleepSync(ms: number): void {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

/**
 * Restore 03_evidence/S0/ after a gate run, retrying when another
 * parallel git process holds .git/index.lock. Only index.lock
 * errors are retried; any other git failure throws immediately.
 *
 * FIX-R2 (P1-R2-01): a plain extracted source tree (no .git — the
 * `git archive` product) cannot restore from git. The gate still
 * runs and must pass there; the restore is a no-op, because there
 * is nothing to restore from and the extracted tree is disposable.
 * The assertions that call this helper are unchanged.
 */
export function checkoutS0(repoRoot: string): void {
  if (!fs.existsSync(path.join(repoRoot, ".git"))) {
    return;
  }
  const attempts = 10;
  for (let i = 0; i < attempts; i += 1) {
    try {
      execFileSync("git", ["checkout", "--", "03_evidence/S0/"], { cwd: repoRoot });
      return;
    } catch (err) {
      const stderr = (err as { stderr?: unknown }).stderr?.toString() ?? "";
      const stdout = (err as { stdout?: unknown }).stdout?.toString() ?? "";
      if ((stderr + stdout).includes("index.lock") && i < attempts - 1) {
        sleepSync(300);
        continue;
      }
      throw err;
    }
  }
}
