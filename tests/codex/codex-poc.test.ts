/**
 * T002 acceptance tests: Codex skill-source resolution PoC.
 *
 * Each case under tests/fixtures/s0/codex/<case-id>/ carries:
 *   - layout/        synthetic filesystem (repo / home / etc-codex / config / inventories)
 *   - input.json     PoC input; paths are relative to the case directory
 *   - expected.json  frozen expected result (reviewed field-by-field, see
 *                    03_evidence/T002/T002_REPORT.md §"Golden review")
 *
 * The test runs the PoC directly against the committed layout (the PoC
 * is strictly read-only, so the fixtures are never mutated). The layout
 * is NOT copied to a temp directory: copying would corrupt the relative
 * symlink in c06, because Node's fs.cp rewrites relative link targets to
 * absolute paths pointing back at the original tree. Only config.toml
 * gets a temp copy, to resolve the __CASE_DIR__ placeholder to the
 * absolute layout path. The test then compares the full result with
 * expected.json. No absolute path, timestamp, random value, or PID
 * appears in the comparison: canonical paths are layout-relative and
 * every list is deterministically sorted.
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  resolveCodexSkills,
  type CodexPocInput,
} from "../../src/adapters/codex/codex-poc.js";

const FIXTURE_ROOT = new URL(
  "../fixtures/s0/codex",
  import.meta.url,
).pathname;

const CASE_IDS = [
  "c01-repo-discovery",
  "c02-user-admin-system",
  "c03-path-selector",
  "c04-name-selector-blast",
  "c05-last-match-wins",
  "c06-symlink-alias",
  "c07-bundled-disabled",
  "c08-unreadable-config",
  "c09-name-selector-single",
  "c10-same-name-coexist",
  "c11-missing-user-source",
  "c12-missing-system-inventory",
  "c13-missing-plugin-inventory",
  "c14-name-blast-three-scopes",
  "c15-mixed-name-path-order",
  "c16-path-selector-wrong-target",
] as const;

interface CaseInput {
  schema: string;
  case_id: string;
  kind: string;
  seed: string;
  cwd: string;
  repo_root: string;
  home_root: string;
  admin_root: string;
  config_file: string | null;
  bundled_file: string | null;
  plugins_file: string | null;
}

async function runCase(caseId: string): Promise<unknown> {
  const caseDir = join(FIXTURE_ROOT, caseId);
  const layoutRoot = join(caseDir, "layout");
  // The PoC is strictly read-only, so it runs directly against the
  // committed layout: copying it would corrupt the relative symlink in
  // c06 (Node's fs.cp rewrites relative link targets to absolute paths
  // pointing back at the original tree, which would break alias merging
  // and leak an absolute path into the result). Only config.toml needs a
  // temp copy, to resolve the __CASE_DIR__ placeholder to an absolute path.
  const tmp = await mkdtemp(join(tmpdir(), "skillscope-t002-"));
  try {
    const rawInput = JSON.parse(
      await readFile(join(caseDir, "input.json"), "utf8"),
    ) as CaseInput;
    let configPath: string | undefined;
    if (rawInput.config_file !== null) {
      const sourceConfig = join(caseDir, rawInput.config_file);
      const text = await readFile(sourceConfig, "utf8");
      configPath = join(tmp, "config.toml");
      await writeFile(
        configPath,
        text.includes("__CASE_DIR__")
          ? text.replaceAll("__CASE_DIR__", layoutRoot)
          : text,
        "utf8",
      );
    }
    const resolveRel = (rel: string | null): string | undefined =>
      rel === null ? undefined : join(caseDir, rel);
    const input: CodexPocInput = {
      caseId: rawInput.case_id,
      layoutRoot,
      cwd: join(caseDir, rawInput.cwd),
      repoRoot: join(caseDir, rawInput.repo_root),
      homeRoot: join(caseDir, rawInput.home_root),
      adminRoot: join(caseDir, rawInput.admin_root),
      configPath,
      bundledPath: resolveRel(rawInput.bundled_file),
      pluginsPath: resolveRel(rawInput.plugins_file),
    };
    return resolveCodexSkills(input);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

describe("Codex PoC golden fixtures (S0)", () => {
  for (const caseId of CASE_IDS) {
    it(caseId, async () => {
      const expected = JSON.parse(
        await readFile(join(FIXTURE_ROOT, caseId, "expected.json"), "utf8"),
      ) as unknown;
      const actual = await runCase(caseId);
      expect(actual).toEqual(expected);
    });
  }
});

describe("Codex PoC rules (unit)", () => {
  it("name selector: later entry overrides earlier entry (last match wins)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "skillscope-t002-unit-"));
    try {
      const layout = join(tmp, "layout");
      const skillDir = join(layout, "repo", ".agents", "skills", "deploy");
      const { mkdir, writeFile: wf } = await import("node:fs/promises");
      await mkdir(skillDir, { recursive: true });
      await mkdir(join(layout, "home", ".agents", "skills"), { recursive: true });
      await mkdir(join(layout, "etc-codex", "skills"), { recursive: true });
      await wf(
        join(skillDir, "SKILL.md"),
        "---\nname: deploy\ndescription: Deploy skill.\n---\n\n# deploy\n\nDeploy.\n",
        "utf8",
      );
      await wf(join(layout, "bundled.json"), JSON.stringify({ skills: [] }), "utf8");
      await wf(join(layout, "plugins.json"), JSON.stringify({ plugins: [] }), "utf8");
      await wf(
        join(layout, "config.toml"),
        '[[skills.config]]\nname = "deploy"\nenabled = false\n\n[[skills.config]]\nname = "deploy"\nenabled = true\n',
        "utf8",
      );
      const result = resolveCodexSkills({
        caseId: "unit-name-last-wins",
        layoutRoot: layout,
        cwd: join(layout, "repo"),
        repoRoot: join(layout, "repo"),
        homeRoot: join(layout, "home"),
        adminRoot: join(layout, "etc-codex"),
        configPath: join(layout, "config.toml"),
        bundledPath: join(layout, "bundled.json"),
        pluginsPath: join(layout, "plugins.json"),
      });
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.status).toBe("ELIGIBLE");
      expect(result.skills[0]?.logicalName).toBe("deploy");
      // One instance only, so no blast-radius finding: the audit passes.
      expect(result.status).toBe("PASS");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("missing source roots are UNKNOWN, never silently absent", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "skillscope-t002-unit-"));
    try {
      const layout = join(tmp, "layout");
      const { mkdir, writeFile: wf } = await import("node:fs/promises");
      await mkdir(join(layout, "repo"), { recursive: true });
      await wf(join(layout, "bundled.json"), JSON.stringify({ skills: [] }), "utf8");
      await wf(join(layout, "plugins.json"), JSON.stringify({ plugins: [] }), "utf8");
      const result = resolveCodexSkills({
        caseId: "unit-missing-roots",
        layoutRoot: layout,
        cwd: join(layout, "repo"),
        repoRoot: join(layout, "repo"),
        homeRoot: join(layout, "no-such-home"),
        adminRoot: join(layout, "no-such-etc"),
        bundledPath: join(layout, "bundled.json"),
        pluginsPath: join(layout, "plugins.json"),
      });
      expect(result.unknownSources).toContain("USER");
      expect(result.unknownSources).toContain("ADMIN");
      expect(result.status).toBe("INCOMPLETE");
      expect(result.coverage).toEqual({ enumeratedSources: 3, requiredSources: 5 });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("skill without frontmatter name falls back to the folder name", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "skillscope-t002-unit-"));
    try {
      const layout = join(tmp, "layout");
      const skillDir = join(layout, "repo", ".agents", "skills", "plain");
      const { mkdir, writeFile: wf } = await import("node:fs/promises");
      await mkdir(skillDir, { recursive: true });
      await mkdir(join(layout, "home", ".agents", "skills"), { recursive: true });
      await mkdir(join(layout, "etc-codex", "skills"), { recursive: true });
      await wf(join(skillDir, "SKILL.md"), "# plain\n\nNo frontmatter at all.\n", "utf8");
      await wf(join(layout, "bundled.json"), JSON.stringify({ skills: [] }), "utf8");
      await wf(join(layout, "plugins.json"), JSON.stringify({ plugins: [] }), "utf8");
      const result = resolveCodexSkills({
        caseId: "unit-no-frontmatter",
        layoutRoot: layout,
        cwd: join(layout, "repo"),
        repoRoot: join(layout, "repo"),
        homeRoot: join(layout, "home"),
        adminRoot: join(layout, "etc-codex"),
        bundledPath: join(layout, "bundled.json"),
        pluginsPath: join(layout, "plugins.json"),
      });
      expect(result.skills).toHaveLength(1);
      expect(result.skills[0]?.logicalName).toBe("plain");
      expect(result.skills[0]?.manifestName).toBeUndefined();
      expect(result.status).toBe("PASS");
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });

  it("a skills path that is a file, not a directory, is a known absence (FIX-R1 tri-state)", async () => {
    const tmp = await mkdtemp(join(tmpdir(), "skillscope-t002-unit-"));
    try {
      const layout = join(tmp, "layout");
      const { mkdir, writeFile: wf } = await import("node:fs/promises");
      await mkdir(join(layout, "repo", ".agents"), { recursive: true });
      await mkdir(join(layout, "home", ".agents", "skills"), { recursive: true });
      await mkdir(join(layout, "etc-codex", "skills"), { recursive: true });
      // The REPO skills path exists but is a plain file: there is no
      // skills directory to enumerate, and that is known — not an
      // unreadable directory, so the scope must NOT be unknown.
      await wf(
        join(layout, "repo", ".agents", "skills"),
        "not a directory\n",
        "utf8",
      );
      await wf(join(layout, "bundled.json"), JSON.stringify({ skills: [] }), "utf8");
      await wf(join(layout, "plugins.json"), JSON.stringify({ plugins: [] }), "utf8");
      const result = resolveCodexSkills({
        caseId: "unit-skills-path-is-file",
        layoutRoot: layout,
        cwd: join(layout, "repo"),
        repoRoot: join(layout, "repo"),
        homeRoot: join(layout, "home"),
        adminRoot: join(layout, "etc-codex"),
        bundledPath: join(layout, "bundled.json"),
        pluginsPath: join(layout, "plugins.json"),
      });
      expect(result.unknownSources).not.toContain("REPO");
      expect(result.unknownSources).toEqual([]);
      expect(result.status).toBe("PASS");
      expect(result.coverage).toEqual({ enumeratedSources: 5, requiredSources: 5 });
    } finally {
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
