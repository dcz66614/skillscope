/**
 * Shared read-only skill-directory scanning for the S0 host adapters
 * (T003). PoC-grade: scans one level of subdirectories under a skill root,
 * parses only the `name` / `description` frontmatter fields, and derives
 * instance identity from the canonical (real) path + content SHA-256,
 * never from the logical name alone (PROJECT_BOOK §4.2).
 *
 * Full manifest parsing, nested discovery and symlink policy land in
 * T005; this helper only needs to be honest about what it can and cannot
 * prove: unreadable entries are reported in `skipped`, never silently
 * dropped, and a missing root is reported, never treated as "no skills".
 * A skip caused by a failed read carries the errno in `code`, so the
 * caller can tell a subdirectory with no SKILL.md (ENOENT: not a skill)
 * from a SKILL.md that exists but cannot be read (EACCES and friends:
 * unknown content — FIX-R1, P0-R1-02).
 */

import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

export interface FrontmatterResult {
  name?: string;
  description?: string;
  valid: boolean;
  errors: string[];
}

const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
const MAX_SKILL_NAME_LENGTH = 64;

/**
 * Minimal SKILL.md frontmatter parser (PoC-grade).
 * Requires the Agent Skills frontmatter (`name` + `description`) and a
 * well-formed `---` fence. Other keys are ignored. Returns `valid: false`
 * with machine-readable errors instead of throwing, so the caller can
 * record an INVALID_MANIFEST finding.
 */
export function parseFrontmatter(content: string): FrontmatterResult {
  const errors: string[] = [];
  const lines = content.split("\n");
  const first = lines[0];
  if (first === undefined || first.trim() !== "---") {
    return { valid: false, errors: ["missing-frontmatter-fence"] };
  }
  const fields = new Map<string, string>();
  let closed = false;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === "---") {
      closed = true;
      break;
    }
    if (line.trim() === "" || line.trim().startsWith("#")) {
      continue;
    }
    const colon = line.indexOf(":");
    if (colon < 0) {
      errors.push("malformed-frontmatter-line");
      continue;
    }
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (key.length > 0) {
      fields.set(key, value);
    }
  }
  if (!closed) {
    errors.push("unterminated-frontmatter-fence");
  }
  const name = fields.get("name");
  const description = fields.get("description");
  if (name === undefined || name.length === 0) {
    errors.push("missing-name");
  } else if (
    name.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_PATTERN.test(name)
  ) {
    errors.push("invalid-name");
  }
  if (description === undefined || description.length === 0) {
    errors.push("missing-description");
  }
  return {
    ...(name !== undefined ? { name } : {}),
    ...(description !== undefined ? { description } : {}),
    valid: errors.length === 0,
    errors,
  };
}

/** One SKILL.md file found under a skill root. */
export interface ScannedSkill {
  folderName: string;
  /** Path of the SKILL.md relative to the scanned root, e.g. "release/SKILL.md". */
  relativePath: string;
  absolutePath: string;
  /** Real (symlink-resolved) path of the SKILL.md file: canonical identity. */
  canonicalPath: string;
  contentSha256: string;
  /** Frontmatter `name` when present, otherwise null. */
  manifestName: string | null;
  manifestValid: boolean;
  manifestErrors: string[];
  /** Other relative paths that resolve to the same physical file. */
  aliases: string[];
}

export interface SkippedEntry {
  path: string;
  reason: string;
  /**
   * Errno string (e.g. "ENOENT", "EACCES") when the skip came from a
   * failed filesystem operation (FIX-R1). Absent for structural skips
   * that are not errors. Callers must not treat every
   * SKILL_MD_UNREADABLE as unknown content: code "ENOENT" means the
   * subdirectory simply has no SKILL.md (it is a container directory
   * such as Claude's `synced/`, not a skill); any other code means
   * the file exists but could not be read. See
   * `isContentUnknownSkip` in src/fsutil.
   */
  code?: string;
}

export interface ScanResult {
  skills: ScannedSkill[];
  skipped: SkippedEntry[];
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/**
 * Scan one skill root: every immediate subdirectory (or symlink to one)
 * containing a SKILL.md file becomes one candidate instance. Entries that
 * resolve to the same physical file are merged into a single instance
 * with the extra paths recorded as `aliases` (PROJECT_BOOK §4.2 rule 3).
 * Unreadable entries are reported in `skipped`, never silently dropped.
 * A missing root yields an empty skill list plus a ROOT_MISSING skip.
 */
export function scanSkillRoot(rootAbs: string): ScanResult {
  const skills: ScannedSkill[] = [];
  const skipped: SkippedEntry[] = [];
  const byCanonical = new Map<string, ScannedSkill>();

  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(rootAbs, { withFileTypes: true });
  } catch (err) {
    // FIX-R1: record the errno with the root skip, same as the
    // SKILL.md read below. Callers (Claude PoC's accountSyncDir
    // check) must tell a missing root (ENOENT: known absence) from
    // an unreadable one (EACCES and friends: unknown content).
    const code =
      typeof (err as { code?: unknown } | null)?.code === "string"
        ? ((err as { code: string }).code as string)
        : "UNKNOWN";
    skipped.push({ path: rootAbs, reason: "ROOT_MISSING_OR_UNREADABLE", code });
    return { skills, skipped };
  }

  const folders = entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
  for (const folderName of folders) {
    const skillFile = path.join(rootAbs, folderName, "SKILL.md");
    let content: string;
    try {
      content = fs.readFileSync(skillFile, "utf8");
    } catch (err) {
      // FIX-R1 (P0-R1-02): a missing SKILL.md (ENOENT) means this
      // subdirectory is not a skill — recorded, nothing unknown. Any
      // other read failure means the file exists but cannot be read:
      // the errno is recorded with the skip so the caller can fail
      // closed instead of silently dropping the skill.
      const code =
        typeof (err as { code?: unknown } | null)?.code === "string"
          ? ((err as { code: string }).code as string)
          : "UNKNOWN";
      skipped.push({ path: skillFile, reason: "SKILL_MD_UNREADABLE", code });
      continue;
    }
    let canonicalPath: string;
    try {
      canonicalPath = fs.realpathSync(skillFile);
    } catch {
      skipped.push({ path: skillFile, reason: "CANONICAL_PATH_UNRESOLVABLE" });
      continue;
    }
    const relativePath = `${folderName}/SKILL.md`;
    const frontmatter = parseFrontmatter(content);
    const existing = byCanonical.get(canonicalPath);
    if (existing !== undefined) {
      existing.aliases.push(relativePath);
      continue;
    }
    const scanned: ScannedSkill = {
      folderName,
      relativePath,
      absolutePath: skillFile,
      canonicalPath,
      contentSha256: sha256Hex(content),
      manifestName: frontmatter.name ?? null,
      manifestValid: frontmatter.valid,
      manifestErrors: frontmatter.errors,
      aliases: [],
    };
    byCanonical.set(canonicalPath, scanned);
    skills.push(scanned);
  }
  return { skills, skipped };
}
