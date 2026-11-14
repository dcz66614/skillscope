/**
 * Codex skill-source resolution PoC (P023 T002, S0).
 *
 * Implements the Codex rules frozen in PROJECT_BOOK.md §4.3, from the
 * official Codex / ChatGPT Skills documentation:
 *
 *  - Project sources: `<dir>/.agents/skills` for every directory from the
 *    session cwd up to (and including) the repository root. Never above it.
 *  - User source: `$HOME/.agents/skills`.
 *  - Admin source: `/etc/codex/skills` (synthetic `adminRoot` in fixtures).
 *  - System source: Codex bundled skills (synthetic `bundled.json`
 *    inventory in fixtures; absent inventory means SYSTEM is UNKNOWN).
 *  - Symlinked skill directories are followed; several access paths that
 *    resolve to the same physical SKILL.md merge into ONE instance and
 *    keep the other paths as aliases — but only while the resolved path
 *    stays inside the source root. A symlink whose resolved SKILL.md
 *    escapes its source root is recorded as SYMLINK_OUTSIDE_ROOT
 *    (P1/UNKNOWN) and the audit is INCOMPLETE: the skill is never
 *    attributed to the containing scope and never silently dropped
 *    (FIX-T013R, P1-T013R-01).
 *  - `skills.config` entries select by `path` (absolute SKILL.md path,
 *    matches exactly one instance) or by `name` (matches every instance
 *    with that logical name). Later entries override earlier ones for the
 *    same matched instance ("last match wins").
 *  - `[skills.bundled].enabled = false` disables bundled system skills.
 *  - A name selector matching more than one instance raises
 *    NAME_SELECTOR_BLAST_RADIUS (P1) with the affected instance count.
 *  - An unreadable or invalid config is fail-closed: every discovered
 *    skill becomes UNKNOWN and the audit is INCOMPLETE with a
 *    FAIL_OPEN_CONFIG finding. Unknown is never reported as absent.
 *  - A source that cannot be enumerated (missing directory, missing
 *    inventory file) is reported in `unknownSources` with a
 *    SOURCE_NOT_ENUMERATED finding; it is never silently dropped from
 *    the coverage denominator. An UNREADABLE source (a skills
 *    directory, skill directory or SKILL.md the caller may not read)
 *    is reported the same way (FIX-R1, P0-R1-01): a permission denial
 *    is never converted to an empty skill set.
 *
 * Read-only: this module only reads files under the fixture layout roots
 * given in the input. It never writes, never touches a real Codex HOME,
 * never executes skill content, and never contacts the network.
 *
 * Identity (PROJECT_BOOK §4.2, contracts `isDistinctInstance`): an
 * instance is identified by source root + canonical path, never by
 * logical name alone. Two same-name files at different canonical paths
 * are two instances.
 *
 * Determinism: all output paths are relative (to the source root, or to
 * the layout root for canonical paths), results are sorted, and no
 * wall-clock time, random value, PID, or absolute path appears in the
 * output. The same fixture therefore always yields the same result.
 */

import { createHash } from "node:crypto";
import {
  existsSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative, resolve, sep } from "node:path";
import { parse as parseToml } from "smol-toml";
import { classifyPath } from "../../fsutil/index.js";

export type CodexScope = "REPO" | "USER" | "ADMIN" | "SYSTEM" | "PLUGIN";

export type CodexSkillStatus = "ELIGIBLE" | "DISABLED" | "UNKNOWN";

export interface CodexPocInput {
  caseId: string;
  /** Absolute path of the synthetic layout root (fixtures live under it). */
  layoutRoot: string;
  /** Absolute session working directory (must be inside repoRoot). */
  cwd: string;
  /** Absolute repository root; discovery never ascends above it. */
  repoRoot: string;
  /** Absolute synthetic $HOME. */
  homeRoot: string;
  /** Absolute synthetic /etc/codex. */
  adminRoot: string;
  /** Absolute path to config.toml; absent means "no config file". */
  configPath?: string;
  /** Absolute path to bundled.json inventory; absent means SYSTEM unknown. */
  bundledPath?: string;
  /** Absolute path to plugins.json inventory; absent means PLUGIN unknown. */
  pluginsPath?: string;
}

export interface CodexPocSkill {
  instanceId: string;
  sourceRootId: string;
  sourceScope: CodexScope;
  /** Path relative to the source root, forward slashes. */
  relativePath: string;
  /** Canonical (symlink-resolved) path relative to the layout root. */
  canonicalPath: string;
  logicalName: string;
  folderName: string;
  manifestName?: string;
  contentSha256: string;
  canonicalPathHash: string;
  status: CodexSkillStatus;
  /** Other source-root-relative paths resolving to the same SKILL.md. */
  aliases: string[];
  evidenceLevel: "STATIC_RULE";
}

export interface CodexPocFinding {
  id: string;
  severity: "P1" | "P2";
  sourceScope: string;
  status: "CONFIRMED" | "UNKNOWN";
  affectedCount?: number;
  detail?: string;
}

export interface CodexPocResult {
  schema: "skillscope.codex-poc-result/v1";
  caseId: string;
  status: "PASS" | "FAIL" | "INCOMPLETE";
  skills: CodexPocSkill[];
  findings: CodexPocFinding[];
  coverage: {
    enumeratedSources: number;
    requiredSources: number;
  };
  unknownSources: CodexScope[];
  configReadable: boolean;
}

const SCOPE_ORDER: readonly CodexScope[] = [
  "REPO",
  "USER",
  "ADMIN",
  "SYSTEM",
  "PLUGIN",
];

const REQUIRED_SOURCES: readonly CodexScope[] = SCOPE_ORDER;

function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function toPosix(path: string): string {
  return path.split(sep).join("/");
}

/** Path of `target` relative to `base`, forward slashes; null if it escapes. */
function relativePosix(base: string, target: string): string | null {
  const rel = relative(base, target);
  if (rel === "" || rel.startsWith(`..${sep}`) || rel === "..") {
    return null;
  }
  return toPosix(rel);
}

interface RawSkill {
  sourceRootId: string;
  sourceScope: CodexScope;
  /** Absolute path of the source root directory. */
  rootDir: string;
  /** Absolute real path of the SKILL.md file. */
  realSkillPath: string;
  /** Absolute path of the skill directory as discovered (may be a symlink). */
  discoveredDir: string;
  folderName: string;
}

/**
 * List the skill directories directly under `skillsDir`.
 *
 * FIX-R1 (P0-R1-01): a readdir failure is never silently converted to
 * an empty list. It returns `{ error: "unreadable" }` and the caller
 * marks the whole source UNKNOWN. A child whose stat fails with
 * ENOENT is a dangling symlink and is skipped (it names no skill);
 * any other stat failure means the child cannot be inspected, so the
 * whole source is unreadable too.
 */
function listSkillDirs(
  skillsDir: string,
): { dirs: string[] } | { error: "unreadable" } {
  let entries;
  try {
    entries = readdirSync(skillsDir, { withFileTypes: true });
  } catch {
    return { error: "unreadable" };
  }
  const dirs: string[] = [];
  for (const entry of entries) {
    // A skill is a directory (or a symlink to one) directly under the
    // skills directory; only immediate children count.
    if (!entry.isDirectory() && !entry.isSymbolicLink()) {
      continue;
    }
    const childPath = join(skillsDir, entry.name);
    try {
      const st = statSync(childPath);
      if (st.isDirectory()) {
        dirs.push(entry.name);
      }
    } catch (err) {
      if ((err as { code?: unknown } | null)?.code === "ENOENT") {
        // Dangling symlink: names no skill, skip it.
        continue;
      }
      // Unreadable child: the source cannot be fully enumerated.
      return { error: "unreadable" };
    }
  }
  dirs.sort();
  return { dirs };
}

/**
 * Does `dir` contain a readable SKILL.md file?
 *
 * "yes" — the file exists and is a file. "no" — no SKILL.md exists
 * (ENOENT: this directory is not a skill) or the path is not a file.
 * "unreadable" — the stat itself failed for a reason other than
 * absence (e.g. the directory cannot be traversed): the skill's
 * presence cannot be determined, so the source is unknown.
 */
function hasSkillFile(dir: string): "yes" | "no" | "unreadable" {
  try {
    return statSync(join(dir, "SKILL.md")).isFile() ? "yes" : "no";
  } catch (err) {
    return (err as { code?: unknown } | null)?.code === "ENOENT"
      ? "no"
      : "unreadable";
  }
}

/**
 * Minimal frontmatter reader for synthetic SKILL.md files. Extracts the
 * top-level `name:` scalar from a leading `---` block. Returns undefined
 * when there is no frontmatter or no name; the caller then falls back to
 * the folder name. This PoC deliberately does not take a YAML dependency:
 * full manifest parsing (with validation and INVALID status) belongs to
 * T005. The format accepted here is exactly the format used by the S0
 * fixtures: `---`, `name: <scalar>`, `description: <scalar>`, `---`.
 */
export function readManifestName(skillMdText: string): string | undefined {
  const lines = skillMdText.split("\n");
  if (lines[0] !== "---") {
    return undefined;
  }
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i];
    if (line === undefined) {
      return undefined;
    }
    if (line === "---") {
      return undefined;
    }
    const match = /^name:\s*(.+?)\s*$/.exec(line);
    if (match?.[1] !== undefined) {
      const raw = match[1];
      if (
        (raw.startsWith('"') && raw.endsWith('"')) ||
        (raw.startsWith("'") && raw.endsWith("'"))
      ) {
        return raw.slice(1, -1);
      }
      return raw;
    }
  }
  return undefined;
}

interface ConfigEntry {
  path?: string;
  name?: string;
  enabled: boolean;
}

interface ParsedConfig {
  entries: ConfigEntry[];
  bundledEnabled: boolean;
}

function parseConfigText(text: string): ParsedConfig {
  const parsed = parseToml(text) as Record<string, unknown>;
  const entries: ConfigEntry[] = [];
  const rawConfig = parsed["skills"];
  if (rawConfig !== undefined && typeof rawConfig === "object" && rawConfig !== null) {
    const skills = rawConfig as Record<string, unknown>;
    const rawEntries = skills["config"];
    if (rawEntries !== undefined) {
      if (!Array.isArray(rawEntries)) {
        throw new Error("skills.config must be an array of tables");
      }
      for (const raw of rawEntries) {
        if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
          throw new Error("each skills.config entry must be a table");
        }
        const entry = raw as Record<string, unknown>;
        const hasPath = typeof entry["path"] === "string";
        const hasName = typeof entry["name"] === "string";
        if (hasPath === hasName) {
          throw new Error("each skills.config entry needs exactly one of path / name");
        }
        const enabled = entry["enabled"];
        if (enabled !== undefined && typeof enabled !== "boolean") {
          throw new Error("skills.config enabled must be a boolean");
        }
        entries.push({
          ...(hasPath ? { path: entry["path"] as string } : {}),
          ...(hasName ? { name: entry["name"] as string } : {}),
          // An entry without `enabled` is treated as an explicit enable;
          // the S0 fixtures always spell it out.
          enabled: enabled === undefined ? true : (enabled as boolean),
        });
      }
    }
    const rawBundled = skills["bundled"];
    if (rawBundled !== undefined) {
      if (typeof rawBundled !== "object" || rawBundled === null || Array.isArray(rawBundled)) {
        throw new Error("skills.bundled must be a table");
      }
      const bundled = rawBundled as Record<string, unknown>;
      const enabled = bundled["enabled"];
      if (enabled !== undefined && typeof enabled !== "boolean") {
        throw new Error("skills.bundled.enabled must be a boolean");
      }
      return {
        entries,
        bundledEnabled: enabled === undefined ? true : (enabled as boolean),
      };
    }
  }
  return { entries, bundledEnabled: true };
}

interface CollectedSkill extends CodexPocSkill {
  /** Absolute real path of the SKILL.md file (internal only). */
  realPath: string;
}

/**
 * Resolve the effective Codex skill set for one synthetic fixture.
 * Purely read-only; throws only on programmer-level misuse (e.g. a
 * symlink loop inside a fixture) — never to hide an unknown source.
 */
export function resolveCodexSkills(input: CodexPocInput): CodexPocResult {
  const findings: CodexPocFinding[] = [];
  const unknownSources: CodexScope[] = [];
  const byRealPath = new Map<string, CollectedSkill>();
  // FIX-R2 (P1-R2-02): physical identity and source attribution are
  // separate. `byRealPath` is only the merge anchor for same-scope
  // access paths (several paths to one physical file within one
  // scope merge into one instance, c06). `byRealPathAndScope` tracks
  // the instance created for each (physical file, scope) pair, so a
  // file reachable from two scopes becomes two instances — never one
  // instance whose scope is decided by whichever scan ran first.
  const byRealPathAndScope = new Map<string, CollectedSkill>();
  const orderedSkills: CollectedSkill[] = [];

  const noteUnknown = (scope: CodexScope): void => {
    // A scope is reported unknown at most once, even when several
    // checks fail for it (e.g. an unreadable REPO skills dir plus an
    // unreadable repository root): duplicate findings would otherwise
    // pollute the finding list.
    if (unknownSources.includes(scope)) {
      return;
    }
    unknownSources.push(scope);
    findings.push({
      id: "SOURCE_NOT_ENUMERATED",
      severity: "P1",
      sourceScope: scope,
      status: "UNKNOWN",
      detail: `${scope} source could not be enumerated; absence is not evidence of absence`,
    });
  };

  /**
   * Add one skill directory as an instance. Returns false when the
   * directory cannot be read (realpath or SKILL.md read failure):
   * the caller marks the source UNKNOWN instead of letting the
   * failure crash the PoC or silently dropping the skill (FIX-R1).
   * A discovered path whose resolved SKILL.md escapes its source
   * root is recorded as SYMLINK_OUTSIDE_ROOT (P1/UNKNOWN) and the
   * audit is INCOMPLETE (FIX-T013R, P1-T013R-01): the skill is never
   * attributed to the containing scope and never silently dropped.
   * The target content is never read for an escaping path.
   * Physical identity and source attribution are separate (FIX-R2,
   * P1-R2-02): several access paths to one physical file within ONE
   * scope merge into one instance with aliases (c06); the same file
   * reachable from a second scope becomes a second instance for that
   * scope, so no scope's policy outcome is decided by whichever scan
   * ran first.
   */
  const addSkillDir = (
    sourceRootId: string,
    sourceScope: CodexScope,
    rootDir: string,
    skillDirAbs: string,
    folderName: string,
  ): boolean => {
    const skillMdAbs = join(skillDirAbs, "SKILL.md");
    // Resolve symlinks: several access paths to one physical file merge.
    let realSkillPath: string;
    try {
      realSkillPath = realpathSync(skillMdAbs);
    } catch {
      return false;
    }
    const existing = byRealPath.get(realSkillPath);
    // FIX-T013R (P1-T013R-01): the guard used to test only the
    // undiscovered path `skillMdAbs`, which by construction is always
    // inside the root — dead code that let an escaping symlink be
    // followed and attributed to the containing scope (a forbidden
    // scope could be laundered through a repo symlink). Test the
    // RESOLVED path. The two paths stay separate variables:
    // `relFromRoot` (the discovered path) still feeds `relativePath`
    // and the alias list, while only `relRealFromRoot` decides the
    // escape. Either being null is fail-closed as an escape (the
    // discovered case is unreachable from the current callers, which
    // always build skillMdAbs under rootDir).
    const relFromRoot = relativePosix(rootDir, skillMdAbs);
    const relRealFromRoot = relativePosix(rootDir, realSkillPath);
    if (relFromRoot === null || relRealFromRoot === null) {
      // Discovered path escapes its source root: the skill's true
      // source is unknown and its target content was never enumerated
      // as this scope. Record the escape (P1/UNKNOWN — the UNKNOWN
      // status makes the audit INCOMPLETE, mirroring
      // deriveAuditStatus) instead of attributing the skill here or
      // dropping it silently. The entry is handled, so the scan
      // itself stays "ok": the directory was fully enumerated.
      findings.push({
        id: "SYMLINK_OUTSIDE_ROOT",
        severity: "P1",
        sourceScope,
        status: "UNKNOWN",
        detail: `symlink '${relativePosix(input.layoutRoot, skillMdAbs) ?? toPosix(skillMdAbs)}' resolves outside its source root (${sourceScope}); its target content was never enumerated as this scope`,
      });
      return true;
    }
    // FIX-R2 (P1-R2-02): same physical file, same scope → merge as an
    // alias (c06 behaviour, unchanged). The scoped lookup runs before
    // the cross-scope branch below.
    const scopedKey = `${realSkillPath}\0${sourceScope}`;
    const scoped = byRealPathAndScope.get(scopedKey);
    if (scoped !== undefined) {
      if (!scoped.aliases.includes(relFromRoot)) {
        scoped.aliases.push(relFromRoot);
        scoped.aliases.sort();
      }
      return true;
    }
    if (existing !== undefined) {
      // FIX-R2 (P1-R2-02): the same physical file is reachable from a
      // second, DIFFERENT scope (e.g. repo_root == home_root, or two
      // source roots pointing at one directory). Do NOT merge into
      // `existing` and do NOT let the first-scanned scope decide the
      // policy outcome: a forbidden scope must not be swallowed by an
      // earlier allowed one, and the first instance's aliases must not
      // absorb a path that belongs to another scope. Fall through and
      // create a second instance for this scope below; the shared read
      // re-reads the same real path (identical content by
      // construction). Same-scope access paths are handled by the
      // scoped lookup above (c06 behaviour, unchanged).
    }
    let text: string;
    try {
      text = readFileSync(realSkillPath, "utf8");
    } catch {
      return false;
    }
    const manifestName = readManifestName(text);
    const canonicalPath = relativePosix(input.layoutRoot, realSkillPath);
    const skill: CollectedSkill = {
      instanceId: `codex:${sourceRootId}:${canonicalPath ?? toPosix(realSkillPath)}`,
      sourceRootId,
      sourceScope,
      relativePath: relFromRoot,
      canonicalPath: canonicalPath ?? toPosix(realSkillPath),
      logicalName: manifestName ?? folderName,
      folderName,
      ...(manifestName !== undefined ? { manifestName } : {}),
      contentSha256: createHash("sha256").update(text, "utf8").digest("hex"),
      canonicalPathHash: sha256Hex(canonicalPath ?? toPosix(realSkillPath)),
      status: "ELIGIBLE",
      aliases: [],
      evidenceLevel: "STATIC_RULE",
      realPath: realSkillPath,
    };
    byRealPathAndScope.set(scopedKey, skill);
    if (existing === undefined) {
      byRealPath.set(realSkillPath, skill);
    }
    orderedSkills.push(skill);
    return true;
  };

  /**
   * Scan one skills directory. Returns:
   *   "ok"        — the directory was fully enumerated (it may simply
   *                 contain no skills);
   *   "missing"   — the directory does not exist, or is not a
   *                 directory: a known absence, not unknown content;
   *   "unreadable" — the directory, one of its children, or one of
   *                 its SKILL.md files could not be read (FIX-R1):
   *                 the source is UNKNOWN, never an empty set.
   *
   * Readable skills found before a failure are still collected; the
   * failure only marks the source unknown, it does not discard what
   * was proven present.
   */
  const scanSkillsDir = (
    sourceRootId: string,
    sourceScope: CodexScope,
    rootDir: string,
    skillsDir: string,
  ): "ok" | "missing" | "unreadable" => {
    const access = classifyPath(skillsDir);
    if (access === "missing") {
      return "missing";
    }
    if (access === "unreadable") {
      return "unreadable";
    }
    let isDir = false;
    try {
      isDir = statSync(skillsDir).isDirectory();
    } catch {
      return "unreadable";
    }
    if (!isDir) {
      return "missing";
    }
    const listed = listSkillDirs(skillsDir);
    if ("error" in listed) {
      return "unreadable";
    }
    let failed = false;
    for (const folderName of listed.dirs) {
      const skillDirAbs = join(skillsDir, folderName);
      const hasFile = hasSkillFile(skillDirAbs);
      if (hasFile === "unreadable") {
        failed = true;
        continue;
      }
      if (hasFile === "yes") {
        if (
          !addSkillDir(sourceRootId, sourceScope, rootDir, skillDirAbs, folderName)
        ) {
          failed = true;
        }
      }
    }
    return failed ? "unreadable" : "ok";
  };

  // 1. Project sources: cwd up to (and including) repoRoot, never above.
  const repoRootAbs = resolve(input.repoRoot);
  const cwdAbs = resolve(input.cwd);
  const cwdRelToRepo = relative(repoRootAbs, cwdAbs);
  const cwdInsideRepo =
    cwdRelToRepo === "" || (!cwdRelToRepo.startsWith(`..${sep}`) && cwdRelToRepo !== "..");
  if (!cwdInsideRepo) {
    unknownSources.push("REPO");
    findings.push({
      id: "SOURCE_NOT_ENUMERATED",
      severity: "P1",
      sourceScope: "REPO",
      status: "UNKNOWN",
      detail: "cwd is outside the repository root; project sources cannot be resolved",
    });
  } else {
    let dir = cwdAbs;
    for (;;) {
      // FIX-R1 (P0-R1-01): the scan result used to be ignored here, so
      // an unreadable REPO skills directory silently yielded zero
      // skills and PASS. A missing directory is a known absence; an
      // unreadable one is UNKNOWN.
      if (
        scanSkillsDir("repo", "REPO", repoRootAbs, join(dir, ".agents", "skills")) ===
        "unreadable"
      ) {
        noteUnknown("REPO");
      }
      if (dir === repoRootAbs) {
        break;
      }
      const parent = resolve(dir, "..");
      if (parent === dir) {
        break;
      }
      dir = parent;
    }
    if (!existsSync(repoRootAbs)) {
      noteUnknown("REPO");
    }
  }

  // 2. User source: $HOME/.agents/skills.
  if (
    scanSkillsDir("user", "USER", resolve(input.homeRoot), join(input.homeRoot, ".agents", "skills")) !==
    "ok"
  ) {
    noteUnknown("USER");
  }

  // 3. Admin source: /etc/codex/skills (synthetic adminRoot).
  if (
    scanSkillsDir("admin", "ADMIN", resolve(input.adminRoot), join(input.adminRoot, "skills")) !==
    "ok"
  ) {
    noteUnknown("ADMIN");
  }

  // 4. System source: bundled inventory (synthetic bundled.json).
  let systemKnown = false;
  if (input.bundledPath !== undefined) {
    try {
      const raw = JSON.parse(readFileSync(input.bundledPath, "utf8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as Record<string, unknown>)["skills"])
      ) {
        const skills = (raw as Record<string, unknown>)["skills"] as Array<Record<string, unknown>>;
        systemKnown = true;
        for (const entry of skills) {
          const name = entry["name"];
          const content = entry["content"];
          if (typeof name !== "string" || typeof content !== "string") {
            continue;
          }
          const relativePath = `bundled/${name}/SKILL.md`;
          const contentSha256 = createHash("sha256").update(content, "utf8").digest("hex");
          const skill: CollectedSkill = {
            instanceId: `codex:system:${relativePath}`,
            sourceRootId: "system",
            sourceScope: "SYSTEM",
            relativePath,
            canonicalPath: relativePath,
            logicalName: name,
            folderName: name,
            contentSha256,
            canonicalPathHash: sha256Hex(relativePath),
            status: "ELIGIBLE",
            aliases: [],
            evidenceLevel: "STATIC_RULE",
            realPath: relativePath,
          };
          orderedSkills.push(skill);
        }
      }
    } catch {
      systemKnown = false;
    }
  }
  if (!systemKnown) {
    noteUnknown("SYSTEM");
  }

  // 5. Plugin source: account-installed plugin skills (synthetic plugins.json).
  let pluginKnown = false;
  if (input.pluginsPath !== undefined) {
    try {
      const raw = JSON.parse(readFileSync(input.pluginsPath, "utf8")) as unknown;
      if (
        typeof raw === "object" &&
        raw !== null &&
        Array.isArray((raw as Record<string, unknown>)["plugins"])
      ) {
        const plugins = (raw as Record<string, unknown>)["plugins"] as Array<Record<string, unknown>>;
        pluginKnown = true;
        for (const plugin of plugins) {
          const pluginId = plugin["id"];
          const skillNames = plugin["skills"];
          if (typeof pluginId !== "string" || !Array.isArray(skillNames)) {
            continue;
          }
          for (const skillName of skillNames) {
            if (typeof skillName !== "string") {
              continue;
            }
            const relativePath = `plugins/${pluginId}/${skillName}/SKILL.md`;
            // No local SKILL.md exists for a remote plugin skill; the
            // content hash is derived from the plugin descriptor instead.
            const contentSha256 = sha256Hex(`plugin:${pluginId}:${skillName}`);
            const skill: CollectedSkill = {
              instanceId: `codex:plugin:${relativePath}`,
              sourceRootId: "plugin",
              sourceScope: "PLUGIN",
              relativePath,
              canonicalPath: relativePath,
              logicalName: skillName,
              folderName: skillName,
              contentSha256,
              canonicalPathHash: sha256Hex(relativePath),
              status: "ELIGIBLE",
              aliases: [],
              evidenceLevel: "STATIC_RULE",
              realPath: relativePath,
            };
            orderedSkills.push(skill);
          }
        }
      }
    } catch {
      pluginKnown = false;
    }
  }
  if (!pluginKnown) {
    noteUnknown("PLUGIN");
  }

  // 6. Config: skills.config selectors + [skills.bundled].
  let configReadable = true;
  let config: ParsedConfig = { entries: [], bundledEnabled: true };
  if (input.configPath !== undefined) {
    try {
      const text = readFileSync(input.configPath, "utf8");
      config = parseConfigText(text);
    } catch {
      configReadable = false;
    }
  }

  if (!configReadable) {
    // Fail closed: without a readable config we cannot know which skills
    // are disabled, so no discovered skill may be reported ELIGIBLE.
    for (const skill of orderedSkills) {
      skill.status = "UNKNOWN";
    }
    findings.push({
      id: "FAIL_OPEN_CONFIG",
      severity: "P1",
      sourceScope: "GLOBAL",
      status: "CONFIRMED",
      detail: "skills.config could not be read or parsed; effective set is unknown (fail closed)",
    });
  } else {
    // Apply selectors in file order; later entries override earlier ones.
    const blastSeen = new Set<string>();
    for (const entry of config.entries) {
      let matched: CollectedSkill[];
      if (entry.path !== undefined) {
        const targetReal = (() => {
          try {
            return realpathSync(resolve(entry.path));
          } catch {
            return resolve(entry.path);
          }
        })();
        matched = orderedSkills.filter((skill) => skill.realPath === targetReal);
      } else {
        matched = orderedSkills.filter((skill) => skill.logicalName === entry.name);
        if (matched.length > 1 && !blastSeen.has(entry.name as string)) {
          blastSeen.add(entry.name as string);
          findings.push({
            id: "NAME_SELECTOR_BLAST_RADIUS",
            severity: "P1",
            sourceScope: "GLOBAL",
            status: "CONFIRMED",
            affectedCount: matched.length,
            detail: `name selector "${entry.name}" affects ${matched.length} distinct instances`,
          });
        }
      }
      for (const skill of matched) {
        skill.status = entry.enabled ? "ELIGIBLE" : "DISABLED";
      }
    }
    if (!config.bundledEnabled) {
      for (const skill of orderedSkills) {
        if (skill.sourceScope === "SYSTEM") {
          skill.status = "DISABLED";
        }
      }
    }
  }

  // 7. Deterministic ordering + status derivation.
  const scopeRank = (scope: CodexScope): number => SCOPE_ORDER.indexOf(scope);
  orderedSkills.sort((a, b) => {
    const byScope = scopeRank(a.sourceScope) - scopeRank(b.sourceScope);
    if (byScope !== 0) {
      return byScope;
    }
    return a.relativePath < b.relativePath ? -1 : a.relativePath > b.relativePath ? 1 : 0;
  });
  findings.sort((a, b) => {
    if (a.id !== b.id) {
      return a.id < b.id ? -1 : 1;
    }
    return a.sourceScope < b.sourceScope ? -1 : a.sourceScope > b.sourceScope ? 1 : 0;
  });
  unknownSources.sort((a, b) => scopeRank(a) - scopeRank(b));

  const skills: CodexPocSkill[] = orderedSkills.map((skill) => {
    const { realPath: _realPath, ...publicSkill } = skill;
    return publicSkill;
  });

  let status: CodexPocResult["status"];
  // FIX-T013R (P1-T013R-01): mirror deriveAuditStatus
  // (src/findings/index.ts) — an UNKNOWN finding (SYMLINK_OUTSIDE_ROOT)
  // means INCOMPLETE even when every source was enumerated.
  if (
    !configReadable ||
    unknownSources.length > 0 ||
    findings.some((finding) => finding.status === "UNKNOWN")
  ) {
    status = "INCOMPLETE";
  } else if (findings.some((finding) => finding.severity === "P1")) {
    status = "FAIL";
  } else {
    status = "PASS";
  }

  return {
    schema: "skillscope.codex-poc-result/v1",
    caseId: input.caseId,
    status,
    skills,
    findings,
    coverage: {
      enumeratedSources: REQUIRED_SOURCES.length - unknownSources.length,
      requiredSources: REQUIRED_SOURCES.length,
    },
    unknownSources,
    configReadable,
  };
}
