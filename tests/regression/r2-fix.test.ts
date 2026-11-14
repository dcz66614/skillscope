/**
 * R2 FIX regression suite (P023 FIX-T013R).
 *
 * One test per T013 re-review finding, plus the controls that prove the
 * fix did not break the honest cases:
 *
 * - P1-T013R-01 (Codex symlink escape guard was dead code): an escaping
 *   symlink must yield SYMLINK_OUTSIDE_ROOT (P1/UNKNOWN) + INCOMPLETE,
 *   never a REPO-ELIGIBLE instance and never a silent drop. The
 *   laundering pair (with / without the symlink) proves the same
 *   physical skill flips from "forbidden USER, kernel FAIL" to "PASS"
 *   on the old code and stays INCOMPLETE on the fixed code. The
 *   in-root alias control proves legitimate symlink aliasing still
 *   merges and still passes.
 * - P2-T013R-02 (TS side): a readable synced/ directory whose only
 *   skill subdirectory is unreadable must make ACCOUNT_SYNC UNKNOWN.
 *   That case runs the built `dist/` as the unprivileged user `nobody`
 *   (via tests/regression/r2-driver.mjs), staged exactly like the R1
 *   suite: the suite runs as root, and root bypasses chmod 000, so an
 *   in-process run could never prove a real EACCES.
 *
 * Fixtures live in tests/fixtures/regression/r2/ as readable trees;
 * the permission fixture carries a `deny.json` listing the paths the
 * harness chmods 000 in the staged copy (git cannot track 000 modes).
 * Symlink fixtures are used in place (never copied: copying a tree
 * rewrites relative symlink targets, the T002 lesson) for the
 * in-process cases; only the nobody case stages a copy.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCodexSkills } from "../../src/adapters/codex/codex-poc.js";
import { resolveClaudeAudit, resolveCodexAudit } from "../../src/resolver/index.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const FIXTURES = path.join(REPO_ROOT, "tests/fixtures/regression/r2");
const STAGING_PARENT = path.resolve(REPO_ROOT, "..");

function codexInput(base: string) {
  return {
    caseId: "r2",
    layoutRoot: base,
    cwd: path.join(base, "repo"),
    repoRoot: path.join(base, "repo"),
    homeRoot: path.join(base, "home"),
    adminRoot: path.join(base, "etc-codex"),
    bundledPath: path.join(base, "bundled.json"),
    pluginsPath: path.join(base, "plugins.json"),
  };
}

describe("FIX-T013R in-process cases (P1-T013R-01 symlink escape)", () => {
  it("P1-T013R-01: a Codex skill symlink escaping its source root is INCOMPLETE with SYMLINK_OUTSIDE_ROOT, never an attributed instance", () => {
    const base = path.join(FIXTURES, "r2-01-codex-symlink-escape");
    const poc = resolveCodexSkills(codexInput(base));
    expect(poc.status).toBe("INCOMPLETE");
    expect(poc.unknownSources).toEqual([]);
    // The escaped skill is NOT attributed to REPO and NOT silently
    // dropped: it is recorded as an UNKNOWN finding.
    expect(poc.skills.map((s) => s.logicalName)).toEqual(["real"]);
    expect(poc.skills[0]?.sourceScope).toBe("REPO");
    expect(poc.skills[0]?.status).toBe("ELIGIBLE");
    const escape = poc.findings.filter(
      (f) => f.id === "SYMLINK_OUTSIDE_ROOT",
    );
    expect(escape).toHaveLength(1);
    expect(escape[0]?.severity).toBe("P1");
    expect(escape[0]?.sourceScope).toBe("REPO");
    expect(escape[0]?.status).toBe("UNKNOWN");
    expect(escape[0]?.detail).toContain(
      "repo/.agents/skills/evil/SKILL.md",
    );
    expect(escape[0]?.detail).toContain(
      "resolves outside its source root (REPO)",
    );
    // All five sources were enumerated; the incompleteness comes from
    // the UNKNOWN finding alone.
    expect(poc.coverage).toEqual({
      enumeratedSources: 5,
      requiredSources: 5,
    });
    // The kernel carries the finding through and stays INCOMPLETE.
    const kernel = resolveCodexAudit(poc, { forbiddenScopes: ["REPO"] });
    expect(kernel.status).toBe("INCOMPLETE");
    expect(
      kernel.findings.map((f) => f.id),
    ).toContain("SYMLINK_OUTSIDE_ROOT");
  });

  it("P1-T013R-01 laundering: a USER skill smuggled in through a REPO symlink is USER ELIGIBLE + INCOMPLETE, and the forbidden-USER policy still leaks", () => {
    const base = path.join(FIXTURES, "r2-01b-codex-symlink-launder");
    const poc = resolveCodexSkills(codexInput(base));
    expect(poc.status).toBe("INCOMPLETE");
    expect(poc.skills).toHaveLength(1);
    expect(poc.skills[0]?.logicalName).toBe("evil-skill");
    // The laundering is defeated: the skill keeps its true USER scope,
    // with no REPO instance and no alias pointing at the smuggled path.
    expect(poc.skills[0]?.sourceScope).toBe("USER");
    expect(poc.skills[0]?.status).toBe("ELIGIBLE");
    expect(poc.skills[0]?.aliases).toEqual([]);
    expect(
      poc.findings.map((f) => f.id),
    ).toContain("SYMLINK_OUTSIDE_ROOT");
    const kernel = resolveCodexAudit(poc, { forbiddenScopes: ["USER"] });
    expect(kernel.status).toBe("INCOMPLETE");
    expect(kernel.findings.map((f) => f.id)).toEqual(
      expect.arrayContaining(["SCOPE_LEAK", "SYMLINK_OUTSIDE_ROOT"]),
    );
  });

  it("P1-T013R-01 control: the same skill without the symlink is USER ELIGIBLE and the forbidden-USER policy FAILs (no INCOMPLETE)", () => {
    const base = path.join(FIXTURES, "r2-01c-codex-launder-control");
    const poc = resolveCodexSkills(codexInput(base));
    expect(poc.status).toBe("PASS");
    expect(poc.skills).toHaveLength(1);
    expect(poc.skills[0]?.sourceScope).toBe("USER");
    expect(poc.skills[0]?.status).toBe("ELIGIBLE");
    expect(poc.findings).toEqual([]);
    const kernel = resolveCodexAudit(poc, { forbiddenScopes: ["USER"] });
    expect(kernel.status).toBe("FAIL");
    expect(kernel.findings.map((f) => f.id)).toContain("SCOPE_LEAK");
  });

  it("P1-T013R-01 control: a symlink staying inside its source root still merges as an alias and still passes", () => {
    const base = path.join(FIXTURES, "r2-01d-codex-symlink-alias-in-root");
    const poc = resolveCodexSkills(codexInput(base));
    expect(poc.status).toBe("PASS");
    expect(poc.findings).toEqual([]);
    expect(poc.skills).toHaveLength(1);
    expect(poc.skills[0]?.logicalName).toBe("real");
    expect(poc.skills[0]?.sourceScope).toBe("REPO");
    expect(poc.skills[0]?.status).toBe("ELIGIBLE");
    expect(poc.skills[0]?.aliases).toEqual([
      ".agents/skills/real/SKILL.md",
    ]);
  });
});

interface DriverFinding {
  id: string;
  severity: string;
  sourceScope: string;
  detail: string;
}

interface DriverResult {
  label: string;
  status: string;
  instances: Array<{
    sourceScope: string;
    logicalName: string;
    status: string;
  }>;
  findings: DriverFinding[];
  coverage: {
    enumeratedSources: number;
    requiredSources: number;
    unknownScopes: string[];
  } | null;
  unknownScopes: string[];
}

interface DriverOutput {
  scenario: string;
  results: DriverResult[];
}

function findingIds(result: DriverResult): string[] {
  return result.findings.map((f) => f.id);
}

function findingDetail(result: DriverResult, id: string): string | undefined {
  return result.findings.find((f) => f.id === id)?.detail;
}

/**
 * Stage a fixture copy + dist + the driver's node_modules deps into a
 * world-readable mkdtemp dir, chmod the fixture's deny.json paths 000,
 * run the driver as `nobody`, and clean up (restoring modes first so
 * the rm cannot trip over a 000 directory). Returns the parsed driver
 * JSON. Throws loudly if runuser is unavailable: a skipped permission
 * test would be a silent hole in the suite.
 */
function runScenarioAsNobody(
  scenario: string,
  fixtureId: string,
): DriverOutput {
  const src = path.join(FIXTURES, fixtureId);
  const staging = fs.mkdtempSync(path.join(STAGING_PARENT, ".r2-regression-"));
  try {
    // mkdtemp creates 0700; nobody must be able to traverse into it.
    fs.chmodSync(staging, 0o755);
    const dest = path.join(staging, fixtureId);
    fs.cpSync(src, dest, { recursive: true });
    // Normalize modes on EVERYTHING staged: the repo tree is 2770 /
    // 660 (group-only), and cpSync preserves modes — a staged copy
    // with those modes is unreadable to `nobody` (not in group root,
    // no "other" bits), and Node reports it as ERR_MODULE_NOT_FOUND.
    const normalize = (dir: string): void => {
      // The directory itself first: cpSync preserves the source mode
      // (2770 for the repo tree), and an un-traversable root hides
      // everything below it from `nobody`.
      fs.chmodSync(dir, 0o755);
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          normalize(p);
        } else {
          fs.chmodSync(p, 0o644);
        }
      }
    };
    normalize(dest);
    fs.cpSync(path.join(REPO_ROOT, "dist"), path.join(staging, "dist"), {
      recursive: true,
    });
    normalize(path.join(staging, "dist"));
    fs.mkdirSync(path.join(staging, "node_modules"), { recursive: true });
    fs.chmodSync(path.join(staging, "node_modules"), 0o755);
    for (const dep of ["smol-toml", "yaml"]) {
      fs.cpSync(
        path.join(REPO_ROOT, "node_modules", dep),
        path.join(staging, "node_modules", dep),
        { recursive: true },
      );
      normalize(path.join(staging, "node_modules", dep));
    }
    fs.copyFileSync(
      path.join(REPO_ROOT, "tests/regression/r2-driver.mjs"),
      path.join(staging, "r2-driver.mjs"),
    );
    fs.chmodSync(path.join(staging, "r2-driver.mjs"), 0o644);
    // A fixture without deny.json is a control: nothing is denied.
    const denyPath = path.join(dest, "deny.json");
    const deny = (
      fs.existsSync(denyPath)
        ? (JSON.parse(fs.readFileSync(denyPath, "utf8")).deny as string[])
        : []
    );
    for (const rel of deny) {
      fs.chmodSync(path.join(dest, rel), 0);
    }
    const res = childProcess.spawnSync(
      "runuser",
      [
        "-u",
        "nobody",
        "--",
        "node",
        path.join(staging, "r2-driver.mjs"),
        scenario,
        dest,
      ],
      { encoding: "utf8", timeout: 60000 },
    );
    if (res.error !== undefined) {
      throw new Error(
        `runuser failed for ${scenario} (is runuser installed and is the suite running as root?): ${res.error.message}`,
      );
    }
    if (res.status !== 0) {
      throw new Error(
        `r2-driver failed for ${scenario}: exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
      );
    }
    return JSON.parse(res.stdout) as DriverOutput;
  } finally {
    // Restore modes before removing: a 000 directory cannot be
    // listed for cleanup on filesystems that honour the mode.
    try {
      childProcess.spawnSync("chmod", ["-R", "u+rwX", staging]);
    } catch {
      // Best effort; the rm below runs as root either way.
    }
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function resultByLabel(output: DriverOutput, label: string): DriverResult {
  const found = output.results.find((r) => r.label === label);
  if (found === undefined) {
    throw new Error(
      `driver output for ${output.scenario} has no result labelled ${label}`,
    );
  }
  return found;
}

describe("FIX-T013R permission case (run as nobody)", () => {
  it("P2-T013R-02 (TS side): a readable synced/ directory whose only skill subdirectory is unreadable makes ACCOUNT_SYNC UNKNOWN", () => {
    const out = runScenarioAsNobody(
      "r2-02",
      "r2-02-claude-synced-unreadable-skill",
    );
    for (const label of ["claude-poc", "claude-kernel"]) {
      const r = resultByLabel(out, label);
      expect(r.status).toBe("INCOMPLETE");
      expect(r.unknownScopes).toContain("ACCOUNT_SYNC");
      expect(findingIds(r)).toContain("SOURCE_NOT_ENUMERATED");
      expect(findingDetail(r, "SOURCE_NOT_ENUMERATED")).toContain(
        "account-synced skills exist on disk under",
      );
    }
    // The readable PROJECT skill is still enumerated; only the
    // synced skill is unknown — it is neither reported nor dropped.
    const poc = resultByLabel(out, "claude-poc");
    expect(
      poc.instances.find((i) => i.logicalName === "project-skill"),
    ).toMatchObject({ sourceScope: "PROJECT", status: "ELIGIBLE" });
    expect(
      poc.instances.find((i) => i.logicalName === "anthropic-skill"),
    ).toBeUndefined();
  }, 60000);
});
