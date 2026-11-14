#!/usr/bin/env node
/**
 * Deterministic synthetic Codex fixture generator (P023 T012, S4).
 *
 * `generatePerfFixture(rootDir, { count })` writes a self-contained
 * Codex fixture tree with exactly `count` skill instances:
 *
 *   rootDir/profile.json            — skillscope.profile/v1, codex,
 *                                     permissive policy (all scopes
 *                                     allowed, no forbidden names)
 *   rootDir/repo/.agents/skills/skill-000…   (60% of count)
 *   rootDir/home/.agents/skills/skill-…      (30% of count)
 *   rootDir/admin/skills/skill-…             (10% of count)
 *   rootDir/bundled.json / plugins.json       — empty SYSTEM / PLUGIN
 *
 * Every skill is a directory with a SKILL.md whose frontmatter name
 * is unique (`skill-NNN`), so the audit yields `count` ELIGIBLE
 * instances and status PASS. The generator is fully deterministic:
 * no timestamps, no randomness, no environment input — the same
 * inputs always produce byte-identical files (verified by the
 * performance runner, which audits the fixture twice and compares
 * canonical hashes).
 *
 * Usable as a module (`import { generatePerfFixture }`) or as a
 * script (`node scripts/perf-fixture.mjs <destDir> [count]`).
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_COUNT = 500;

/** Fixed SKILL.md body (identical for every skill except name/number). */
function skillMd(index) {
  const name = `skill-${String(index).padStart(3, "0")}`;
  return [
    "---",
    `name: ${name}`,
    `description: Synthetic performance fixture skill ${index}.`,
    "---",
    "",
    `# Skill ${index}`,
    "",
    "Synthetic skill for performance measurement. Fixed content,",
    "no real behaviour, never executed.",
    "",
  ].join("\n");
}

function profileJson() {
  return {
    cwd: "./repo",
    engine: "codex",
    home_root: "./home",
    policy: {
      allowed_scopes: ["REPO", "USER", "ADMIN", "SYSTEM"],
      forbidden_names: [],
      forbidden_scopes: [],
    },
    profile_id: "codex-perf-500",
    repo_root: "./repo",
    schema: "skillscope.profile/v1",
    source_roots: [
      {
        engine: "codex",
        evidenceLevel: "STATIC_RULE",
        path: "./repo/.agents/skills",
        required: true,
        scope: "REPO",
        sourceRootId: "repo",
      },
      {
        engine: "codex",
        evidenceLevel: "STATIC_RULE",
        path: "./home/.agents/skills",
        required: true,
        scope: "USER",
        sourceRootId: "user",
      },
      {
        engine: "codex",
        evidenceLevel: "STATIC_RULE",
        path: "./admin/skills",
        required: true,
        scope: "ADMIN",
        sourceRootId: "admin",
      },
      {
        engine: "codex",
        evidenceLevel: "STATIC_RULE",
        path: "./bundled.json",
        required: true,
        scope: "SYSTEM",
        sourceRootId: "system",
      },
      {
        engine: "codex",
        evidenceLevel: "STATIC_RULE",
        path: "./plugins.json",
        required: true,
        scope: "PLUGIN",
        sourceRootId: "plugin",
      },
    ],
  };
}

/**
 * Generate the fixture tree under `rootDir` (created if needed).
 * Returns `{ count, files }` where `files` is the sorted list of
 * relative paths written. Throws on invalid count.
 */
export function generatePerfFixture(rootDir, options = {}) {
  const count = options.count ?? DEFAULT_COUNT;
  if (!Number.isInteger(count) || count < 1) {
    throw new Error(`generatePerfFixture: count must be a positive integer, got ${count}`);
  }
  const repoCount = Math.floor(count * 0.6);
  const homeCount = Math.floor(count * 0.3);
  const adminCount = count - repoCount - homeCount;
  const files = [];
  const write = (rel, content) => {
    const full = path.join(rootDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, "utf8");
    files.push(rel);
  };
  let index = 0;
  const putSkills = (dir, n) => {
    for (let i = 0; i < n; i += 1, index += 1) {
      const name = `skill-${String(index).padStart(3, "0")}`;
      write(path.join(dir, name, "SKILL.md"), skillMd(index));
    }
  };
  putSkills(path.join("repo", ".agents", "skills"), repoCount);
  putSkills(path.join("home", ".agents", "skills"), homeCount);
  putSkills(path.join("admin", "skills"), adminCount);
  write("bundled.json", '{"skills":[]}');
  write("plugins.json", '{"plugins":[]}');
  write("profile.json", `${JSON.stringify(profileJson(), null, 2)}\n`);
  files.sort();
  return { count, files };
}

const isMain =
  process.argv[1] !== undefined &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dest = process.argv[2];
  if (dest === undefined) {
    console.error("usage: node scripts/perf-fixture.mjs <destDir> [count]");
    process.exit(3);
  }
  const count = process.argv[3] === undefined ? DEFAULT_COUNT : Number(process.argv[3]);
  const result = generatePerfFixture(path.resolve(dest), { count });
  console.log(`perf fixture: ${result.count} skills, ${result.files.length} files → ${dest}`);
}
