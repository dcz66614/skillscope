/**
 * `skillscope verify --fixtures s0` (P023 T009, S3).
 *
 * Delegates to the frozen S0 gate (scripts/s0-gate.mjs) — it rebuilds
 * dist, runs all 48 fixtures through the production adapters and the
 * independent Python Oracle, compares both against the frozen golden,
 * verifies zero source writes and zero network capability, and replays
 * the gate 100 times for a single gate hash. The CLI does NOT
 * reimplement the gate: the gate script is the authority, and a second
 * implementation would be a second source of truth that could drift.
 *
 * Exit code is the gate's exit code (0 = gate PASS, non-zero = gate
 * FAIL). The gate writes its evidence to 03_evidence/S0/ itself.
 */

import { spawnSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export interface VerifyResult {
  exitCode: number;
  gateExitCode: number | null;
  error?: string;
}

/** Repository root, derived from this file's location in dist/. */
export function repoRoot(): string {
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
}

/**
 * Run the frozen gate. `stdio: "inherit"` streams the gate's own
 * output to the caller's terminal, so `verify` shows the same log a
 * direct `npm run s0:gate` would.
 */
export function runVerify(): VerifyResult {
  const root = repoRoot();
  const gateScript = path.join(root, "scripts", "s0-gate.mjs");
  const spawned = spawnSync(process.execPath, [gateScript], {
    cwd: root,
    stdio: "inherit",
  });
  if (spawned.error !== undefined) {
    return {
      exitCode: 4,
      gateExitCode: null,
      error: `cannot run the S0 gate: ${spawned.error.message}`,
    };
  }
  const gateExitCode = spawned.status ?? 1;
  return { exitCode: gateExitCode === 0 ? 0 : 1, gateExitCode };
}
