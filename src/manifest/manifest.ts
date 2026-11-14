/**
 * Full SKILL.md frontmatter parsing (P023 T005, S1).
 *
 * Replaces the PoC-grade minimal parser in
 * src/adapters/shared/skill-scan.ts (name/description line scan only)
 * with a real YAML parser: `yaml` 2.9.1, pinned exact (ADR-004,
 * closes OPEN-002). The parser is pure — it takes text and returns a
 * result; it never reads files, never executes skill content, and never
 * touches the network.
 *
 * Validation follows the Agent Skills specification (PROJECT_BOOK §1.4):
 * frontmatter must be a mapping with a `name` and a `description`.
 * The name must be lowercase alphanumeric-or-hyphen, at most 64
 * characters, and must not contain the reserved words `anthropic` or
 * `claude`. Extra keys are preserved in `fields` after JSON
 * normalisation (non-finite numbers become their YAML spellings).
 * Duplicate mapping keys are rejected by the YAML parser itself.
 *
 * Error reporting is machine-readable (`errors` codes) plus an optional
 * `errorDetail` carrying only the YAML parser's line/column — never a
 * source excerpt — so no skill text is copied into logs or reports.
 */

import { parse as parseYaml } from "yaml";

export const SKILL_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;
export const MAX_SKILL_NAME_LENGTH = 64;
export const RESERVED_SKILL_NAME_WORDS: readonly string[] = [
  "anthropic",
  "claude",
];

export type ManifestErrorCode =
  | "missing-frontmatter-fence"
  | "unterminated-frontmatter-fence"
  | "yaml-parse-error"
  | "frontmatter-not-mapping"
  | "missing-name"
  | "invalid-name"
  | "reserved-name"
  | "missing-description"
  | "invalid-description";

export interface ManifestResult {
  name?: string;
  description?: string;
  /** Extra frontmatter keys, JSON-normalised. Never contains name/description. */
  fields: Record<string, unknown>;
  valid: boolean;
  errors: ManifestErrorCode[];
  /** YAML parser position only (e.g. "line 2, column 1"), never a source excerpt. */
  errorDetail?: string;
}

/** Validate a candidate skill name; null means the name is acceptable. */
export function validateSkillName(name: unknown): ManifestErrorCode | null {
  if (typeof name !== "string" || name.length === 0) {
    return "missing-name";
  }
  if (
    name.length > MAX_SKILL_NAME_LENGTH ||
    !SKILL_NAME_PATTERN.test(name)
  ) {
    return "invalid-name";
  }
  for (const word of RESERVED_SKILL_NAME_WORDS) {
    if (name.includes(word)) {
      return "reserved-name";
    }
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/** Recursively make a parsed YAML value JSON-safe. */
function toJsonSafe(value: unknown): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "number") {
    if (Number.isNaN(value)) {
      return ".nan";
    }
    if (value === Number.POSITIVE_INFINITY) {
      return ".inf";
    }
    if (value === Number.NEGATIVE_INFINITY) {
      return "-.inf";
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => toJsonSafe(item));
  }
  if (isPlainObject(value)) {
    const out: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (item !== undefined) {
        out[key] = toJsonSafe(item);
      }
    }
    return out;
  }
  // Dates and any other exotic YAML scalars: keep their string form.
  return String(value);
}

/**
 * Parse the frontmatter of a SKILL.md file. Accepts CRLF and a leading
 * BOM. The closing fence may be `---` or `...`. Everything after the
 * closing fence is the skill body and is never inspected here.
 */
export function parseManifest(content: string): ManifestResult {
  const errors: ManifestErrorCode[] = [];
  const normalized = content
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
  const lines = normalized.split("\n");
  const first = lines[0];
  if (first === undefined || first.trim() !== "---") {
    return {
      fields: {},
      valid: false,
      errors: ["missing-frontmatter-fence"],
    };
  }
  let closeIndex = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const line = lines[i] as string;
    if (line.trim() === "---" || line.trim() === "...") {
      closeIndex = i;
      break;
    }
  }
  if (closeIndex < 0) {
    return {
      fields: {},
      valid: false,
      errors: ["unterminated-frontmatter-fence"],
    };
  }
  const yamlText = lines.slice(1, closeIndex).join("\n");
  let parsed: unknown;
  try {
    parsed = parseYaml(yamlText);
  } catch (error) {
    let detail = "yaml parse error";
    const linePos = (error as { linePos?: Array<{ line: number; col: number }> })
      .linePos;
    if (Array.isArray(linePos) && linePos.length > 0) {
      const pos = linePos[0] as { line: number; col: number };
      detail = `line ${pos.line}, column ${pos.col}`;
    }
    return {
      fields: {},
      valid: false,
      errors: ["yaml-parse-error"],
      errorDetail: detail,
    };
  }
  if (!isPlainObject(parsed)) {
    return {
      fields: {},
      valid: false,
      errors: ["frontmatter-not-mapping"],
    };
  }

  const result: ManifestResult = { fields: {}, valid: false, errors };
  const rawName = parsed["name"];
  const nameError = validateSkillName(rawName);
  if (nameError !== null) {
    errors.push(nameError);
  } else {
    result.name = rawName as string;
  }
  const rawDescription = parsed["description"];
  if (typeof rawDescription !== "string" || rawDescription.trim().length === 0) {
    errors.push(
      rawDescription === undefined ? "missing-description" : "invalid-description",
    );
  } else {
    result.description = rawDescription;
  }
  for (const [key, value] of Object.entries(parsed)) {
    if (key === "name" || key === "description" || value === undefined) {
      continue;
    }
    result.fields[key] = toJsonSafe(value);
  }
  result.valid = errors.length === 0;
  return result;
}
