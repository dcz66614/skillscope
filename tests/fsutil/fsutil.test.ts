/**
 * Unit tests for src/fsutil (FIX-R1): the missing-vs-unreadable
 * classification every fail-closed read depends on.
 *
 * The errno mapping is tested with synthetic error objects: the suite
 * runs as root, for whom a real EACCES cannot be produced. Real
 * permission-denial behaviour is proven end-to-end by the R1
 * regression suite (tests/regression/r1-fix.test.ts), which runs the
 * built product as the unprivileged user `nobody`.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyError,
  classifyPath,
  isContentUnknownSkip,
} from "../../src/fsutil/index.js";

describe("classifyError", () => {
  it("ENOENT and ENOTDIR mean missing", () => {
    expect(classifyError({ code: "ENOENT" })).toBe("missing");
    expect(classifyError({ code: "ENOTDIR" })).toBe("missing");
    expect(classifyError(Object.assign(new Error("no such file"), { code: "ENOENT" }))).toBe("missing");
  });

  it("EACCES and EPERM mean unreadable", () => {
    expect(classifyError({ code: "EACCES" })).toBe("unreadable");
    expect(classifyError({ code: "EPERM" })).toBe("unreadable");
    expect(classifyError(Object.assign(new Error("permission denied"), { code: "EACCES" }))).toBe("unreadable");
  });

  it("an error with no code, or a non-error, fails closed as unreadable", () => {
    expect(classifyError(new Error("boom"))).toBe("unreadable");
    expect(classifyError({})).toBe("unreadable");
    expect(classifyError(undefined)).toBe("unreadable");
    expect(classifyError("EACCES")).toBe("unreadable");
  });
});

describe("classifyPath", () => {
  it("a present file is present and a missing path is missing", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-fsutil-"));
    try {
      const file = path.join(dir, "x.txt");
      fs.writeFileSync(file, "x");
      expect(classifyPath(file)).toBe("present");
      expect(classifyPath(dir)).toBe("present");
      expect(classifyPath(path.join(dir, "does-not-exist"))).toBe("missing");
      expect(classifyPath(path.join(file, "child"))).toBe("missing");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("isContentUnknownSkip", () => {
  it("an unreadable SKILL.md or directory is unknown content", () => {
    expect(isContentUnknownSkip("SKILL_MD_UNREADABLE", "EACCES")).toBe(true);
    expect(isContentUnknownSkip("SKILL_MD_UNREADABLE", "EPERM")).toBe(true);
    expect(isContentUnknownSkip("DIR_UNREADABLE", "EACCES")).toBe(true);
  });

  it("a missing SKILL.md (ENOENT) is not a skill, not unknown content", () => {
    expect(isContentUnknownSkip("SKILL_MD_UNREADABLE", "ENOENT")).toBe(false);
    expect(isContentUnknownSkip("DIR_UNREADABLE", "ENOENT")).toBe(false);
  });

  it("a structural skip with no errno is recorded only", () => {
    expect(isContentUnknownSkip("SKILL_MD_UNREADABLE")).toBe(false);
    expect(isContentUnknownSkip("SYMLINK_LOOP")).toBe(false);
    expect(isContentUnknownSkip("SYMLINK_OUTSIDE_ROOT")).toBe(false);
    expect(isContentUnknownSkip("CANONICAL_PATH_UNRESOLVABLE")).toBe(false);
    expect(isContentUnknownSkip("DEPTH_LIMIT")).toBe(false);
    expect(isContentUnknownSkip("ENTRY_LIMIT")).toBe(false);
    expect(isContentUnknownSkip("PATH_TRAVERSAL")).toBe(false);
    expect(isContentUnknownSkip("ROOT_MISSING_OR_UNREADABLE", "EACCES")).toBe(false);
  });

  it("an over-large SKILL.md is unknown content even without an errno", () => {
    expect(isContentUnknownSkip("SKILL_MD_TOO_LARGE")).toBe(true);
  });
});
