/**
 * Filesystem access classification (P023 FIX-R1).
 *
 * The R1 final review proved that `existsSync` cannot tell "does not
 * exist" from "exists but cannot be read": both return `false`, so an
 * unreadable config / opt-out / skill directory was silently treated
 * as absent and the audit reported PASS (P0-R1-01, P1-R1-02). Every
 * fail-closed read in the product must go through this module instead:
 *
 *   - `classifyPath` stats the path once. ENOENT / ENOTDIR mean the
 *     path is genuinely absent ("missing"); EACCES / EPERM mean the
 *     caller may not read it ("unreadable"); any other error is also
 *     "unreadable" — the fail-closed direction, never "missing".
 *   - `classifyError` applies the same mapping to a caught error, so
 *     `catch` blocks that already hold the error need no second stat.
 *
 * Pure except for the single stat call in `classifyPath`. No clock,
 * no network, no writes. The mapping is unit-tested with synthetic
 * errno objects (a real EACCES cannot be produced by the root user
 * that runs the suite); the end-to-end behaviour under a real
 * permission denial is proven by the R1 regression suite, which runs
 * the built product as the unprivileged user `nobody`.
 */

import * as fs from "node:fs";

/** What a stat / read attempt established about a path. */
export type FsAccess = "present" | "missing" | "unreadable";

/**
 * Map a caught filesystem error to "missing" or "unreadable".
 * Only ENOENT (no such file or directory) and ENOTDIR (a path
 * component is not a directory, so the path cannot exist as a file)
 * mean absence. EACCES / EPERM mean the path exists but the caller
 * may not read it. Anything else — including an error object with no
 * `code` at all — is "unreadable": when the cause is unknown, the
 * audit must fail closed rather than assume absence.
 */
export function classifyError(error: unknown): "missing" | "unreadable" {
  const code = (error as { code?: unknown } | null | undefined)?.code;
  if (code === "ENOENT" || code === "ENOTDIR") {
    return "missing";
  }
  return "unreadable";
}

/**
 * Stat a path once and classify it. "present" means the stat
 * succeeded (the path exists, whatever its type); "missing" and
 * "unreadable" follow `classifyError`.
 */
export function classifyPath(filePath: string): FsAccess {
  try {
    fs.statSync(filePath);
    return "present";
  } catch (err) {
    return classifyError(err);
  }
}

/**
 * True when a skipped-entry record means "content exists but could
 * not be read". `reason` is a skip reason from the shared scanners
 * (`src/adapters/shared/skill-scan.ts`, `src/discovery/discovery.ts`)
 * and `code` is the errno string recorded with it, when the skip came
 * from a failed filesystem operation:
 *
 *   - SKILL_MD_UNREADABLE / DIR_UNREADABLE with a real errno other
 *     than ENOENT: the file or directory exists but cannot be read,
 *     so its content is unknown — the audit must be INCOMPLETE.
 *   - SKILL_MD_UNREADABLE with code ENOENT: the subdirectory simply
 *     has no SKILL.md (it is a container directory such as Claude's
 *     `synced/`, not a skill) — recorded, not unknown.
 *   - SKILL_MD_UNREADABLE with no code: a structural skip (e.g. a
 *     directory literally named `SKILL.md`) — recorded, not unknown.
 *   - SKILL_MD_TOO_LARGE: the file exists and was deliberately not
 *     read, so its content is unknown — INCOMPLETE.
 *
 * ROOT_MISSING_OR_UNREADABLE is deliberately NOT covered here: the
 * PoC adapters already report a missing/unreadable root through
 * coverage, and converting it a second time in the kernel would
 * double-report the same source.
 */
export function isContentUnknownSkip(reason: string, code?: string): boolean {
  if (reason === "SKILL_MD_TOO_LARGE") {
    return true;
  }
  if (reason !== "SKILL_MD_UNREADABLE" && reason !== "DIR_UNREADABLE") {
    return false;
  }
  return code !== undefined && code !== "ENOENT";
}
