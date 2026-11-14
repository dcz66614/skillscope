/**
 * Symlink / bounded-discovery tests (P023 T005).
 *
 * Trees are built programmatically inside a fresh temp directory per
 * test (never copied: copying a tree rewrites relative symlink targets
 * to absolute paths, the T002 lesson). The runner is root, so chmod
 * tricks cannot make files unreadable — unreadability is instead
 * exercised with dangling symlinks and a directory named SKILL.md.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { discoverSkillRoot } from "../../src/discovery/discovery.js";
import { IdentityRegistry } from "../../src/identity/identity.js";
import { parseManifest } from "../../src/manifest/manifest.js";

const tmpRoots: string[] = [];

function makeRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-t005-"));
  tmpRoots.push(dir);
  return dir;
}

afterEach(() => {
  while (tmpRoots.length > 0) {
    const dir = tmpRoots.pop() as string;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

const SKILL = (name: string, extra = ""): string =>
  `---\nname: ${name}\ndescription: Synthetic skill ${name}.\n${extra}---\nDo the ${name} thing.\n`;

function writeSkill(dir: string, relDir: string, name: string, content?: string): void {
  const target = path.join(dir, relDir);
  fs.mkdirSync(target, { recursive: true });
  fs.writeFileSync(path.join(target, "SKILL.md"), content ?? SKILL(name));
}

function linkDir(dir: string, linkRel: string, targetAbs: string): void {
  fs.symlinkSync(targetAbs, path.join(dir, linkRel), "dir");
}

function linkFile(dir: string, linkRel: string, targetAbs: string): void {
  fs.symlinkSync(targetAbs, path.join(dir, linkRel), "file");
}

/** Register every discovered skill into a fresh registry (manifest name wins, else folder name). */
function registerAll(rootAbs: string, sourceRootId = "repo") {
  const discovered = discoverSkillRoot(rootAbs);
  const registry = new IdentityRegistry();
  for (const skill of discovered.skills) {
    const manifest = parseManifest(skill.content);
    registry.register({
      engine: "codex",
      sourceRootId,
      sourceScope: "REPO",
      relativePath: skill.relativePath,
      canonicalPath: skill.canonicalPath,
      logicalName: manifest.name ?? skill.folderName,
      folderName: skill.folderName,
      ...(manifest.name !== undefined ? { manifestName: manifest.name } : {}),
      contentSha256: skill.contentSha256,
      status: manifest.valid ? "ELIGIBLE" : "INVALID",
      evidenceLevel: "STATIC_RULE",
    });
  }
  return { discovered, registry };
}

describe("discoverSkillRoot: basic + nested", () => {
  it("finds skills at the top level and in nested directories", () => {
    const root = makeRoot();
    writeSkill(root, "release", "release");
    writeSkill(root, "a/b/c", "deep");
    const { skills, skipped } = discoverSkillRoot(root);
    expect(skipped).toEqual([]);
    expect(skills.map((s) => s.relativePath).sort()).toEqual([
      "a/b/c/SKILL.md",
      "release/SKILL.md",
    ]);
    expect(skills[0]?.depth).toBe(3);
  });

  it("ignores a bare SKILL.md directly under the root and other files", () => {
    const root = makeRoot();
    fs.writeFileSync(path.join(root, "SKILL.md"), SKILL("rootfile"));
    fs.writeFileSync(path.join(root, "notes.txt"), "hello");
    writeSkill(root, "real", "real");
    const { skills } = discoverSkillRoot(root);
    expect(skills.map((s) => s.relativePath)).toEqual(["real/SKILL.md"]);
  });

  it("missing root is reported, never treated as no skills", () => {
    const result = discoverSkillRoot(path.join(makeRoot(), "does-not-exist"));
    expect(result.skills).toEqual([]);
    expect(result.skipped).toEqual([
      expect.objectContaining({ reason: "ROOT_MISSING_OR_UNREADABLE" }),
    ]);
  });

  it("is deterministic: two runs give byte-identical canonical output", () => {
    const root = makeRoot();
    writeSkill(root, "release", "release");
    writeSkill(root, "deploy", "deploy");
    linkDir(root, "alias", path.join(root, "release"));
    const first = discoverSkillRoot(root);
    const second = discoverSkillRoot(root);
    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });
});

describe("discoverSkillRoot: symlinks", () => {
  it("merges two access paths to one file (alias) via the registry", () => {
    const root = makeRoot();
    writeSkill(root, "target", "target");
    linkDir(root, "alias", path.join(root, "target"));
    const { discovered, registry } = registerAll(root);
    expect(discovered.skills).toHaveLength(2);
    expect(discovered.skipped).toEqual([]);
    expect(registry.size).toBe(1);
    const inst = registry.instances()[0];
    expect(inst?.relativePath).toBe("alias/SKILL.md");
    expect(inst?.aliases).toEqual(["target/SKILL.md"]);
    // Primary path is the first in sorted traversal order.
    expect(inst?.logicalName).toBe("target");
  });

  it("a symlink loop terminates and is recorded, not thrown", () => {
    const root = makeRoot();
    writeSkill(root, "loop", "loop");
    // loop/back -> root: descending into it would revisit the root.
    linkDir(root, "loop/back", root);
    const start = Date.now();
    const { skills, skipped, stats } = discoverSkillRoot(root);
    expect(Date.now() - start).toBeLessThan(5000);
    expect(skills.map((s) => s.relativePath)).toEqual(["loop/SKILL.md"]);
    expect(skipped).toContainEqual(
      expect.objectContaining({ reason: "SYMLINK_LOOP" }),
    );
    expect(stats.stoppedByLimit).toBe(false);
  });

  it("mutual symlink loop between two directories terminates", () => {
    const root = makeRoot();
    writeSkill(root, "a", "a-skill");
    writeSkill(root, "b", "b-skill");
    linkDir(root, "a/to-b", path.join(root, "b"));
    linkDir(root, "b/to-a", path.join(root, "a"));
    const { discovered, registry } = registerAll(root);
    // Both real skill files are found exactly once as physical files,
    // reached via several access paths; the loop is recorded, not thrown.
    expect(
      new Set(discovered.skills.map((s) => s.canonicalPath)).size,
    ).toBe(2);
    expect(
      discovered.skipped.filter((s) => s.reason === "SYMLINK_LOOP").length,
    ).toBeGreaterThanOrEqual(1);
    expect(registry.size).toBe(2);
    const aliasCount = registry
      .instances()
      .reduce((sum, inst) => sum + inst.aliases.length, 0);
    expect(aliasCount).toBe(2);
  });

  it("a symlink escaping the root is never followed and its content never appears", () => {
    const root = makeRoot();
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-outside-"));
    tmpRoots.push(outside);
    writeSkill(outside, "secret", "secret");
    writeSkill(root, "real", "real");
    linkDir(root, "esc", path.join(outside, "secret"));
    const { discovered, registry } = registerAll(root);
    expect(discovered.skipped).toContainEqual(
      expect.objectContaining({ reason: "SYMLINK_OUTSIDE_ROOT" }),
    );
    expect(registry.instances().map((i) => i.logicalName)).toEqual(["real"]);
    expect(JSON.stringify(discovered)).not.toContain("secret");
  });

  it("a dangling symlink is recorded, not followed", () => {
    const root = makeRoot();
    writeSkill(root, "real", "real");
    linkDir(root, "ghost", path.join(root, "no-such-dir"));
    const { skills, skipped } = discoverSkillRoot(root);
    expect(skills.map((s) => s.relativePath)).toEqual(["real/SKILL.md"]);
    expect(skipped).toContainEqual(
      expect.objectContaining({ reason: "CANONICAL_PATH_UNRESOLVABLE" }),
    );
  });

  it("a directory named SKILL.md is recorded, not descended into", () => {
    const root = makeRoot();
    fs.mkdirSync(path.join(root, "weird", "SKILL.md"), { recursive: true });
    fs.writeFileSync(
      path.join(root, "weird", "SKILL.md", "inner.txt"),
      "not a skill",
    );
    writeSkill(root, "real", "real");
    const { skills, skipped } = discoverSkillRoot(root);
    expect(skills.map((s) => s.relativePath)).toEqual(["real/SKILL.md"]);
    expect(skipped).toContainEqual(
      expect.objectContaining({ reason: "SKILL_MD_UNREADABLE" }),
    );
  });

  it("a symlinked SKILL.md file itself is followed to its real file", () => {
    const root = makeRoot();
    writeSkill(root, "real", "real");
    fs.mkdirSync(path.join(root, "linked"));
    linkFile(
      root,
      "linked/SKILL.md",
      path.join(root, "real", "SKILL.md"),
    );
    const { discovered, registry } = registerAll(root);
    expect(discovered.skills).toHaveLength(2);
    expect(registry.size).toBe(1);
    expect(registry.instances()[0]?.aliases).toEqual(["real/SKILL.md"]);
  });
});

describe("discoverSkillRoot: bounds", () => {
  it("enforces maxDepth and records pruned directories", () => {
    const root = makeRoot();
    writeSkill(root, "d1/d2/d3/d4/d5/d6/d7/d8/d9/d10/d11", "very-deep");
    writeSkill(root, "d1/d2/d3", "ok-deep");
    const { skills, skipped } = discoverSkillRoot(root, { maxDepth: 3 });
    expect(skills.map((s) => s.relativePath)).toEqual(["d1/d2/d3/SKILL.md"]);
    expect(skipped).toContainEqual(
      expect.objectContaining({ reason: "DEPTH_LIMIT" }),
    );
  });

  it("enforces maxEntries and stops", () => {
    const root = makeRoot();
    for (let i = 0; i < 20; i += 1) {
      writeSkill(root, `s${String(i).padStart(2, "0")}`, `skill-${i}`);
    }
    const { skills, skipped, stats } = discoverSkillRoot(root, {
      maxEntries: 5,
    });
    expect(stats.stoppedByLimit).toBe(true);
    expect(skipped).toContainEqual(
      expect.objectContaining({ reason: "ENTRY_LIMIT" }),
    );
    expect(skills.length).toBeLessThanOrEqual(5);
  });

  it("refuses oversize SKILL.md files", () => {
    const root = makeRoot();
    const big = `---\nname: big\ndescription: big.\n---\n${"x".repeat(1024 * 1024 + 1)}\n`;
    writeSkill(root, "big", "big", big);
    writeSkill(root, "small", "small");
    const { skills, skipped } = discoverSkillRoot(root);
    expect(skills.map((s) => s.relativePath)).toEqual(["small/SKILL.md"]);
    expect(skipped).toContainEqual(
      expect.objectContaining({ reason: "SKILL_MD_TOO_LARGE" }),
    );
  });
});

describe("discoverSkillRoot: case and content identity", () => {
  it("Deploy and deploy are distinct instances on this filesystem", () => {
    const root = makeRoot();
    writeSkill(root, "Deploy", "deploy");
    writeSkill(root, "deploy", "deploy", SKILL("deploy", "# second copy\n"));
    const { registry } = registerAll(root);
    expect(registry.size).toBe(2);
    expect(registry.sameNameCollisions()).toHaveLength(1);
  });

  it("same bytes at different paths stay two instances", () => {
    const root = makeRoot();
    const content = SKILL("shared");
    writeSkill(root, "copy-a", "copy-a", content);
    writeSkill(root, "copy-b", "copy-b", content);
    const { registry } = registerAll(root);
    expect(registry.size).toBe(2);
    expect(registry.duplicateContentGroups()).toHaveLength(1);
  });
});
