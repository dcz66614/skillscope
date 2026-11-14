#!/usr/bin/env node
/**
 * Shared dist-build lock (P023 T012, S4).
 *
 * Serializes `npm run build` across every process that can run it
 * concurrently: the five vitest files' beforeAll hooks (via
 * tests/helpers/test-infra.ts) AND scripts/s0-gate.mjs step 1 (the
 * gate rebuilds dist itself, and is itself run by two parallel
 * test files through `skillscope verify --fixtures s0`).
 *
 * Without this lock, concurrent tsc processes write the same dist/
 * files; a CLI spawned mid-write can load a truncated module and
 * exit 1. That flake first appeared 2026-11-13 ~15:50 (suite passed
 * 526/526 twice, then failed twice in different tests) and was
 * only fully fixed once the gate's own build joined the lock —
 * locking only the test files left the gate's unlocked build
 * racing with them.
 *
 * The lock is an atomic mkdir in the OS temp dir; the holder's pid
 * is recorded inside, so a lock from a killed process is stolen
 * instead of blocking forever. API: `withBuildLock(fn)` runs `fn`
 * while holding the lock and always releases it afterwards.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

const BUILD_LOCK_DIR = path.join(os.tmpdir(), "skillscope-build.lock");
const BUILD_LOCK_TIMEOUT_MS = 120000;
const BUILD_LOCK_POLL_MS = 200;

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(sab), 0, 0, ms);
}

function lockHolderAlive() {
  try {
    const pid = Number(fs.readFileSync(path.join(BUILD_LOCK_DIR, "pid"), "utf8").trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      return false;
    }
    try {
      process.kill(pid, 0);
      return true;
    } catch (err) {
      return err.code !== "ESRCH";
    }
  } catch {
    return false;
  }
}

function acquireBuildLock() {
  const deadline = Date.now() + BUILD_LOCK_TIMEOUT_MS;
  for (;;) {
    try {
      fs.mkdirSync(BUILD_LOCK_DIR);
      fs.writeFileSync(path.join(BUILD_LOCK_DIR, "pid"), String(process.pid), "utf8");
      return;
    } catch (err) {
      if (err.code !== "EEXIST") {
        throw err;
      }
      if (!lockHolderAlive()) {
        // Stale lock from a killed process: steal it.
        fs.rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error(
          `withBuildLock: timed out after ${BUILD_LOCK_TIMEOUT_MS} ms waiting for ${BUILD_LOCK_DIR}`,
        );
      }
      sleepSync(BUILD_LOCK_POLL_MS);
    }
  }
}

function releaseBuildLock() {
  fs.rmSync(BUILD_LOCK_DIR, { recursive: true, force: true });
}

/** Run `fn` while holding the exclusive dist-build lock. */
export function withBuildLock(fn) {
  acquireBuildLock();
  try {
    return fn();
  } finally {
    releaseBuildLock();
  }
}
