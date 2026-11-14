/**
 * SKILL.md frontmatter tests (P023 T005).
 * Covers the full YAML parser: valid forms, name/description rules,
 * reserved words, malformed frontmatter, YAML errors, CRLF/BOM, and
 * JSON-safe extra fields.
 */
import { describe, expect, it } from "vitest";
import {
  parseManifest,
  validateSkillName,
} from "../../src/manifest/manifest.js";

describe("validateSkillName", () => {
  it("accepts lowercase hyphenated names", () => {
    expect(validateSkillName("release")).toBeNull();
    expect(validateSkillName("my-skill-2")).toBeNull();
    expect(validateSkillName("a")).toBeNull();
    expect(validateSkillName("x".repeat(64))).toBeNull();
  });

  it("rejects missing / non-string names", () => {
    expect(validateSkillName(undefined)).toBe("missing-name");
    expect(validateSkillName("")).toBe("missing-name");
    expect(validateSkillName(42)).toBe("missing-name");
  });

  it("rejects bad shapes", () => {
    expect(validateSkillName("Release")).toBe("invalid-name");
    expect(validateSkillName("my_skill")).toBe("invalid-name");
    expect(validateSkillName("my skill")).toBe("invalid-name");
    expect(validateSkillName("x".repeat(65))).toBe("invalid-name");
  });

  it("rejects reserved words", () => {
    expect(validateSkillName("claude")).toBe("reserved-name");
    expect(validateSkillName("anthropic")).toBe("reserved-name");
    expect(validateSkillName("my-claude")).toBe("reserved-name");
    expect(validateSkillName("anthropic-tools")).toBe("reserved-name");
  });
});

describe("parseManifest", () => {
  it("parses a valid frontmatter block with extra keys", () => {
    const result = parseManifest(
      "---\nname: release\ndescription: Ship it.\nversion: 2\ntags:\n  - ci\n  - deploy\n---\nBody text.\n",
    );
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.name).toBe("release");
    expect(result.description).toBe("Ship it.");
    expect(result.fields).toEqual({ version: 2, tags: ["ci", "deploy"] });
  });

  it("accepts quoted values and block-scalar descriptions", () => {
    const result = parseManifest(
      "---\nname: 'my-skill'\ndescription: |\n  line one\n  line two\n---\n",
    );
    expect(result.valid).toBe(true);
    expect(result.name).toBe("my-skill");
    expect(result.description).toBe("line one\nline two\n");
  });

  it("accepts ... as the closing fence", () => {
    const result = parseManifest(
      "---\nname: release\ndescription: Done.\n...\nBody.\n",
    );
    expect(result.valid).toBe(true);
    expect(result.name).toBe("release");
  });

  it("accepts CRLF line endings and a leading BOM", () => {
    const result = parseManifest(
      "\uFEFF---\r\nname: release\r\ndescription: Windows line endings.\r\n---\r\nBody.\r\n",
    );
    expect(result.valid).toBe(true);
    expect(result.name).toBe("release");
    expect(result.description).toBe("Windows line endings.");
  });

  it("rejects a missing frontmatter fence", () => {
    const result = parseManifest("name: release\ndescription: x.\n");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("missing-frontmatter-fence");
  });

  it("rejects an unterminated fence", () => {
    const result = parseManifest("---\nname: release\ndescription: x.\n");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("unterminated-frontmatter-fence");
  });

  it("rejects a non-mapping frontmatter", () => {
    const list = parseManifest("---\n- a\n- b\n---\n");
    expect(list.valid).toBe(false);
    expect(list.errors).toContain("frontmatter-not-mapping");
    const scalar = parseManifest("---\njust a string\n---\n");
    expect(scalar.valid).toBe(false);
    expect(scalar.errors).toContain("frontmatter-not-mapping");
    const empty = parseManifest("---\n---\n");
    expect(empty.valid).toBe(false);
    expect(empty.errors).toContain("frontmatter-not-mapping");
  });

  it("rejects a missing name and a missing description", () => {
    const noName = parseManifest("---\ndescription: Has no name.\n---\n");
    expect(noName.valid).toBe(false);
    expect(noName.errors).toContain("missing-name");
    expect(noName.description).toBe("Has no name.");
    const noDesc = parseManifest("---\nname: release\n---\n");
    expect(noDesc.valid).toBe(false);
    expect(noDesc.errors).toContain("missing-description");
    expect(noDesc.name).toBe("release");
  });

  it("rejects an invalid name and a reserved name", () => {
    const bad = parseManifest("---\nname: Bad_Name\ndescription: x.\n---\n");
    expect(bad.valid).toBe(false);
    expect(bad.errors).toContain("invalid-name");
    const reserved = parseManifest(
      "---\nname: claude-helper\ndescription: x.\n---\n",
    );
    expect(reserved.valid).toBe(false);
    expect(reserved.errors).toContain("reserved-name");
  });

  it("rejects an empty description", () => {
    const result = parseManifest("---\nname: release\ndescription: '   '\n---\n");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("invalid-description");
  });

  it("rejects duplicate keys with a line/column detail, never a source excerpt", () => {
    const result = parseManifest(
      "---\nname: a\nname: b\ndescription: x.\n---\n",
    );
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("yaml-parse-error");
    expect(result.errorDetail).toMatch(/^line \d+, column \d+$/);
  });

  it("rejects broken YAML with a position-only detail", () => {
    const result = parseManifest("---\nname: [unclosed\ndescription: x.\n---\n");
    expect(result.valid).toBe(false);
    expect(result.errors).toContain("yaml-parse-error");
    expect(result.errorDetail).toMatch(/^line \d+, column \d+$/);
    expect(JSON.stringify(result)).not.toContain("unclosed");
  });

  it("normalises non-finite numbers in extra fields", () => {
    const result = parseManifest(
      "---\nname: release\ndescription: x.\nbig: .inf\nsmall: -.inf\nnan: .nan\n---\n",
    );
    expect(result.valid).toBe(true);
    expect(result.fields).toEqual({ big: ".inf", small: "-.inf", nan: ".nan" });
  });

  it("keeps nested mappings and numbers in extra fields", () => {
    const result = parseManifest(
      "---\nname: release\ndescription: x.\nmeta:\n  owner: team-a\n  level: 3\n  enabled: true\n---\n",
    );
    expect(result.valid).toBe(true);
    expect(result.fields).toEqual({
      meta: { owner: "team-a", level: 3, enabled: true },
    });
  });

  it("does not look past the closing fence", () => {
    const result = parseManifest(
      "---\nname: release\ndescription: x.\n---\nname: forged\n",
    );
    expect(result.valid).toBe(true);
    expect(result.name).toBe("release");
  });
});
