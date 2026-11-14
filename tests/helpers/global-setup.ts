/**
 * Vitest global setup (P023 T012, S4).
 *
 * Builds dist/ ONCE, before any test file starts. The per-file
 * `beforeAll` builds that used to do this were a race: five test
 * files built concurrently (fixed with a lock in
 * scripts/build-lock.mjs), but a build queued behind the lock could
 * still start seconds into the suite — while earlier files' tests
 * were already spawning the CLI against dist/ being rewritten
 * (a spawn landing mid-write loads a truncated module and exits 1;
 * seen 2026-11-13 in tests/ci's `verify --fixtures s0 --ci` check).
 * One build up front, and no rebuilds during the suite, closes
 * that window. The S0 gate's own mid-suite rebuild is likewise
 * skipped inside the suite (see SKILLSCOPE_GATE_NO_REBUILD in
 * scripts/s0-gate.mjs); standalone gate runs always rebuild.
 */

import { execSync } from "node:child_process";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { withBuildLock } from "../../scripts/build-lock.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

export default function setup(): void {
  withBuildLock(() => execSync("npm run build", { cwd: ROOT, stdio: "pipe" }));
}
