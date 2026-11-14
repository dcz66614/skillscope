/**
 * Shared helpers for the T011 golden suite (tests/golden).
 *
 * The PoC runners replicate the invocation pattern of the T002/T003/T006
 * tests (same inputs, same temp-dir discipline). The projections below
 * compare the three sides — production kernel, frozen S0 golden, and the
 * independent Python Oracle — on every field the kernel emits:
 *
 *   status, instances (all fields except canonicalPath, which the kernel
 *   does not emit — it is a PoC-level field compared exactly by the S0
 *   gate), findings, coverage, policy summary.
 *
 * Two deliberate, documented asymmetries:
 *   - Policy findings (SCOPE_LEAK / DISABLE_MISMATCH) are compared
 *     WITHOUT their detail text: the kernel recomputes them with its own
 *     wording (ADR-005) while the golden/Oracle carry the Oracle wording.
 *     Their detail is instead asserted non-empty and naming the violating
 *     instance (see checkPolicyFindingDetails). All other findings are
 *     compared WITH detail text, after scrubbing the absolute fixture
 *     directory to "<FIXTURE_DIR>" exactly as the S0 canonicaliser does.
 *   - The golden/Oracle carry no policy summary; the expected summary is
 *     derived from the result itself (applied = the fixture profile
 *     carries a policy; effectiveCount = ELIGIBLE instances;
 *     expectedCount = effective minus distinct violating ids;
 *     violationCount = number of policy findings — the resolver
 *     convention, findings not instances).
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

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
  resolveClaudeAudit,
  resolveCodexAudit,
  resolveOpenMausBotAudit,
  type AuditResult,
} from "../../src/resolver/index.js";

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const REPO_ROOT = path.resolve(HERE, "..", "..");
export const FIXTURES_ROOT = path.join(REPO_ROOT, "tests", "fixtures", "s0");
export const GOLDEN_PATH = path.join(REPO_ROOT, "tests", "golden", "s0", "expected.json");
export const MANIFEST_PATH = path.join(FIXTURES_ROOT, "manifest.json");
export const FIXTURE_DIR_PLACEHOLDER = "<FIXTURE_DIR>";

export function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

export interface ManifestEntry {
  fixture_id: string;
  engine: "codex" | "claude-code" | "openmausbot";
  dir: string;
  kind: "control" | "planted";
  defect: string | null;
}

export interface GoldenInstance {
  sourceRootId: string;
  sourceScope: string;
  relativePath: string;
  canonicalPath: string;
  logicalName: string;
  folderName: string;
  manifestName?: string;
  contentSha256: string;
  status: string;
  evidenceLevel: string;
  aliases: string[];
}

export interface GoldenFinding {
  id: string;
  severity: string;
  sourceScope: string;
  status: string;
  detail: string;
  affectedCount?: number;
  instanceIds: string[];
}

export interface GoldenResult {
  fixture_id: string;
  engine: string;
  kind: string;
  defect: string | null;
  status: string;
  instances: GoldenInstance[];
  findings: GoldenFinding[];
  coverage: { enumeratedSources: number; requiredSources: number; unknownScopes: string[] };
  extra: Record<string, unknown>;
}

export const manifest = loadJson<{ fixtures: ManifestEntry[] }>(MANIFEST_PATH);
export const golden = loadJson<{ results: GoldenResult[] }>(GOLDEN_PATH);
export const goldenById = new Map(golden.results.map((r) => [r.fixture_id, r]));

// ------------------------------------------------------------- PoC runners ---

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

export async function runCodexCase(caseId: string): Promise<CodexPocResult> {
  const caseDir = path.join(FIXTURES_ROOT, "codex", caseId);
  const layoutRoot = path.join(caseDir, "layout");
  const tmp = await mkdtemp(path.join(tmpdir(), "skillscope-t011-codex-"));
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

export function runClaudeFixture(fixtureId: string): {
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

export function runOmbFixture(fixtureId: string): {
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

export interface KernelRun {
  result: AuditResult;
  /** Absolute fixture directory, for scrubbing finding details. */
  fixtureDir: string;
  /** Whether the fixture profile carries a policy. */
  hasPolicy: boolean;
}

export async function runKernelFor(entry: ManifestEntry): Promise<KernelRun> {
  const shortId = entry.fixture_id.split("/")[1] as string;
  if (entry.engine === "codex") {
    return {
      result: resolveCodexAudit(await runCodexCase(shortId)),
      fixtureDir: path.join(FIXTURES_ROOT, "codex", shortId),
      hasPolicy: false,
    };
  }
  if (entry.engine === "claude-code") {
    const { native, policy } = runClaudeFixture(shortId);
    return {
      result: resolveClaudeAudit(native, policy),
      fixtureDir: path.join(FIXTURES_ROOT, "claude", shortId),
      hasPolicy: policy !== undefined,
    };
  }
  const { native, policy } = runOmbFixture(shortId);
  return {
    result: resolveOpenMausBotAudit(native, policy),
    fixtureDir: path.join(FIXTURES_ROOT, "openmausbot", shortId),
    hasPolicy: policy !== undefined,
  };
}

// -------------------------------------------------------------- projections ---

export interface ProjectedInstance {
  sourceRootId: string;
  sourceScope: string;
  relativePath: string;
  logicalName: string;
  folderName: string;
  manifestName: string | null;
  contentSha256: string;
  status: string;
  evidenceLevel: string;
  aliases: string[];
}

export interface ProjectedFinding {
  id: string;
  severity: string;
  sourceScope: string;
  status: string;
  /** Null for policy findings: wording differs between kernel and Oracle. */
  detail: string | null;
  instanceIds: string[];
  affectedCount: number | null;
}

export interface Projection {
  status: string;
  instances: ProjectedInstance[];
  findings: ProjectedFinding[];
  coverage: { enumeratedSources: number; requiredSources: number; unknownScopes: string[] };
  policy: { applied: boolean; effectiveCount: number; expectedCount: number; violationCount: number };
}

const POLICY_FINDING_IDS = new Set(["SCOPE_LEAK", "DISABLE_MISMATCH"]);

function compareStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortInstances<T extends ProjectedInstance>(instances: T[]): T[] {
  return [...instances].sort(
    (a, b) =>
      compareStr(a.sourceRootId, b.sourceRootId) ||
      compareStr(a.relativePath, b.relativePath) ||
      compareStr(a.logicalName, b.logicalName),
  );
}

function sortFindings<T extends ProjectedFinding>(findings: T[]): T[] {
  return [...findings].sort(
    (a, b) =>
      compareStr(a.id, b.id) ||
      compareStr(a.sourceScope, b.sourceScope) ||
      compareStr(a.status, b.status) ||
      compareStr(a.instanceIds.join(","), b.instanceIds.join(",")),
  );
}

export function projectKernelResult(result: AuditResult, fixtureDir: string): Projection {
  const instances: ProjectedInstance[] = result.instances.map((inst) => ({
    sourceRootId: inst.sourceRootId,
    sourceScope: inst.sourceScope,
    relativePath: inst.relativePath,
    logicalName: inst.logicalName,
    folderName: inst.folderName,
    manifestName: inst.manifestName ?? null,
    contentSha256: inst.contentSha256,
    status: inst.status,
    evidenceLevel: inst.evidenceLevel,
    aliases: [...inst.aliases],
  }));
  const findings: ProjectedFinding[] = result.findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    sourceScope: f.sourceScope,
    status: f.status,
    detail: POLICY_FINDING_IDS.has(f.id)
      ? null
      : f.detail.split(fixtureDir).join(FIXTURE_DIR_PLACEHOLDER),
    instanceIds: [...f.instanceIds],
    affectedCount: f.affectedCount ?? null,
  }));
  return {
    status: result.status,
    instances: sortInstances(instances),
    findings: sortFindings(findings),
    coverage: {
      enumeratedSources: result.coverage.enumeratedSources,
      requiredSources: result.coverage.requiredSources,
      unknownScopes: [...result.coverage.unknownScopes],
    },
    policy: {
      applied: result.policy.applied,
      effectiveCount: result.policy.effectiveCount,
      expectedCount: result.policy.expectedCount,
      violationCount: result.policy.violationCount,
    },
  };
}

/** Project a golden or Oracle result (same shape) the same way. */
export function projectFrozenResult(
  frozen: GoldenResult,
  hasPolicy: boolean,
): Projection {
  const instances: ProjectedInstance[] = frozen.instances.map((inst) => ({
    sourceRootId: inst.sourceRootId,
    sourceScope: inst.sourceScope,
    relativePath: inst.relativePath,
    logicalName: inst.logicalName,
    folderName: inst.folderName,
    manifestName: inst.manifestName ?? null,
    contentSha256: inst.contentSha256,
    status: inst.status,
    evidenceLevel: inst.evidenceLevel,
    aliases: [...inst.aliases],
  }));
  const findings: ProjectedFinding[] = frozen.findings.map((f) => ({
    id: f.id,
    severity: f.severity,
    sourceScope: f.sourceScope,
    status: f.status,
    detail: POLICY_FINDING_IDS.has(f.id) ? null : f.detail,
    instanceIds: [...f.instanceIds],
    affectedCount: f.affectedCount ?? null,
  }));
  const effectiveCount = frozen.instances.filter((i) => i.status === "ELIGIBLE").length;
  const violating = new Set(
    frozen.findings
      .filter((f) => POLICY_FINDING_IDS.has(f.id))
      .flatMap((f) => f.instanceIds),
  );
  return {
    status: frozen.status,
    instances: sortInstances(instances),
    findings: sortFindings(findings),
    coverage: {
      enumeratedSources: frozen.coverage.enumeratedSources,
      requiredSources: frozen.coverage.requiredSources,
      unknownScopes: [...frozen.coverage.unknownScopes],
    },
    policy: {
      applied: hasPolicy,
      effectiveCount,
      expectedCount: effectiveCount - violating.size,
      violationCount: frozen.findings.filter((f) => POLICY_FINDING_IDS.has(f.id)).length,
    },
  };
}

/**
 * Policy findings carry no cross-implementation wording contract, but
 * their detail must still name the violating instance it refers to.
 * Returns a list of violations (empty = all good).
 */
export function checkPolicyFindingDetails(result: AuditResult): string[] {
  const problems: string[] = [];
  for (const f of result.findings) {
    if (!POLICY_FINDING_IDS.has(f.id)) continue;
    if (typeof f.detail !== "string" || f.detail.length === 0) {
      problems.push(`${f.id} in ${result.profileId} has an empty detail`);
      continue;
    }
    for (const id of f.instanceIds) {
      if (!f.detail.includes(id)) {
        problems.push(`${f.id} in ${result.profileId} does not name instance ${id} in its detail`);
      }
    }
  }
  return problems;
}
