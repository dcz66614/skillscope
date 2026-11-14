/**
 * Full-field golden tests (P023 T011, S4).
 *
 * Compares the production kernel against the frozen S0 golden
 * (tests/golden/s0/expected.json, 48 fixtures) on EVERY field the kernel
 * emits — status, instances, findings, coverage and policy summary —
 * through the projections in ./runner.ts. This is strictly stronger
 * than the T006 cross-check, which compared only status, finding-id
 * multisets, unknown scopes and instance counts.
 *
 * What is NOT compared here, and why:
 *   - `canonicalPath` on instances: the kernel does not emit it (it
 *     carries only the canonical-path hash). The S0 gate compares it
 *     exactly between the production canonicaliser and the Oracle.
 *   - `extra` (configReadable / botId+flags): a PoC-level field, also
 *     compared exactly by the gate, not by the kernel.
 *   - Policy-finding detail text: the kernel recomputes policy findings
 *     with its own wording (ADR-005) while the golden carries the Oracle
 *     wording. Compared as null in the projection; the detail is
 *     separately asserted non-empty and naming the violating instance.
 *   - Finding detail for all other findings IS compared exactly, after
 *     scrubbing the absolute fixture directory to "<FIXTURE_DIR>".
 *
 * The golden file itself is never written by this suite: it is read-only
 * input. A failure here means the implementation changed, never the
 * golden — the golden is only ever adjusted by an explicit, separately
 * reviewed decision, never to fit the implementation.
 */

import { describe, expect, it } from "vitest";

import { canonicalizeJson } from "../../src/canonical/index.js";
import {
  checkPolicyFindingDetails,
  golden,
  goldenById,
  manifest,
  projectFrozenResult,
  projectKernelResult,
  runKernelFor,
} from "./runner.js";

describe("kernel vs frozen S0 golden (full-field, 48 fixtures)", () => {
  it("manifest and golden agree on the fixture set", () => {
    expect(manifest.fixtures).toHaveLength(48);
    expect(golden.results).toHaveLength(48);
    for (const entry of manifest.fixtures) {
      expect(goldenById.has(entry.fixture_id)).toBe(true);
    }
    // 24 control + 24 planted, 16 per engine.
    const byEngine = new Map<string, number>();
    for (const entry of manifest.fixtures) {
      byEngine.set(entry.engine, (byEngine.get(entry.engine) ?? 0) + 1);
    }
    expect([...byEngine.values()]).toEqual([16, 16, 16]);
    expect(manifest.fixtures.filter((e) => e.kind === "control")).toHaveLength(24);
    expect(manifest.fixtures.filter((e) => e.kind === "planted")).toHaveLength(24);
  });

  for (const entry of manifest.fixtures) {
    it(`golden ${entry.fixture_id} (${entry.kind}${entry.defect === null ? "" : `, ${entry.defect}`})`, async () => {
      const expected = goldenById.get(entry.fixture_id)!;
      const { result, fixtureDir, hasPolicy } = await runKernelFor(entry);
      expect(result.schema).toBe("skillscope.audit-result/v1");
      expect(result.profileId).toBe(expected.fixture_id.split("/")[1]);
      expect(projectKernelResult(result, fixtureDir)).toEqual(
        projectFrozenResult(expected, hasPolicy),
      );
      // Policy-finding details name their instance (wording itself is
      // implementation-defined, see the header).
      expect(checkPolicyFindingDetails(result)).toEqual([]);
      // Every kernel instance id is the canonical audit key.
      for (const inst of result.instances) {
        expect(inst.instanceId).toBe(`${inst.sourceRootId}:${inst.relativePath}`);
      }
      // Every finding reference resolves to a kernel instance.
      const known = new Set(result.instances.map((i) => i.instanceId));
      for (const finding of result.findings) {
        for (const id of finding.instanceIds) {
          expect(known.has(id)).toBe(true);
        }
      }
    });
  }

  it("the golden detects all 24 planted defects and raises no false alarm on the 24 controls", async () => {
    // Same accounting as the S0 gate (scripts/s0-gate.mjs §7): a planted
    // fixture counts as detected when the kernel result equals the golden
    // AND the golden carries a deviation marker (a finding, an unknown
    // scope, or a non-ELIGIBLE instance — two planted fixtures, codex
    // c16 and claude c14, are detected only through a non-ELIGIBLE
    // instance and report status PASS with no findings). A control
    // counts as a false alarm when its status is not PASS or it carries
    // a P1 finding (P2 findings on controls are legitimate: same-name
    // coexistence and duplicate content are allowed).
    const hasDeviationMarker = (g: { findings: unknown[]; coverage: { unknownScopes: unknown[] }; instances: Array<{ status: string }> }): boolean =>
      g.findings.length > 0 ||
      g.coverage.unknownScopes.length > 0 ||
      g.instances.some((inst) => inst.status !== "ELIGIBLE");
    let detected = 0;
    let falseAlarms = 0;
    for (const entry of manifest.fixtures) {
      const expected = goldenById.get(entry.fixture_id)!;
      const { result, fixtureDir, hasPolicy } = await runKernelFor(entry);
      if (entry.kind === "planted") {
        const matches = canonicalizeJson(projectKernelResult(result, fixtureDir)) ===
          canonicalizeJson(projectFrozenResult(expected, hasPolicy));
        if (matches && hasDeviationMarker(expected)) detected++;
      } else if (result.status !== "PASS" || result.findings.some((f) => f.severity === "P1")) {
        falseAlarms++;
      }
    }
    expect(detected).toBe(24);
    expect(falseAlarms).toBe(0);
  });
});
