/**
 * Bounded read-only skill-directory discovery (P023 T005, S1).
 *
 * Walks one skill root and reports every SKILL.md file found in a
 * subdirectory, with the traversal bounded so a hostile or damaged tree
 * can never escape the authorised root, loop forever, or run away:
 *
 *  - Depth bound: directories deeper than `maxDepth` below the root are
 *    not descended into (recorded as DEPTH_LIMIT).
 *  - Entry bound: at most `maxEntries` filesystem entries are visited;
 *    the scan then stops (recorded as ENTRY_LIMIT).
 *  - File-size bound: SKILL.md files larger than `maxSkillFileBytes`
 *    are not read (recorded as SKILL_MD_TOO_LARGE).
 *  - Symlink loops: a directory whose real path is already an ancestor
 *    on the current recursion stack is not descended into (recorded as
 *    SYMLINK_LOOP). This replaces the PoC loud-fail (`realpathSync`
 *    throwing in the Codex adapter, T002) with a controlled, recorded
 *    skip — the scan terminates and the rest of the tree is still
 *    enumerated. Python's `os.path.realpath` never throws on loops,
 *    so the Oracle and the production scanner now agree on looped
 *    trees instead of diverging (T004 legacy note).
 *  - Symlink escape: a link whose real path leaves the scan root is
 *    never followed and its target is never read (recorded as
 *    SYMLINK_OUTSIDE_ROOT). The target content hash therefore never
 *    appears in the result.
 *  - Path traversal: any computed relative path escaping the root is
 *    dropped (recorded as PATH_TRAVERSAL).
 *  - Unreadable entries are reported in `skipped`, never silently
 *    dropped. A missing/unreadable root yields ROOT_MISSING_OR_UNREADABLE.
 *  - A directory literally named `SKILL.md` is not a skill file; it is
 *    recorded as SKILL_MD_UNREADABLE and not descended into.
 *  - A bare SKILL.md file directly under the root is not a skill: a
 *    skill is a subdirectory containing a SKILL.md file (same rule as
 *    the S0 PoC scanners).
 *
 * The module is purely read-only and deterministic: entries are visited
 * in sorted order, all output paths are POSIX and relative to the scan
 * root, and no wall-clock time, random value, PID or absolute path
 * appears in `skipped` paths. `absolutePath` / `canonicalPath` of a
 * discovered skill are absolute by nature (callers must desensitise
 * them before export, PROJECT_BOOK §4.2 rule 5); the registry key uses
 * the canonical path, the report uses the relative path.
 *
 * Discovery does NOT parse manifests and does NOT merge aliases: it
 * reports one entry per access path and lets `IdentityRegistry`
 * (src/identity) merge entries that resolve to the same physical file.
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export const DEFAULT_MAX_DEPTH = 10;
export const DEFAULT_MAX_ENTRIES = 10_000;
export const MAX_SKILL_FILE_BYTES = 1024 * 1024;

export type SkipReason =
  | "ROOT_MISSING_OR_UNREADABLE"
  | "DIR_UNREADABLE"
  | "SKILL_MD_UNREADABLE"
  | "SKILL_MD_TOO_LARGE"
  | "CANONICAL_PATH_UNRESOLVABLE"
  | "SYMLINK_LOOP"
  | "SYMLINK_OUTSIDE_ROOT"
  | "DEPTH_LIMIT"
  | "ENTRY_LIMIT"
  | "PATH_TRAVERSAL";

export interface DiscoveredSkill {
  /** Name of the directory directly containing this SKILL.md. */
  folderName: string;
  /** POSIX path relative to the scan root, e.g. "a/b/SKILL.md". */
  relativePath: string;
  /** Absolute access path of the SKILL.md file (may run through symlinks). */
  absolutePath: string;
  /** Symlink-resolved real path of the SKILL.md file (absolute). */
  canonicalPath: string;
  /** SHA-256 of the raw file bytes. */
  contentSha256: string;
  /** File content decoded as UTF-8 (for manifest parsing by the caller). */
  content: string;
  /** Directory depth of the containing folder below the root (root = 0). */
  depth: number;
}

export interface SkippedEntry {
  /** POSIX path relative to the scan root, or the path as given. */
  path: string;
  reason: SkipReason;
  /**
   * Errno string (e.g. "ENOENT", "EACCES") when the skip came from a
   * failed filesystem operation (FIX-R1). Absent for structural skips
   * (symlink loop / escape, depth / entry limits, a directory
   * literally named SKILL.md). See `isContentUnknownSkip` in
   * src/fsutil: only an errno other than ENOENT means unknown
   * content.
   */
  code?: string;
}

export interface DiscoveryStats {
  entriesVisited: number;
  dirsVisited: number;
  filesRead: number;
  maxDepthReached: number;
  stoppedByLimit: boolean;
}

export interface DiscoveryResult {
  skills: DiscoveredSkill[];
  skipped: SkippedEntry[];
  stats: DiscoveryStats;
}

export interface DiscoverOptions {
  maxDepth?: number;
  maxEntries?: number;
  maxSkillFileBytes?: number;
}

function toPosix(p: string): string {
  return p.split(path.sep).join("/");
}

function sha256HexBytes(buf: Buffer): string {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * Scan one skill root. `rootAbs` is resolved to its real path first;
 * that real path is the escape boundary for the whole walk.
 */
export function discoverSkillRoot(
  rootAbs: string,
  options: DiscoverOptions = {},
): DiscoveryResult {
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
  const maxEntries = options.maxEntries ?? DEFAULT_MAX_ENTRIES;
  const maxSkillFileBytes =
    options.maxSkillFileBytes ?? MAX_SKILL_FILE_BYTES;

  const skills: DiscoveredSkill[] = [];
  const skipped: SkippedEntry[] = [];
  const stats: DiscoveryStats = {
    entriesVisited: 0,
    dirsVisited: 0,
    filesRead: 0,
    maxDepthReached: 0,
    stoppedByLimit: false,
  };

  let rootReal: string;
  try {
    const st = fs.statSync(rootAbs);
    if (!st.isDirectory()) {
      throw new Error("not a directory");
    }
    rootReal = fs.realpathSync(rootAbs);
  } catch (err) {
    skipped.push({
      path: toPosix(rootAbs),
      reason: "ROOT_MISSING_OR_UNREADABLE",
      // FIX-R1: record the errno so callers can tell a missing root
      // from an unreadable one. A non-Error throw (the "not a
      // directory" case above) carries no errno.
      ...(err instanceof Error &&
      typeof (err as unknown as { code?: unknown }).code === "string"
        ? { code: (err as unknown as { code: string }).code }
        : {}),
    });
    return { skills, skipped, stats };
  }

  /**
   * POSIX path relative to the scan root; null when it escapes.
   * Returns "" for the root itself (a symlink to the root is inside
   * the root — it is a loop, not an escape).
   */
  const relativePosix = (abs: string): string | null => {
    const rel = path.relative(rootReal, abs);
    if (
      rel === ".." ||
      rel.startsWith(`..${path.sep}`) ||
      path.isAbsolute(rel)
    ) {
      return null;
    }
    return toPosix(rel);
  };

  const isInside = (abs: string): boolean => relativePosix(abs) !== null;

  const walk = (
    dirAbs: string,
    dirRel: string,
    depth: number,
    ancestors: ReadonlySet<string>,
  ): void => {
    if (stats.stoppedByLimit) {
      return;
    }
    stats.dirsVisited += 1;
    stats.maxDepthReached = Math.max(stats.maxDepthReached, depth);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dirAbs, { withFileTypes: true });
    } catch (err) {
      skipped.push({
        path: dirRel === "" ? "." : dirRel,
        reason: "DIR_UNREADABLE",
        // FIX-R1: the errno distinguishes a directory that vanished
        // mid-scan (ENOENT) from one that cannot be listed (EACCES).
        ...(typeof (err as { code?: unknown } | null)?.code === "string"
          ? { code: (err as { code: string }).code }
          : { code: "UNKNOWN" }),
      });
      return;
    }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      if (stats.stoppedByLimit) {
        return;
      }
      if (stats.entriesVisited >= maxEntries) {
        stats.stoppedByLimit = true;
        skipped.push({
          path: dirRel === "" ? "." : dirRel,
          reason: "ENTRY_LIMIT",
        });
        return;
      }
      stats.entriesVisited += 1;
      const entryAbs = path.join(dirAbs, entry.name);
      const entryRel = dirRel === "" ? entry.name : `${dirRel}/${entry.name}`;
      const entryRelPosix = toPosix(entryRel);

      let entryReal: string;
      try {
        entryReal = fs.realpathSync(entryAbs);
      } catch {
        // Dangling symlink (or an unreadable target): never follow it.
        skipped.push({
          path: entryRelPosix,
          reason: "CANONICAL_PATH_UNRESOLVABLE",
        });
        continue;
      }
      if (!isInside(entryReal)) {
        skipped.push({ path: entryRelPosix, reason: "SYMLINK_OUTSIDE_ROOT" });
        continue;
      }

      let stat: fs.Stats;
      try {
        stat = fs.statSync(entryAbs);
      } catch {
        skipped.push({ path: entryRelPosix, reason: "DIR_UNREADABLE" });
        continue;
      }

      if (stat.isDirectory()) {
        if (entry.name === "SKILL.md") {
          // A directory named SKILL.md is not a skill file.
          skipped.push({ path: entryRelPosix, reason: "SKILL_MD_UNREADABLE" });
          continue;
        }
        if (depth + 1 > maxDepth) {
          skipped.push({ path: entryRelPosix, reason: "DEPTH_LIMIT" });
          continue;
        }
        if (ancestors.has(entryReal)) {
          skipped.push({ path: entryRelPosix, reason: "SYMLINK_LOOP" });
          continue;
        }
        const nextAncestors = new Set(ancestors);
        nextAncestors.add(entryReal);
        walk(entryAbs, entryRelPosix, depth + 1, nextAncestors);
        continue;
      }

      if (!stat.isFile() || entry.name !== "SKILL.md") {
        continue;
      }
      if (dirRel === "") {
        // A bare SKILL.md directly under the root is not a skill: a
        // skill is a subdirectory containing a SKILL.md file.
        continue;
      }
      if (stat.size > maxSkillFileBytes) {
        skipped.push({ path: entryRelPosix, reason: "SKILL_MD_TOO_LARGE" });
        continue;
      }
      let buf: Buffer;
      try {
        buf = fs.readFileSync(entryAbs);
      } catch (err) {
        // FIX-R1: this entry was observed as a file named SKILL.md, so
        // a read failure means its content is unknown (not "no skill
        // here"). Record the errno for the kernel's fail-closed rule.
        skipped.push({
          path: entryRelPosix,
          reason: "SKILL_MD_UNREADABLE",
          ...(typeof (err as { code?: unknown } | null)?.code === "string"
            ? { code: (err as { code: string }).code }
            : { code: "UNKNOWN" }),
        });
        continue;
      }
      const folderName = path.basename(dirAbs);
      const rel = relativePosix(entryAbs);
      if (rel === null || rel === "") {
        skipped.push({ path: entryRelPosix, reason: "PATH_TRAVERSAL" });
        continue;
      }
      stats.filesRead += 1;
      skills.push({
        folderName,
        relativePath: rel,
        absolutePath: entryAbs,
        canonicalPath: entryReal,
        contentSha256: sha256HexBytes(buf),
        content: buf.toString("utf8"),
        depth,
      });
    }
  };

  walk(rootReal, "", 0, new Set([rootReal]));

  skills.sort((a, b) =>
    a.relativePath < b.relativePath
      ? -1
      : a.relativePath > b.relativePath
        ? 1
        : 0,
  );
  return { skills, skipped, stats };
}
