/**
 * Resolver kernel tests (P023 T006, S1).
 *
 * Covers src/resolver: the unified audit contract over the three PoC
 * adapters, the 48-fixture cross-check against the frozen S0 golden
 * (kernel status, finding ids and unknown scopes must agree with the
 * golden for every fixture), and named reproductions of each
 * §5.2 finding type the task requires: NAME_SELECTOR_BLAST_RADIUS,
 * SCOPE_LEAK, DISABLE_MISMATCH, FAIL_OPEN_CONFIG,
 * SOURCE_NOT_ENUMERATED — plus UNKNOWN entering coverage and the
 * audit result, and the discovery-skip → finding conversion.
 *
 * The kernel never touches the S0 gate inputs: it consumes PoC results
 * as values. The gate itself is re-run separately (`npm run s0:gate`)
 * and its hash must stay a11d2a4c45e338afe67b59b064604b0d80b139bd8006802747faaf4af92bf1ca.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveCodexSkills,
  type CodexPocInput,
  type CodexPocResult,
} from "../../src/adapters/codex/codex-poc.js";
import {
  resolveClaudeFixture,
  type ClaudePocInput,
  type ClaudePocResult,
} from "../../src/adapters/claude/claude-poc.js";
import {
  resolveOpenMausBotFixture,
  type OpenMausBotPocInput,
  type OpenMausBotPocResult,
} from "../../src/adapters/openmausbot/openmausbot-poc.js";
import type { PolicyV1 } from "../../src/policy/index.js";
import {
  discoveryFindings,
  resolveClaudeAudit,
  resolveCodexAudit,
  resolveOpenMausBotAudit,
  type AuditResult,
} from "../../src/resolver/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_ROOT = path.resolve(HERE, "../fixtures/s0");
const GOLDEN_PATH = path.resolve(HERE, "../golden/s0/expected.json");
const MANIFEST_PATH = path.join(FIXTURES_ROOT, "manifest.json");

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

interface ManifestEntry {
  fixture_id: string;
  engine: "codex" | "claude-code" | "openmausbot";
  dir: string;
  kind: "control" | "planted";
  defect: string | null;
}

interface GoldenResult {
  fixture_id: string;
  status: string;
  instances: Array<{ logicalName: string; sourceScope: string; status: string }>;
  findings: Array<{ id: string; severity: string; sourceScope: string; status: string }>;
  coverage: { enumeratedSources: number; requiredSources: number; unknownScopes: string[] };
}

const manifest = loadJson<{ fixtures: ManifestEntry[] }>(MANIFEST_PATH);
const golden = loadJson<{ results: GoldenResult[] }>(GOLDEN_PATH);
const goldenById = new Map(golden.results.map((r) => [r.fixture_id, r]));

// --- PoC runners (same invocation pattern as the T002/T003 tests). ---

interface CodexCaseInput {
  case_id: string;
  cwd: string;
  repo_root: string;
  home_root: string;
  admin_root: string;
  config_file: string | null;
  bundled_file: string | null;
  plugins_file: string | null;
}

async function runCodexCase(caseId: string): Promise<CodexPocResult> {
  const caseDir = path.join(FIXTURES_ROOT, "codex", caseId);
  const layoutRoot = path.join(caseDir, "layout");
  const tmp = await mkdtemp(path.join(tmpdir(), "skillscope-t006-codex-"));
  try {
    const rawInput = JSON.parse(
      await readFile(path.join(caseDir, "input.json"), "utf8"),
    ) as CodexCaseInput;
    let configPath: string | undefined;
    if (rawInput.config_file !== null) {
      const text = await readFile(path.join(caseDir, rawInput.config_file), "utf8");
      configPath = path.join(tmp, "config.toml");
      await writeFile(
        configPath,
        text.includes("__CASE_DIR__")
          ? text.replaceAll("__CASE_DIR__", layoutRoot)
          : text,
        "utf8",
      );
    }
    const resolveRel = (rel: string | null): string | undefined =>
      rel === null ? undefined : path.join(caseDir, rel);
    const input: CodexPocInput = {
      caseId: rawInput.case_id,
      layoutRoot,
      cwd: path.join(caseDir, rawInput.cwd),
      repoRoot: path.join(caseDir, rawInput.repo_root),
      homeRoot: path.join(caseDir, rawInput.home_root),
      adminRoot: path.join(caseDir, rawInput.admin_root),
      configPath,
      bundledPath: resolveRel(rawInput.bundled_file),
      pluginsPath: resolveRel(rawInput.plugins_file),
    };
    return resolveCodexSkills(input);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function runClaudeFixture(fixtureId: string): {
  native: ClaudePocResult;
  policy: PolicyV1 | undefined;
} {
  const dir = path.join(FIXTURES_ROOT, "claude", fixtureId);
  const profile = loadJson<ClaudePocInput>(path.join(dir, "profile.json"));
  return {
    native: resolveClaudeFixture(profile, dir),
    policy: profile.policy as PolicyV1 | undefined,
  };
}

function runOmbFixture(fixtureId: string): {
  native: OpenMausBotPocResult;
  policy: PolicyV1 | undefined;
} {
  const dir = path.join(FIXTURES_ROOT, "openmausbot", fixtureId);
  const profile = loadJson<OpenMausBotPocInput>(path.join(dir, "profile.json"));
  return {
    native: resolveOpenMausBotFixture(profile, dir),
    policy: profile.policy as PolicyV1 | undefined,
  };
}

async function runKernelFor(entry: ManifestEntry): Promise<AuditResult> {
  const shortId = entry.fixture_id.split("/")[1] as string;
  if (entry.engine === "codex") {
    return resolveCodexAudit(await runCodexCase(shortId));
  }
  if (entry.engine === "claude-code") {
    const { native, policy } = runClaudeFixture(shortId);
    return resolveClaudeAudit(native, policy);
  }
  const { native, policy } = runOmbFixture(shortId);
  return resolveOpenMausBotAudit(native, policy);
}

function findingIdMultiset(result: AuditResult): string[] {
  return result.findings.map((f) => f.id).sort();
}

describe("kernel vs frozen S0 golden (48 fixtures)", () => {
  it("manifest and golden agree on the fixture set", () => {
    expect(manifest.fixtures).toHaveLength(48);
    expect(golden.results).toHaveLength(48);
    for (const entry of manifest.fixtures) {
      expect(goldenById.has(entry.fixture_id)).toBe(true);
    }
  });

  for (const entry of manifest.fixtures) {
    it(`cross-check ${entry.fixture_id}`, async () => {
      const expected = goldenById.get(entry.fixture_id) as GoldenResult;
      const result = await runKernelFor(entry);
      expect(result.schema).toBe("skillscope.audit-result/v1");
      expect(result.status).toBe(expected.status);
      expect(findingIdMultiset(result)).toEqual(
        expected.findings.map((f) => f.id).sort(),
      );
      expect(result.coverage.unknownScopes).toEqual(
        expected.coverage.unknownScopes,
      );
      expect(result.instances).toHaveLength(expected.instances.length);
      // Every kernel instance id is the canonical audit key.
      for (const inst of result.instances) {
        expect(inst.instanceId).toBe(
          `${inst.sourceRootId}:${inst.relativePath}`,
        );
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
});

describe("finding reproductions (one per required type)", () => {
  it("NAME_SELECTOR_BLAST_RADIUS: codex c04 (2 distinct instances, one name)", async () => {
    const result = resolveCodexAudit(await runCodexCase("c04-name-selector-blast"));
    const blast = result.findings.filter(
      (f) => f.id === "NAME_SELECTOR_BLAST_RADIUS",
    );
    expect(blast).toHaveLength(1);
    expect(blast[0]?.affectedCount).toBe(2);
    expect(blast[0]?.severity).toBe("P1");
    expect(result.status).toBe("FAIL");
  });

  it("NAME_SELECTOR_BLAST_RADIUS: claude c05 (name override blasts two scopes)", () => {
    const { native, policy } = runClaudeFixture("c05-name-override-blast");
    const result = resolveClaudeAudit(native, policy);
    expect(
      result.findings.filter((f) => f.id === "NAME_SELECTOR_BLAST_RADIUS"),
    ).toHaveLength(1);
    expect(result.status).toBe("FAIL");
  });

  it("NAME_SELECTOR_BLAST_RADIUS: openmausbot o07 (native name switch blasts)", () => {
    const { native, policy } = runOmbFixture("o07-native-name-blast");
    const result = resolveOpenMausBotAudit(native, policy);
    expect(
      result.findings.filter((f) => f.id === "NAME_SELECTOR_BLAST_RADIUS"),
    ).toHaveLength(1);
    expect(result.status).toBe("FAIL");
  });

  it("SCOPE_LEAK: claude c07 (NESTED instance under a forbidden-scope policy)", () => {
    const { native, policy } = runClaudeFixture("c07-nested-scope-leak");
    const result = resolveClaudeAudit(native, policy);
    const leaks = result.findings.filter((f) => f.id === "SCOPE_LEAK");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.sourceScope).toBe("NESTED");
    expect(result.status).toBe("FAIL");
    expect(result.policy.applied).toBe(true);
    expect(result.policy.violationCount).toBe(1);
  });

  it("SCOPE_LEAK: openmausbot o16 (SHARED_LIBRARY instance under a forbidden-scope policy)", () => {
    const { native, policy } = runOmbFixture("o16-shared-library-scope-leak");
    const result = resolveOpenMausBotAudit(native, policy);
    expect(
      result.findings.filter((f) => f.id === "SCOPE_LEAK"),
    ).toHaveLength(1);
    expect(result.status).toBe("FAIL");
  });

  it("DISABLE_MISMATCH: claude c01 with 'release' forbidden by name", () => {
    const { native } = runClaudeFixture("c01-basic");
    const result = resolveClaudeAudit(native, { forbiddenNames: ["release"] });
    const mismatches = result.findings.filter(
      (f) => f.id === "DISABLE_MISMATCH",
    );
    expect(mismatches).toHaveLength(1);
    expect(mismatches[0]?.severity).toBe("P1");
    const release = result.instances.find((i) => i.logicalName === "release");
    expect(release?.status).toBe("ELIGIBLE");
    expect(mismatches[0]?.instanceIds).toEqual([release?.instanceId]);
    expect(result.status).toBe("FAIL");
    expect(result.policy.expectedCount).toBe(2);
  });

  it("DISABLE_MISMATCH: namespace is never flattened — 'deploy' does not match 'acme:deploy'", () => {
    const { native } = runClaudeFixture("c03-plugin-namespace");
    const result = resolveClaudeAudit(native, { forbiddenNames: ["deploy"] });
    const mismatches = result.findings.filter(
      (f) => f.id === "DISABLE_MISMATCH",
    );
    expect(mismatches).toHaveLength(1);
    const deploy = result.instances.find(
      (i) => i.logicalName === "deploy" && i.sourceScope === "PROJECT",
    );
    expect(mismatches[0]?.instanceIds).toEqual([deploy?.instanceId]);
    // The namespaced plugin skill is untouched by the bare name.
    const namespaced = result.instances.find(
      (i) => i.logicalName === "acme:deploy",
    );
    expect(namespaced?.status).toBe("ELIGIBLE");
    expect(result.status).toBe("FAIL");
  });

  it("FAIL_OPEN_CONFIG: codex c08 (unreadable config → INCOMPLETE, never PASS)", async () => {
    const result = resolveCodexAudit(await runCodexCase("c08-unreadable-config"));
    expect(
      result.findings.filter((f) => f.id === "FAIL_OPEN_CONFIG"),
    ).toHaveLength(1);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.coverage.unknownScopes).toEqual(["PLUGIN", "SYSTEM"]);
  });

  it("FAIL_OPEN_CONFIG: openmausbot o15 (invalid config JSON → INCOMPLETE)", () => {
    const { native, policy } = runOmbFixture("o15-invalid-config-json");
    const result = resolveOpenMausBotAudit(native, policy);
    expect(
      result.findings.filter((f) => f.id === "FAIL_OPEN_CONFIG"),
    ).toHaveLength(1);
    expect(result.status).toBe("INCOMPLETE");
    expect(result.coverage.unknownScopes).toEqual(["CONFIG"]);
  });

  it("SOURCE_NOT_ENUMERATED: codex c11 / claude c06 / openmausbot o13", async () => {
    const codex = resolveCodexAudit(await runCodexCase("c11-missing-user-source"));
    expect(
      codex.findings.filter((f) => f.id === "SOURCE_NOT_ENUMERATED"),
    ).toHaveLength(1);
    expect(codex.coverage.unknownScopes).toEqual(["USER"]);
    expect(codex.status).toBe("INCOMPLETE");

    const claude = resolveClaudeAudit(runClaudeFixture("c06-sync-unenumerated").native);
    expect(
      claude.findings.filter((f) => f.id === "SOURCE_NOT_ENUMERATED"),
    ).toHaveLength(1);
    expect(claude.coverage.unknownScopes).toEqual(["ACCOUNT_SYNC"]);
    expect(claude.status).toBe("INCOMPLETE");

    const omb = resolveOpenMausBotAudit(runOmbFixture("o13-unknown-snapshot-version").native);
    expect(
      omb.findings.filter((f) => f.id === "SOURCE_NOT_ENUMERATED"),
    ).toHaveLength(1);
    expect(omb.coverage.unknownScopes).toEqual(["SNAPSHOT"]);
    expect(omb.instances).toHaveLength(0);
    expect(omb.status).toBe("INCOMPLETE");
  });
});

describe("UNKNOWN enters coverage and the audit result", () => {
  it("codex c11: the unknown USER source is in coverage and the finding is UNKNOWN", async () => {
    const result = resolveCodexAudit(await runCodexCase("c11-missing-user-source"));
    expect(result.coverage).toEqual({
      enumeratedSources: 4,
      requiredSources: 5,
      unknownScopes: ["USER"],
    });
    const finding = result.findings.find(
      (f) => f.id === "SOURCE_NOT_ENUMERATED",
    );
    expect(finding?.status).toBe("UNKNOWN");
    expect(result.status).toBe("INCOMPLETE");
  });
});

describe("policy ownership and the DISCOVERED rule", () => {
  it("without a policy the kernel emits no policy findings (the PoC inline leak is stripped, not inherited)", () => {
    const { native } = runClaudeFixture("c07-nested-scope-leak");
    expect(native.findings.map((f) => f.id)).toContain("SCOPE_LEAK");
    const result = resolveClaudeAudit(native);
    expect(result.findings.map((f) => f.id)).not.toContain("SCOPE_LEAK");
    expect(result.policy.applied).toBe(false);
    expect(result.status).toBe("PASS");
  });

  it("a DISCOVERED instance in a forbidden scope does not leak (PoC and kernel agree, ADR-023)", () => {
    const dir = path.join(FIXTURES_ROOT, "openmausbot", "o09-library-off-discovered");
    const profile = loadJson<OpenMausBotPocInput>(path.join(dir, "profile.json"));
    const syntheticPolicy = { forbiddenScopes: ["SHARED_LIBRARY"] };
    // FIX-R1 (ADR-023): the effective set is ELIGIBLE only (ADR-006),
    // in the PoC's inline check as well as in the kernel. A DISCOVERED
    // instance is flag-gated off, so the bot cannot load it: neither
    // layer reports a leak. (Before the fix the PoC counted DISCOVERED
    // as effective and reported SCOPE_LEAK FAIL while the kernel
    // dropped it and reported PASS — the R1 observation-1 split.)
    const pocWithPolicy = resolveOpenMausBotFixture(
      { ...profile, policy: syntheticPolicy },
      dir,
    );
    expect(pocWithPolicy.findings.map((f) => f.id)).not.toContain("SCOPE_LEAK");
    // The DISCOVERED instance is still reported as evidence — it is
    // present on disk, just not loadable — alongside the ELIGIBLE one.
    expect(pocWithPolicy.instances).toHaveLength(2);
    expect(
      pocWithPolicy.instances.find((i) => i.logicalName === "every-docs")
        ?.status,
    ).toBe("DISCOVERED");
    const result = resolveOpenMausBotAudit(pocWithPolicy, syntheticPolicy);
    expect(result.findings.map((f) => f.id)).not.toContain("SCOPE_LEAK");
    expect(result.status).toBe("PASS");
    expect(result.policy.effectiveCount).toBe(1);
    expect(result.policy.expectedCount).toBe(1);
  });

  it("the kernel validates the policy it is given", () => {
    const { native } = runClaudeFixture("c01-basic");
    expect(() =>
      resolveClaudeAudit(native, {
        allowedScopes: ["PROJECT"],
        forbiddenScopes: ["PROJECT"],
      }),
    ).toThrow(/both allowed and forbidden/);
  });

  it("a finding referencing an unknown instance is a producer bug and throws", () => {
    const { native } = runClaudeFixture("c01-basic");
    const tampered: ClaudePocResult = {
      ...native,
      findings: [
        {
          id: "SAME_NAME_COLLISION",
          severity: "P2",
          sourceScope: "PROJECT",
          detail: "ghost reference",
          instanceIds: ["ghost:skill/SKILL.md"],
        },
      ],
    };
    expect(() => resolveClaudeAudit(tampered)).toThrow(
      /references unknown instance/,
    );
  });
});

describe("discovery-skip findings", () => {
  it("SYMLINK_OUTSIDE_ROOT becomes a P1/UNKNOWN finding; loops and dangling links do not", () => {
    const findings = discoveryFindings({
      sourceScope: "PROJECT",
      skipped: [
        { path: "evil/SKILL.md", reason: "SYMLINK_OUTSIDE_ROOT" },
        { path: "loop", reason: "SYMLINK_LOOP" },
        { path: "dangling/SKILL.md", reason: "CANONICAL_PATH_UNRESOLVABLE" },
        { path: "deep", reason: "DEPTH_LIMIT" },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0]?.id).toBe("SYMLINK_OUTSIDE_ROOT");
    expect(findings[0]?.severity).toBe("P1");
    expect(findings[0]?.status).toBe("UNKNOWN");
    expect(findings[0]?.sourceScope).toBe("PROJECT");
  });

  it("an outside-root symlink drives the audit to INCOMPLETE through the resolver", () => {
    const { native } = runClaudeFixture("c01-basic");
    const clean = resolveClaudeAudit(native);
    expect(clean.status).toBe("PASS");
    const withEscape = resolveClaudeAudit(native, undefined, [
      {
        sourceScope: "PROJECT",
        skipped: [{ path: "evil/SKILL.md", reason: "SYMLINK_OUTSIDE_ROOT" }],
      },
    ]);
    expect(
      withEscape.findings.filter((f) => f.id === "SYMLINK_OUTSIDE_ROOT"),
    ).toHaveLength(1);
    expect(withEscape.status).toBe("INCOMPLETE");
  });

  it("an unreadable SKILL.md (EACCES) becomes a P1/UNKNOWN finding; ENOENT stays a silent recorded skip (FIX-R1)", () => {
    const findings = discoveryFindings({
      sourceScope: "PROJECT",
      skipped: [
        { path: "locked/SKILL.md", reason: "SKILL_MD_UNREADABLE", code: "EACCES" },
        { path: "container/SKILL.md", reason: "SKILL_MD_UNREADABLE", code: "ENOENT" },
        { path: "big/SKILL.md", reason: "SKILL_MD_TOO_LARGE" },
        { path: "dir", reason: "DIR_UNREADABLE", code: "EACCES" },
        { path: "root", reason: "ROOT_MISSING_OR_UNREADABLE", code: "EACCES" },
      ],
    });
    // EACCES SKILL.md + too-large file + EACCES directory: three
    // findings. The ENOENT container skip (a subdirectory with no
    // SKILL.md is not a skill) and the root skip (already reported
    // through coverage) produce none.
    expect(findings).toHaveLength(3);
    expect(findings.map((f) => f.id)).toEqual([
      "SOURCE_NOT_ENUMERATED",
      "SOURCE_NOT_ENUMERATED",
      "SOURCE_NOT_ENUMERATED",
    ]);
    expect(
      findings.every((f) => f.severity === "P1" && f.status === "UNKNOWN"),
    ).toBe(true);
    // Findings are sorted by detail; locate the locked entry by path.
    const locked = findings.find((f) => f.detail.includes("locked/SKILL.md"));
    expect(locked?.detail).toContain("its content is unknown");
    expect(
      findings.some((f) => f.detail.includes("big/SKILL.md")),
    ).toBe(true);
    expect(
      findings.some((f) => f.detail.includes("(DIR_UNREADABLE)")),
    ).toBe(true);
  });

  it("an unreadable SKILL.md drives the audit to INCOMPLETE through the resolver (FIX-R1)", () => {
    const { native } = runClaudeFixture("c01-basic");
    expect(resolveClaudeAudit(native).status).toBe("PASS");
    const withUnreadable = resolveClaudeAudit(native, undefined, [
      {
        sourceScope: "PROJECT",
        skipped: [
          {
            path: "locked/SKILL.md",
            reason: "SKILL_MD_UNREADABLE",
            code: "EACCES",
          },
        ],
      },
    ]);
    expect(
      withUnreadable.findings.filter((f) => f.id === "SOURCE_NOT_ENUMERATED"),
    ).toHaveLength(1);
    expect(withUnreadable.status).toBe("INCOMPLETE");
  });
});
