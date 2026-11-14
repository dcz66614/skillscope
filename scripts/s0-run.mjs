/**
 * S0 fixture runner (P023 T004).
 *
 * Loads the S0 manifest, runs every fixture through the production
 * adapters (compiled dist output), canonicalises each native result with
 * scripts/s0-canonical.mjs, and returns the canonical results in manifest
 * order. Also provides fixture-tree hashing (source-write detection) and
 * the deterministic replay used by both s0:gate and s0:repeat.
 *
 * Read-only with respect to the fixtures: the only temporary file is the
 * Codex config copy (needed to resolve the __CASE_DIR__ placeholder),
 * written under os.tmpdir() and removed afterwards. Fixture files are
 * never modified; the gate verifies that with hashFixtureTree().
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { resolveCodexSkills } from "../dist/adapters/codex/codex-poc.js";
import { resolveClaudeFixture } from "../dist/adapters/claude/claude-poc.js";
import { resolveOpenMausBotFixture } from "../dist/adapters/openmausbot/openmausbot-poc.js";
import {
  canonicalizeClaude,
  canonicalizeCodex,
  canonicalizeOmb,
  sha256Hex,
} from "./s0-canonical.mjs";

export const SEED = "P023-SKILLSCOPE-S0-2026-11-13";

export function repoRoot() {
  return path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
}

export function loadManifest(root) {
  const manifestPath = path.join(root, "tests", "fixtures", "s0", "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
  if (manifest.seed !== SEED) {
    throw new Error(`manifest seed ${manifest.seed} != ${SEED}`);
  }
  return manifest;
}

export function fixturesRoot(root) {
  return path.join(root, "tests", "fixtures", "s0");
}

/** Resolve a Claude profile's relative root paths against a fixture dir
 * (same rule as resolveClaudeFixture; re-resolution is idempotent). */
function resolveClaudeProfile(profile, fixtureDir) {
  return {
    ...profile,
    sourceRoots: profile.sourceRoots.map((root) => ({
      ...root,
      path:
        root.scope === "ACCOUNT_SYNC" || root.path === ""
          ? root.path
          : path.resolve(fixtureDir, root.path),
    })),
  };
}

/** Resolve an OpenMausBot profile's relative paths against a fixture dir
 * (same rule as resolveOpenMausBotFixture; re-resolution is idempotent). */
function resolveOmbProfile(profile, fixtureDir) {
  const resolveAbs = (p) => (p === "" ? p : path.resolve(fixtureDir, p));
  return {
    ...profile,
    dataDir: resolveAbs(profile.dataDir),
    snapshot: {
      ...profile.snapshot,
      skills: profile.snapshot.skills.map((skill) => ({
        ...skill,
        path: resolveAbs(skill.path),
        ...(skill.originalPath !== undefined
          ? { originalPath: resolveAbs(skill.originalPath) }
          : {}),
      })),
      loadableRoots: profile.snapshot.loadableRoots.map(resolveAbs),
    },
  };
}

async function runCodexFixture(entry, fixtureDir) {
  const rawInput = JSON.parse(
    await readFile(path.join(fixtureDir, "input.json"), "utf8"),
  );
  const layoutRoot = path.join(fixtureDir, "layout");
  const tmp = await mkdtemp(path.join(tmpdir(), "skillscope-s0-"));
  try {
    let configPath;
    if (rawInput.config_file !== null) {
      const text = await readFile(
        path.join(fixtureDir, rawInput.config_file),
        "utf8",
      );
      configPath = path.join(tmp, "config.toml");
      await writeFile(
        configPath,
        text.includes("__CASE_DIR__")
          ? text.replaceAll("__CASE_DIR__", layoutRoot)
          : text,
        "utf8",
      );
    }
    const resolveRel = (rel) =>
      rel === null ? undefined : path.join(fixtureDir, rel);
    const input = {
      caseId: rawInput.case_id,
      layoutRoot,
      cwd: path.join(fixtureDir, rawInput.cwd),
      repoRoot: path.join(fixtureDir, rawInput.repo_root),
      homeRoot: path.join(fixtureDir, rawInput.home_root),
      adminRoot: path.join(fixtureDir, rawInput.admin_root),
      configPath,
      bundledPath: resolveRel(rawInput.bundled_file),
      pluginsPath: resolveRel(rawInput.plugins_file),
    };
    const native = resolveCodexSkills(input);
    return canonicalizeCodex(
      entry.fixture_id,
      entry.kind,
      entry.defect ?? null,
      fixtureDir,
      native,
    );
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

async function runFixture(root, entry) {
  const fixtureDir = path.join(fixturesRoot(root), entry.dir);
  if (entry.engine === "codex") {
    return runCodexFixture(entry, fixtureDir);
  }
  const profile = JSON.parse(
    await readFile(path.join(fixtureDir, "profile.json"), "utf8"),
  );
  if (entry.engine === "claude-code") {
    const resolved = resolveClaudeProfile(profile, fixtureDir);
    const native = resolveClaudeFixture(resolved, fixtureDir);
    return canonicalizeClaude(
      entry.fixture_id,
      entry.kind,
      entry.defect ?? null,
      fixtureDir,
      resolved,
      native,
    );
  }
  if (entry.engine === "openmausbot") {
    const resolved = resolveOmbProfile(profile, fixtureDir);
    const native = resolveOpenMausBotFixture(resolved, fixtureDir);
    return canonicalizeOmb(
      entry.fixture_id,
      entry.kind,
      entry.defect ?? null,
      fixtureDir,
      resolved,
      native,
    );
  }
  throw new Error(`unknown engine ${entry.engine} for ${entry.fixture_id}`);
}

/** Run all manifest fixtures through production and return the canonical
 * results in manifest order. */
export async function runAllFixtures(root) {
  const manifest = loadManifest(root);
  const results = [];
  for (const entry of manifest.fixtures) {
    results.push(await runFixture(root, entry));
  }
  return results;
}

/** Gate hash for one run: SHA-256 of the canonical {seed, results}. */
export function gateHash(results) {
  return sha256Hex({ seed: SEED, results });
}

/** Run the full gate `count` times and collect the gate hashes. The
 * resolution is pure (read-only fixtures, no clock/random/PID in the
 * canonical output), so every run must produce the same hash. */
export async function repeatGate(root, count) {
  const hashes = [];
  for (let i = 0; i < count; i += 1) {
    const results = await runAllFixtures(root);
    hashes.push(gateHash(results));
  }
  const unique = [...new Set(hashes)];
  return { count, hashes, uniqueHashes: unique, uniqueHashCount: unique.length };
}

// ------------------------------------------------- fixture tree hashing ---
function toPosix(p) {
  return p.split(path.sep).join("/");
}

/** Hash every file under a directory (relative posix path -> SHA-256 of
 * bytes; symlinks recorded by target). Used to prove the gate performs
 * zero writes to the fixture source tree. */
export function hashFixtureTree(dir) {
  const out = {};
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const full = path.join(current, entry.name);
      const rel = toPosix(path.relative(dir, full));
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isSymbolicLink()) {
        out[rel] = `symlink:${fs.readlinkSync(full)}`;
      } else if (entry.isFile()) {
        out[rel] = createHash("sha256")
          .update(fs.readFileSync(full))
          .digest("hex");
      }
    }
  };
  walk(dir);
  return out;
}

/** Compare two fixture-tree hashes; returns the list of changed paths. */
export function diffFixtureTrees(before, after) {
  const changed = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    if (before[key] !== after[key]) {
      changed.push(key);
    }
  }
  return changed.sort();
}
