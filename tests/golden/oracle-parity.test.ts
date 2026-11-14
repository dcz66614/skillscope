/**
 * Oracle parity tests (P023 T011, S4).
 *
 * Spawns the independent Python Reference Oracle over the same manifest
 * and fixtures the S0 gate uses, and checks:
 *   1. Oracle vs frozen golden: byte-identical canonical JSON for every
 *      fixture (the full result object, including `extra` and finding
 *      detail text — the same comparison the gate performs).
 *   2. Production kernel vs Oracle: the same full-field projection
 *      comparison as the S0 golden suite (see ./runner.ts for the two
 *      documented asymmetries: canonicalPath/extra are PoC-level fields
 *      compared by the gate, and policy-finding detail wording differs
 *      by design per ADR-005).
 *
 * The Oracle is read-only input: it is spawned, never modified, and its
 * output is compared, never used to generate expectations.
 */

import { execFileSync } from "node:child_process";
import * as path from "node:path";
import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../src/canonical/index.js";
import {
  FIXTURES_ROOT,
  MANIFEST_PATH,
  REPO_ROOT,
  goldenById,
  manifest,
  projectFrozenResult,
  projectKernelResult,
  runKernelFor,
  type GoldenResult,
} from "./runner.js";

function runOracle(): GoldenResult[] {
  const stdout = execFileSync(
    "python3",
    [
      path.join(REPO_ROOT, "oracle", "python", "reference_resolver.py"),
      "--manifest",
      MANIFEST_PATH,
      "--fixtures",
      FIXTURES_ROOT,
    ],
    { cwd: REPO_ROOT, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 120000 },
  );
  const parsed = JSON.parse(stdout) as GoldenResult[];
  return parsed;
}

describe("oracle parity", () => {
  it("the Oracle reproduces the frozen golden byte-identically for all 48 fixtures", () => {
    const oracle = runOracle();
    expect(oracle).toHaveLength(48);
    for (const result of oracle) {
      const expected = goldenById.get(result.fixture_id)!;
      expect(canonicalizeJson(result)).toBe(canonicalizeJson(expected));
    }
  });

  it("the production kernel agrees with the Oracle on every projected field", async () => {
    const oracle = runOracle();
    const oracleById = new Map(oracle.map((r) => [r.fixture_id, r]));
    for (const entry of manifest.fixtures) {
      const { result, fixtureDir, hasPolicy } = await runKernelFor(entry);
      const orc = oracleById.get(entry.fixture_id)!;
      expect(projectKernelResult(result, fixtureDir)).toEqual(
        projectFrozenResult(orc, hasPolicy),
      );
    }
  });
});
