/**
 * R3 FIX regression suite (P023 FIX-R2).
 *
 * One test per R2 final-review finding:
 *
 * - P1-R2-02 (Codex cross-scope realpath merge drops a scope): the same
 *   physical SKILL.md reachable from two scopes used to collapse into
 *   ONE instance whose scope was decided by whichever scan ran first,
 *   so a forbidden USER source was silently swallowed and the kernel
 *   PASSed. Physical identity and source attribution are separate:
 *   the same file under two scopes is now TWO instances (one per
 *   scope, same content SHA), and the kernel's policy comparison
 *   sees both. Same-scope access paths still merge as aliases
 *   (c06 / r2-01d behaviour, pinned by the r2 suite and S0).
 *   Fixtures live in tests/fixtures/regression/r3/.
 * - P1-R2-01 (source.zip drops empty fixture directories): pinned by
 *   the .gitkeep files added to every empty fixture directory in
 *   this fix (22 regression dirs + 3 layout placeholders) and by the
 *   freeze-script gates (release-build fails on an empty dir without
 *   .gitkeep; release-verify compares the frozen commit's directory
 *   set against source.zip). The decisive check is the extracted-tree
 *   reproduction run (scripts/verify-extracted-tree.mjs): the r1 + r2
 *   suites must pass from a clean extraction of source.zip.
 */
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { resolveCodexSkills } from "../../src/adapters/codex/codex-poc.js";
import { resolveCodexAudit } from "../../src/resolver/index.js";

const REPO_ROOT = path.resolve(__dirname, "../..");
const FIXTURES = path.join(REPO_ROOT, "tests/fixtures/regression/r3");

function sharedInput(base: string) {
  // home_root == repo_root: both scans hit the same physical dir.
  return {
    caseId: "r3",
    layoutRoot: base,
    cwd: path.join(base, "shared"),
    repoRoot: path.join(base, "shared"),
    homeRoot: path.join(base, "shared"),
    adminRoot: path.join(base, "etc-codex"),
    bundledPath: path.join(base, "bundled.json"),
    pluginsPath: path.join(base, "plugins.json"),
  };
}

function overlappingInput(base: string) {
  // Overlapping roots: home_root is nested inside repo_root, and the
  // USER skills dir IS the physical dir the REPO walk finds first.
  return {
    caseId: "r3",
    layoutRoot: base,
    cwd: path.join(base, "repo"),
    repoRoot: base,
    homeRoot: path.join(base, "repo"),
    adminRoot: path.join(base, "etc-codex"),
    bundledPath: path.join(base, "bundled.json"),
    pluginsPath: path.join(base, "plugins.json"),
  };
}

function disjointInput(base: string) {
  return {
    caseId: "r3",
    layoutRoot: base,
    cwd: path.join(base, "repo"),
    repoRoot: path.join(base, "repo"),
    homeRoot: path.join(base, "home"),
    adminRoot: path.join(base, "etc-codex"),
    bundledPath: path.join(base, "bundled.json"),
    pluginsPath: path.join(base, "plugins.json"),
  };
}

describe("FIX-R2 cross-scope merge (P1-R2-02)", () => {
  it("P1-R2-02: home_root == repo_root yields TWO instances (REPO + USER), and a forbidden USER policy FAILs", () => {
    const base = path.join(FIXTURES, "r3-01-codex-cross-scope-merge");
    const poc = resolveCodexSkills(sharedInput(base));
    expect(poc.status).toBe("PASS");
    expect(poc.findings).toEqual([]);
    expect(poc.coverage).toEqual({ enumeratedSources: 5, requiredSources: 5 });
    // One physical file, two auditable instances — one per scope.
    expect(poc.skills).toHaveLength(2);
    const byScope = new Map(poc.skills.map((s) => [s.sourceScope, s]));
    const repo = byScope.get("REPO");
    const user = byScope.get("USER");
    expect(repo).toBeDefined();
    expect(user).toBeDefined();
    expect(repo?.logicalName).toBe("shared");
    expect(user?.logicalName).toBe("shared");
    // Same physical file: same content SHA, same canonical path.
    expect(user?.contentSha256).toBe(repo?.contentSha256);
    expect(user?.canonicalPath).toBe(repo?.canonicalPath);
    // ... but distinct instances, distinct identities, no cross-scope
    // alias absorption: neither instance lists the other scope's path.
    expect(repo?.instanceId).not.toBe(user?.instanceId);
    expect(repo?.sourceRootId).toBe("repo");
    expect(user?.sourceRootId).toBe("user");
    expect(repo?.aliases).toEqual([]);
    expect(user?.aliases).toEqual([]);
    // Without a policy both instances are ELIGIBLE and the audit passes.
    const noPolicy = resolveCodexAudit(poc);
    expect(noPolicy.status).toBe("PASS");
    expect(noPolicy.instances).toHaveLength(2);
    // With USER forbidden the kernel must FAIL on the USER instance —
    // the R2 false PASS is gone.
    const kernel = resolveCodexAudit(poc, { forbiddenScopes: ["USER"] });
    expect(kernel.status).toBe("FAIL");
    const leaks = kernel.findings.filter((f) => f.id === "SCOPE_LEAK");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.sourceScope).toBe("USER");
    expect(kernel.policy.expectedCount).toBe(1);
    expect(kernel.policy.effectiveCount).toBe(2);
  });

  it("P1-R2-02: overlapping roots (home nested in repo, same physical skills dir) also yield TWO instances", () => {
    const base = path.join(FIXTURES, "r3-01d-codex-overlapping-roots");
    const poc = resolveCodexSkills(overlappingInput(base));
    expect(poc.status).toBe("PASS");
    expect(poc.findings).toEqual([]);
    expect(poc.skills).toHaveLength(2);
    const scopes = poc.skills.map((s) => s.sourceScope).sort();
    expect(scopes).toEqual(["REPO", "USER"]);
    expect(poc.skills[0]?.logicalName).toBe("shared");
    expect(poc.skills[1]?.logicalName).toBe("shared");
    expect(poc.skills[0]?.contentSha256).toBe(poc.skills[1]?.contentSha256);
    const kernel = resolveCodexAudit(poc, { forbiddenScopes: ["USER"] });
    expect(kernel.status).toBe("FAIL");
    expect(kernel.findings.map((f) => f.id)).toContain("SCOPE_LEAK");
  });

  it("P1-R2-02 control: disjoint REPO/USER dirs stay two distinct instances with their own names", () => {
    const base = path.join(FIXTURES, "r3-01b-codex-cross-scope-disjoint");
    const poc = resolveCodexSkills(disjointInput(base));
    expect(poc.status).toBe("PASS");
    expect(poc.findings).toEqual([]);
    expect(poc.skills).toHaveLength(2);
    const byScope = new Map(poc.skills.map((s) => [s.sourceScope, s]));
    expect(byScope.get("REPO")?.logicalName).toBe("repo-skill");
    expect(byScope.get("USER")?.logicalName).toBe("user-skill");
    const kernel = resolveCodexAudit(poc, { forbiddenScopes: ["USER"] });
    expect(kernel.status).toBe("FAIL");
    const leaks = kernel.findings.filter((f) => f.id === "SCOPE_LEAK");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.detail).toContain("user-skill");
  });

  it("P1-R2-02: a name selector matching the shared file affects BOTH scope instances (blast radius 2)", () => {
    const base = path.join(FIXTURES, "r3-01-codex-cross-scope-merge");
    // The fixture ships config.toml disabling name "shared". Both
    // instances carry that logical name, so both must be DISABLED
    // and the blast finding must count 2 — the selector must not
    // silently hit only the first-scanned instance.
    const input = { ...sharedInput(base), configPath: path.join(base, "config.toml") };
    const poc = resolveCodexSkills(input);
    expect(poc.skills).toHaveLength(2);
    expect(poc.skills.every((s) => s.status === "DISABLED")).toBe(true);
    const blast = poc.findings.filter((f) => f.id === "NAME_SELECTOR_BLAST_RADIUS");
    expect(blast).toHaveLength(1);
    expect(blast[0]?.affectedCount).toBe(2);
    expect(poc.status).toBe("FAIL");
  });
});
