/**
 * R1 FIX regression suite (P023 FIX-R1).
 *
 * One test per R1 P0/P1, plus the control that proves the fix did not
 * break the honest case. The permission-denial cases run the built
 * `dist/` as the unprivileged user `nobody` (via tests/regression/
 * r1-driver.mjs): the suite runs as root, and root bypasses chmod 000,
 * so an in-process run could never prove a real EACCES. Fixtures live
 * in tests/fixtures/regression/r1/ as readable trees; each permission
 * fixture carries a `deny.json` listing the paths the harness chmods
 * 000 in the staged copy (git cannot track 000 modes). Staging is a
 * mkdtemp directory under ~/workspace — never /tmp (nobody cannot
 * read anything under this VM's /tmp) and never inside the 2770 repo
 * tree (nobody cannot traverse it either).
 *
 * Non-permission cases (nested features, top-level control, synced
 * directory, derivation, CLI contracts) run in-process as root.
 */
import * as childProcess from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { resolveCodexSkills } from "../../src/adapters/codex/codex-poc.js";
import {
  resolveClaudePoc,
  type ClaudeSourceRootInput,
} from "../../src/adapters/claude/claude-poc.js";
import { auditClaude } from "../../src/adapters/claude/adapter.js";
import {
  resolveOpenMausBotPoc,
} from "../../src/adapters/openmausbot/openmausbot-poc.js";
import { auditOpenMausBot } from "../../src/adapters/openmausbot/adapter.js";
import {
  resolveClaudeAudit,
  resolveOpenMausBotAudit,
} from "../../src/resolver/index.js";
import { runAudit } from "../../src/cli/audit.js";

const REPO_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../..",
);
const FIXTURES = path.join(REPO_ROOT, "tests/fixtures/regression/r1");
const STAGING_PARENT = path.resolve(REPO_ROOT, "..");

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
  flags?: { claudeUserSkills: boolean; skillsLibrary: boolean; configSource: string };
  configReadable?: boolean;
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
  const staging = fs.mkdtempSync(path.join(STAGING_PARENT, ".r1-regression-"));
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
      path.join(REPO_ROOT, "tests/regression/r1-driver.mjs"),
      path.join(staging, "r1-driver.mjs"),
    );
    fs.chmodSync(path.join(staging, "r1-driver.mjs"), 0o644);
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
        path.join(staging, "r1-driver.mjs"),
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
        `r1-driver failed for ${scenario}: exit ${res.status}\nstdout: ${res.stdout}\nstderr: ${res.stderr}`,
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

describe("FIX-R1 permission cases (run as nobody)", () => {
  it("P0-R1-01: Codex unreadable REPO skills root is INCOMPLETE, never an empty PASS", () => {
    const out = runScenarioAsNobody("r1-01", "r1-01-codex-repo-unreadable");
    const poc = resultByLabel(out, "codex-poc");
    expect(poc.status).toBe("INCOMPLETE");
    expect(poc.unknownScopes).toContain("REPO");
    expect(findingIds(poc)).toContain("SOURCE_NOT_ENUMERATED");
    expect(findingDetail(poc, "SOURCE_NOT_ENUMERATED")).toContain(
      "REPO source could not be enumerated",
    );
    // The private skill inside the unreadable root is NOT reported as
    // absent: no REPO instance at all.
    expect(
      poc.instances.filter((i) => i.sourceScope === "REPO"),
    ).toHaveLength(0);
    const kernel = resultByLabel(out, "codex-kernel");
    expect(kernel.status).toBe("INCOMPLETE");
    expect(kernel.unknownScopes).toContain("REPO");
  }, 60000);

  it("P0-R1-01 control: the same REPO root readable enumerates the private skill (and the forbidden scope leaks)", () => {
    const out = runScenarioAsNobody("r1-01", "r1-01-codex-repo-readable");
    const poc = resultByLabel(out, "codex-poc");
    const repoSkill = poc.instances.find(
      (i) => i.sourceScope === "REPO" && i.logicalName === "test-skill",
    );
    expect(repoSkill?.status).toBe("ELIGIBLE");
    const kernel = resultByLabel(out, "codex-kernel");
    expect(findingIds(kernel)).toContain("SCOPE_LEAK");
  }, 60000);

  it("P0-R1-02: Claude unreadable SKILL.md is INCOMPLETE at PoC, kernel and full-adapter level", () => {
    const out = runScenarioAsNobody("r1-02", "r1-02-claude-skill-md-unreadable");
    for (const label of ["claude-poc", "claude-kernel", "claude-full-adapter"]) {
      const r = resultByLabel(out, label);
      expect(r.status).toBe("INCOMPLETE");
      expect(r.unknownScopes).toContain("PROJECT");
      expect(findingIds(r)).toContain("SOURCE_NOT_ENUMERATED");
      expect(findingDetail(r, "SOURCE_NOT_ENUMERATED")).toContain(
        "could not be fully enumerated",
      );
    }
    // The unreadable skill is not silently dropped to zero instances
    // AND not reported as an instance either: it is unknown, and the
    // PoC reports no PROJECT instance for it.
    const poc = resultByLabel(out, "claude-poc");
    expect(poc.instances).toHaveLength(0);
  }, 60000);

  it("P0-R1-03 (unreadable): Claude unreadable synced/ directory is INCOMPLETE, not a silent absence", () => {
    const out = runScenarioAsNobody("r1-03-unreadable", "r1-03-claude-synced-unreadable");
    for (const label of ["claude-poc", "claude-kernel"]) {
      const r = resultByLabel(out, label);
      expect(r.status).toBe("INCOMPLETE");
      expect(r.unknownScopes).toContain("ACCOUNT_SYNC");
      expect(findingIds(r)).toContain("SOURCE_NOT_ENUMERATED");
      expect(findingDetail(r, "SOURCE_NOT_ENUMERATED")).toContain(
        "account-synced skills directory",
      );
      expect(findingDetail(r, "SOURCE_NOT_ENUMERATED")).toContain(
        "cannot be read",
      );
    }
  }, 60000);

  it("P1-R1-02a: OpenMausBot unreadable config directory is INCOMPLETE with FAIL_OPEN_CONFIG", () => {
    const out = runScenarioAsNobody("r1-02a", "r1-02a-omb-config-unreadable");
    for (const label of ["r1-02a-poc", "r1-02a-kernel", "r1-02a-full-adapter"]) {
      const r = resultByLabel(out, label);
      expect(r.status).toBe("INCOMPLETE");
      expect(r.unknownScopes).toContain("CONFIG");
      expect(findingIds(r)).toContain("FAIL_OPEN_CONFIG");
      expect(findingDetail(r, "FAIL_OPEN_CONFIG")).toContain(
        "exists but cannot be read",
      );
    }
    const poc = resultByLabel(out, "r1-02a-poc");
    expect(poc.flags).toEqual({
      claudeUserSkills: false,
      skillsLibrary: false,
      configSource: "invalid",
    });
    // The library skill is still enumerated (its directory is
    // readable) but flag-gated off, so it is DISCOVERED, not lost.
    expect(
      poc.instances.find((i) => i.logicalName === "shared-skill")?.status,
    ).toBe("DISCOVERED");
  }, 60000);

  it("P1-R1-02b: OpenMausBot unreadable opt-out directory is INCOMPLETE but the skill stays ELIGIBLE", () => {
    const out = runScenarioAsNobody("r1-02b", "r1-02b-omb-optout-unreadable");
    for (const label of ["r1-02b-poc", "r1-02b-kernel"]) {
      const r = resultByLabel(out, label);
      expect(r.status).toBe("INCOMPLETE");
      expect(r.unknownScopes).toContain("SHARED_LIBRARY");
      expect(findingIds(r)).toContain("FAIL_OPEN_CONFIG");
      expect(findingDetail(r, "FAIL_OPEN_CONFIG")).toContain(
        "library opt-out file",
      );
      expect(findingDetail(r, "FAIL_OPEN_CONFIG")).toContain(
        "exists but cannot be read",
      );
    }
    // Per the public docs an unreadable opt-out means the bot keeps
    // every-bot skills: the instance stays ELIGIBLE (host-correct),
    // the audit is INCOMPLETE (not a silent PASS).
    const poc = resultByLabel(out, "r1-02b-poc");
    expect(
      poc.instances.find((i) => i.logicalName === "shared-skill")?.status,
    ).toBe("ELIGIBLE");
  }, 60000);
});

interface OmbSnapshotDoc {
  version: string;
  skills: Array<{
    name: string;
    kind: string;
    path: string;
    pluginId?: string;
    importState?: string;
    originalPath?: string;
  }>;
  loadableRoots: string[];
  emptyLists?: string[];
  disabledPluginIds?: string[];
  nativeDisabledNames?: string[];
}

function loadOmbSnapshot(base: string): OmbSnapshotDoc {
  return JSON.parse(
    fs.readFileSync(path.join(base, "snapshot.json"), "utf8"),
  ) as OmbSnapshotDoc;
}

function ombPocInput(
  base: string,
  policy: { allowedScopes?: string[]; forbiddenScopes?: string[] },
) {
  const s = loadOmbSnapshot(base);
  return {
    profileId: "r1-omb",
    botId: "demo",
    dataDir: path.join(base, "data"),
    snapshot: {
      version: s.version,
      skills: s.skills.map((k) => ({
        name: k.name,
        kind: k.kind as
          | "assigned"
          | "imported"
          | "native"
          | "plugin"
          | "repo"
          | "library"
          | "user-claude",
        path: path.join(base, k.path.replace(/^\.\//, "")),
      })),
      loadableRoots: s.loadableRoots.map((p) =>
        path.join(base, p.replace(/^\.\//, "")),
      ),
    },
    policy,
  };
}

function ombFullInput(
  base: string,
  policy: { allowedScopes?: string[]; forbiddenScopes?: string[] },
) {
  return {
    profileId: "r1-omb",
    botId: "demo",
    dataDir: path.join(base, "data"),
    snapshot: loadOmbSnapshot(base),
    fixtureDir: base,
    policy,
  };
}

describe("FIX-R1 in-process cases (no permission denial)", () => {
  it("P0-R1-02 control: a subdir with no SKILL.md (container dir) stays a silent recorded skip, not INCOMPLETE", () => {
    const base = path.join(FIXTURES, "r1-02-claude-container-dir");
    const poc = resolveClaudePoc({
      profileId: "r1-02-control",
      cwd: path.join(base, "repo"),
      sourceRoots: [
        {
          sourceRootId: "personal",
          scope: "PERSONAL",
          path: path.join(base, "home/.claude/skills"),
          required: true,
        },
        {
          sourceRootId: "project",
          scope: "PROJECT",
          path: path.join(base, "repo/.claude/skills"),
          required: true,
        },
      ],
      // The empty synced/ container dir is passed explicitly: it holds
      // no skills, so it must not make ACCOUNT_SYNC unknown.
      accountSyncDir: path.join(base, "home/.claude/skills/synced"),
      policy: { allowedScopes: ["PERSONAL", "PROJECT", "ACCOUNT_SYNC"] },
    });
    expect(poc.status).toBe("PASS");
    expect(poc.coverage.unknownScopes).toEqual([]);
    expect(
      poc.instances.map((i) => `${i.sourceScope}:${i.logicalName}`),
    ).toEqual(["PERSONAL:notes", "PROJECT:deploy"]);
    expect(poc.findings).toEqual([]);
    // The full adapter derives nothing extra and also passes: the
    // container dir is a known absence of skills, not unknown content.
    const full = auditClaude({
      profileId: "r1-02-control-full",
      cwd: path.join(base, "repo"),
      sourceRoots: [
        {
          sourceRootId: "personal",
          scope: "PERSONAL",
          path: path.join(base, "home/.claude/skills"),
          required: true,
        },
        {
          sourceRootId: "project",
          scope: "PROJECT",
          path: path.join(base, "repo/.claude/skills"),
          required: true,
        },
      ],
      homeDir: path.join(base, "home"),
      repoDir: path.join(base, "repo"),
      fixtureDir: base,
      policy: { allowedScopes: ["PERSONAL", "PROJECT", "ACCOUNT_SYNC"] },
    });
    expect(full.audit.status).toBe("PASS");
    expect(full.audit.coverage.unknownScopes).toEqual([]);
  });

  it("P0-R1-03: Claude synced/ skills with no ACCOUNT_SYNC root are INCOMPLETE", () => {
    const base = path.join(FIXTURES, "r1-03-claude-synced-undeclared");
    const roots: ClaudeSourceRootInput[] = [
      {
        sourceRootId: "personal",
        scope: "PERSONAL",
        path: path.join(base, "home/.claude/skills"),
        required: true,
      },
      {
        sourceRootId: "project",
        scope: "PROJECT",
        path: path.join(base, "repo/.claude/skills"),
        required: true,
      },
    ];
    const policy = { allowedScopes: ["PERSONAL", "PROJECT", "ACCOUNT_SYNC"] };
    const poc = resolveClaudePoc({
      profileId: "r1-03",
      cwd: path.join(base, "repo"),
      sourceRoots: roots,
      accountSyncDir: path.join(base, "home/.claude/skills/synced"),
      policy,
    });
    expect(poc.status).toBe("INCOMPLETE");
    expect(poc.coverage.unknownScopes).toContain("ACCOUNT_SYNC");
    expect(
      poc.findings.find((f) => f.id === "SOURCE_NOT_ENUMERATED")?.detail,
    ).toContain("account-synced skills exist on disk under");
    // The undeclared standard source joins the denominator.
    expect(poc.coverage.requiredSources).toBe(3);
    expect(poc.coverage.enumeratedSources).toBe(2);
    const kernel = resolveClaudeAudit(poc, policy);
    expect(kernel.status).toBe("INCOMPLETE");
    expect(kernel.coverage.unknownScopes).toContain("ACCOUNT_SYNC");
    // The PERSONAL root scan treats synced/ as a container dir, not a
    // skill: the synced skill is reported only via the ACCOUNT_SYNC
    // finding, never as a PERSONAL instance.
    expect(
      poc.instances.filter((i) => i.sourceScope === "PERSONAL"),
    ).toHaveLength(0);
  });

  it("P0-R1-03 control (synced absent): no synced/ directory is a known absence, PASS", () => {
    const base = path.join(FIXTURES, "r1-03-claude-synced-absent");
    const poc = resolveClaudePoc({
      profileId: "r1-03-absent",
      cwd: path.join(base, "repo"),
      sourceRoots: [
        {
          sourceRootId: "project",
          scope: "PROJECT",
          path: path.join(base, "repo/.claude/skills"),
          required: true,
        },
      ],
      accountSyncDir: path.join(base, "home/.claude/skills/synced"),
      policy: { allowedScopes: ["PERSONAL", "PROJECT", "ACCOUNT_SYNC"] },
    });
    expect(poc.status).toBe("PASS");
    expect(poc.coverage.unknownScopes).toEqual([]);
    expect(poc.coverage.requiredSources).toBe(1);
  });

  it("P0-R1-03 control (ACCOUNT_SYNC declared with snapshot): the declared root is authoritative, PASS", () => {
    const base = path.join(FIXTURES, "r1-03-claude-synced-undeclared");
    const poc = resolveClaudePoc({
      profileId: "r1-03-declared",
      cwd: path.join(base, "repo"),
      sourceRoots: [
        {
          sourceRootId: "project",
          scope: "PROJECT",
          path: path.join(base, "repo/.claude/skills"),
          required: true,
        },
        {
          sourceRootId: "sync",
          scope: "ACCOUNT_SYNC",
          path: "",
          required: true,
          snapshotSkills: [{ name: "anthropic-skill" }],
        },
      ],
      // Even with the directory on disk, a declared root wins and the
      // directory is not consulted.
      accountSyncDir: path.join(base, "home/.claude/skills/synced"),
      policy: { allowedScopes: ["PERSONAL", "PROJECT", "ACCOUNT_SYNC"] },
    });
    expect(poc.status).toBe("PASS");
    expect(poc.coverage.unknownScopes).toEqual([]);
    const synced = poc.instances.find(
      (i) => i.sourceScope === "ACCOUNT_SYNC",
    );
    expect(synced?.logicalName).toBe("anthropic-skill");
    expect(synced?.status).toBe("ELIGIBLE");
  });

  it("P0-R1-04: OpenMausBot nested features flags are honoured (library on, forbidden scope leaks)", () => {
    const base = path.join(FIXTURES, "r1-04-omb-nested-features");
    const policy = { forbiddenScopes: ["SHARED_LIBRARY"] };
    const poc = resolveOpenMausBotPoc(ombPocInput(base, policy));
    expect(poc.flags).toEqual({
      claudeUserSkills: true,
      skillsLibrary: true,
      configSource: "file",
    });
    const skill = poc.instances.find((i) => i.logicalName === "shared-skill");
    expect(skill?.status).toBe("ELIGIBLE");
    expect(poc.findings.map((f) => f.id)).toContain("SCOPE_LEAK");
    expect(poc.status).toBe("FAIL");
    const kernel = resolveOpenMausBotAudit(poc, policy);
    expect(kernel.status).toBe("FAIL");
    expect(kernel.findings.map((f) => f.id)).toContain("SCOPE_LEAK");
    const full = auditOpenMausBot(ombFullInput(base, policy));
    expect(full.audit.status).toBe("FAIL");
  });

  it("P0-R1-04 control: a top-level-only config reads as defaults (both flags off)", () => {
    const base = path.join(FIXTURES, "r1-04-omb-top-level");
    const policy = { forbiddenScopes: ["SHARED_LIBRARY"] };
    const poc = resolveOpenMausBotPoc(ombPocInput(base, policy));
    expect(poc.flags).toEqual({
      claudeUserSkills: false,
      skillsLibrary: false,
      configSource: "file",
    });
    // Library off: the skill is DISCOVERED, not ELIGIBLE, and a
    // DISCOVERED instance in a forbidden scope does not leak (ADR-023).
    const skill = poc.instances.find((i) => i.logicalName === "shared-skill");
    expect(skill?.status).toBe("DISCOVERED");
    expect(poc.findings.map((f) => f.id)).not.toContain("SCOPE_LEAK");
    expect(poc.status).toBe("PASS");
    const kernel = resolveOpenMausBotAudit(poc, policy);
    expect(kernel.status).toBe("PASS");
  });

  it("P0-R1-04: a non-boolean features flag is INCOMPLETE with FAIL_OPEN_CONFIG", () => {
    const base = path.join(FIXTURES, "r1-04-omb-features-nonboolean");
    const poc = resolveOpenMausBotPoc(
      ombPocInput(base, { forbiddenScopes: ["SHARED_LIBRARY"] }),
    );
    expect(poc.status).toBe("INCOMPLETE");
    expect(poc.coverage.unknownScopes).toContain("CONFIG");
    expect(poc.flags.configSource).toBe("invalid");
    const finding = poc.findings.find((f) => f.id === "FAIL_OPEN_CONFIG");
    expect(finding?.detail).toContain(
      "non-boolean features.claudeUserSkills/skillsLibrary flags",
    );
  });

  it("P0-R1-04: a non-object features value is INCOMPLETE with FAIL_OPEN_CONFIG", () => {
    const base = path.join(FIXTURES, "r1-04-omb-features-nonobject");
    const poc = resolveOpenMausBotPoc(
      ombPocInput(base, { forbiddenScopes: ["SHARED_LIBRARY"] }),
    );
    expect(poc.status).toBe("INCOMPLETE");
    expect(poc.coverage.unknownScopes).toContain("CONFIG");
    expect(poc.flags.configSource).toBe("invalid");
    const finding = poc.findings.find((f) => f.id === "FAIL_OPEN_CONFIG");
    expect(finding?.detail).toContain('non-object "features" value');
  });

  it("P1-R1-02b control (opt-out lists the skill): the library skill is DISCOVERED", () => {
    const base = path.join(FIXTURES, "r1-02b-omb-optout-listed");
    const policy = { allowedScopes: ["SHARED_LIBRARY"] };
    const poc = resolveOpenMausBotPoc(ombPocInput(base, policy));
    expect(poc.status).toBe("PASS");
    expect(
      poc.instances.find((i) => i.logicalName === "shared-skill")?.status,
    ).toBe("DISCOVERED");
    const kernel = resolveOpenMausBotAudit(poc, policy);
    expect(kernel.status).toBe("PASS");
  });

  it("P1-R1-02b control (opt-out missing): the library skill is ELIGIBLE, PASS", () => {
    const base = path.join(FIXTURES, "r1-02b-omb-optout-missing");
    const policy = { allowedScopes: ["SHARED_LIBRARY"] };
    const poc = resolveOpenMausBotPoc(ombPocInput(base, policy));
    expect(poc.status).toBe("PASS");
    expect(
      poc.instances.find((i) => i.logicalName === "shared-skill")?.status,
    ).toBe("ELIGIBLE");
  });

  it("P1-R1-03: a PERSONAL root omitted from the profile is derived when skills exist on disk", () => {
    const base = path.join(FIXTURES, "r1-03b-claude-personal-omitted");
    const full = auditClaude({
      profileId: "p1-03",
      cwd: path.join(base, "repo"),
      sourceRoots: [
        {
          sourceRootId: "project",
          scope: "PROJECT",
          path: path.join(base, "repo/.claude/skills"),
          required: true,
        },
      ],
      homeDir: path.join(base, "home"),
      repoDir: path.join(base, "repo"),
      fixtureDir: base,
      policy: { forbiddenScopes: ["PERSONAL"] },
    });
    // Before FIX-R1 the adapter reported PASS with only the PROJECT
    // instance. Now the PERSONAL skill is enumerated and, because the
    // policy forbids PERSONAL, the audit FAILs with SCOPE_LEAK.
    const personal = full.audit.instances.find(
      (i) => i.sourceScope === "PERSONAL",
    );
    expect(personal?.logicalName).toBe("test-skill");
    expect(personal?.status).toBe("ELIGIBLE");
    expect(full.audit.findings.map((f) => f.id)).toContain("SCOPE_LEAK");
    expect(full.audit.status).toBe("FAIL");
  });

  it("P1-R1-03 control: no personal skill on disk derives nothing, PASS", () => {
    const base = path.join(FIXTURES, "r1-03b-claude-personal-absent");
    const full = auditClaude({
      profileId: "p1-03-absent",
      cwd: path.join(base, "repo"),
      sourceRoots: [
        {
          sourceRootId: "project",
          scope: "PROJECT",
          path: path.join(base, "repo/.claude/skills"),
          required: true,
        },
      ],
      homeDir: path.join(base, "home"),
      repoDir: path.join(base, "repo"),
      fixtureDir: base,
      policy: { forbiddenScopes: ["PERSONAL"] },
    });
    expect(full.audit.status).toBe("PASS");
    expect(
      full.audit.instances.filter((i) => i.sourceScope === "PERSONAL"),
    ).toHaveLength(0);
    expect(full.audit.instances).toHaveLength(1);
  });
});

describe("FIX-R1 CLI contracts (in-process, via runAudit)", () => {
  function runCli(profilePath: string) {
    const outDir = fs.mkdtempSync(path.join(STAGING_PARENT, ".r1-cli-"));
    try {
      return runAudit({
        profilePath,
        outPath: path.join(outDir, "report.json"),
        format: "json",
      });
    } finally {
      fs.rmSync(outDir, { recursive: true, force: true });
    }
  }

  it("P1-R1-01: the OMB CLI honours OMB_DATA_DIR when the profile declares no data_dir", () => {
    const base = path.join(FIXTURES, "cli-omb-env-data-dir");
    const profilePath = path.join(base, "profile.json");
    const envData = path.join(base, "env-data");
    const prev = process.env["OMB_DATA_DIR"];
    try {
      process.env["OMB_DATA_DIR"] = envData;
      const withEnv = runCli(profilePath);
      expect(withEnv.exitCode).toBe(1);
      expect(withEnv.audit?.status).toBe("FAIL");
      expect(withEnv.engineDetails?.dataDir).toBe(envData);
      expect(withEnv.engineDetails?.dataDirSource).toBe("env");
      expect(withEnv.engineDetails?.botId).toBe("real-bot-7");
      // The env data dir has the library ON, so the shared skill is
      // ELIGIBLE and leaks into the forbidden SHARED_LIBRARY scope.
      expect(
        withEnv.audit?.instances.find((i) => i.logicalName === "shared-skill")
          ?.status,
      ).toBe("ELIGIBLE");
      expect(withEnv.audit?.findings.map((f) => f.id)).toContain("SCOPE_LEAK");

      delete process.env["OMB_DATA_DIR"];
      const withoutEnv = runCli(profilePath);
      expect(withoutEnv.exitCode).toBe(0);
      expect(withoutEnv.audit?.status).toBe("PASS");
      expect(withoutEnv.engineDetails?.dataDirSource).toBe("default");
      // The profile's own ./data has the library OFF: DISCOVERED.
      expect(
        withoutEnv.audit?.instances.find((i) => i.logicalName === "shared-skill")
          ?.status,
      ).toBe("DISCOVERED");
      expect(withoutEnv.audit?.findings.map((f) => f.id)).not.toContain(
        "SCOPE_LEAK",
      );
    } finally {
      if (prev === undefined) {
        delete process.env["OMB_DATA_DIR"];
      } else {
        process.env["OMB_DATA_DIR"] = prev;
      }
    }
  });

  it("P1-R1-01: an OMB profile without bot_id is an input error (exit 3), never a silent profile_id default", () => {
    const base = path.join(FIXTURES, "cli-omb-env-data-dir");
    const tmp = fs.mkdtempSync(path.join(STAGING_PARENT, ".r1-cli-"));
    try {
      const profile = JSON.parse(
        fs.readFileSync(path.join(base, "profile.json"), "utf8"),
      ) as Record<string, unknown>;
      delete profile["bot_id"];
      const profilePath = path.join(tmp, "profile.json");
      fs.writeFileSync(profilePath, JSON.stringify(profile));
      const result = runCli(profilePath);
      expect(result.exitCode).toBe(3);
      expect(result.error).toContain("bot_id");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("P1-R1-04: the Codex CLI reads the real ~/.codex/config.toml by default", () => {
    const base = path.join(FIXTURES, "cli-codex-home-config");
    const result = runCli(path.join(base, "profile.json"));
    // PASS (exit 0): the synthetic tree's USER/ADMIN skill dirs exist
    // (empty), so those sources are known-empty, not unknown.
    expect(result.exitCode).toBe(0);
    expect(result.engineDetails?.configSource).toBe("home");
    expect(result.engineDetails?.configPath).toBe(
      path.join(base, "home/.codex/config.toml"),
    );
    const deploy = result.audit?.instances.find(
      (i) => i.logicalName === "deploy",
    );
    expect(deploy?.status).toBe("DISABLED");
  });

  it("P1-R1-04: a profile-dir config.toml wins over the home config", () => {
    const base = path.join(FIXTURES, "cli-codex-profile-config");
    const result = runCli(path.join(base, "profile.json"));
    expect(result.exitCode).toBe(0);
    expect(result.engineDetails?.configSource).toBe("profile");
    expect(result.engineDetails?.configPath).toBe(
      path.join(base, "config.toml"),
    );
    // The profile config ENABLES deploy while the home config disables
    // it: profile precedence means the skill stays ELIGIBLE.
    const deploy = result.audit?.instances.find(
      (i) => i.logicalName === "deploy",
    );
    expect(deploy?.status).toBe("ELIGIBLE");
  });
});
