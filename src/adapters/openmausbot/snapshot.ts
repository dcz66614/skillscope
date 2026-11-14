/**
 * Versioned OpenMausBot snapshot contract (P023 T007, S2).
 *
 * The snapshot is the SkillScope-side inventory contract for one bot:
 * a JSON document listing the skills the host claims the bot may load,
 * plus the per-bot switches (`disabledPluginIds`,
 * `nativeDisabledNames`) and the `emptyLists` declarations that tell
 * absence apart from emptiness. The normative schema lives in
 * `openmausbot-snapshot-v1.json` next to this module; this file is the
 * hand-written validator that enforces the same rules without adding a
 * JSON-Schema dependency (the runtime dependency set stays
 * smol-toml + yaml, ADR-003/ADR-004). The test suite asserts the
 * validator and the schema file agree on the required / optional /
 * enum lists, so the two cannot drift silently.
 *
 * Shape vs version: `validateSnapshotShape` checks structure only and
 * deliberately does NOT check the version value — an unknown version
 * is not a shape error, it is handled by the PoC's version gate
 * (SOURCE_NOT_ENUMERATED, inventory untrusted). A shape error, by
 * contrast, means the adapter cannot even feed the document to the
 * PoC, so the adapter reports the snapshot itself as unenumerated.
 *
 * The module is pure except for `loadSnapshotFile`, which only reads.
 * No writes, no network, no clock.
 */

import * as fs from "node:fs";
import {
  OPENMAUSBOT_SNAPSHOT_VERSION,
  type OpenMausBotSkillKind,
  type OpenMausBotSnapshot,
  type OpenMausBotSnapshotSkill,
} from "./openmausbot-poc.js";

/** Contract version carried by `openmausbot-snapshot-v1.json`. */
export const OPENMAUSBOT_SNAPSHOT_SCHEMA_ID = OPENMAUSBOT_SNAPSHOT_VERSION;

/** Skill kinds the snapshot may list (mirrors the PoC's kind enum). */
export const SNAPSHOT_SKILL_KINDS: readonly OpenMausBotSkillKind[] = [
  "assigned",
  "imported",
  "native",
  "plugin",
  "repo",
  "library",
  "user-claude",
];

/**
 * A v1 snapshot document: the PoC snapshot plus `emptyLists`, the
 * adapter-level declaration that a per-bot list is empty rather than
 * missing. `emptyLists` never reaches the PoC (the adapter strips it
 * when building the PoC input).
 */
export interface OpenMausBotSnapshotV1 extends OpenMausBotSnapshot {
  emptyLists?: OpenMausBotSkillKind[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

const TOP_LEVEL_KEYS = new Set([
  "version",
  "skills",
  "loadableRoots",
  "disabledPluginIds",
  "nativeDisabledNames",
  "emptyLists",
]);

const SKILL_KEYS = new Set([
  "name",
  "kind",
  "path",
  "importState",
  "originalPath",
  "pluginId",
]);

function checkStringArray(
  value: unknown,
  field: string,
  errors: string[],
): void {
  if (!Array.isArray(value)) {
    errors.push(`${field} must be an array of strings`);
    return;
  }
  for (const entry of value) {
    if (!isNonEmptyString(entry)) {
      errors.push(`${field} must contain only non-empty strings`);
      return;
    }
  }
}

/**
 * Validate a snapshot document's structure (not its version).
 * Returns a list of problems; empty means the document is a
 * well-formed v1-shaped snapshot. Unknown keys are errors: a v1
 * reader must fail closed on contract extensions it does not
 * understand rather than silently ignoring fields that could change
 * the inventory meaning.
 */
export function validateSnapshotShape(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["snapshot must be an object"];
  }
  for (const key of Object.keys(value)) {
    if (!TOP_LEVEL_KEYS.has(key)) {
      errors.push(`unknown snapshot field: ${JSON.stringify(key)}`);
    }
  }
  if (!isNonEmptyString(value["version"])) {
    errors.push("version must be a non-empty string");
  }
  if (!Array.isArray(value["skills"])) {
    errors.push("skills must be an array");
  } else {
    value["skills"].forEach((skill, index) => {
      const at = `skills[${index}]`;
      if (!isRecord(skill)) {
        errors.push(`${at} must be an object`);
        return;
      }
      for (const key of Object.keys(skill)) {
        if (!SKILL_KEYS.has(key)) {
          errors.push(`unknown field in ${at}: ${JSON.stringify(key)}`);
        }
      }
      if (!isNonEmptyString(skill["name"])) {
        errors.push(`${at}.name must be a non-empty string`);
      }
      if (
        typeof skill["kind"] !== "string" ||
        !(SNAPSHOT_SKILL_KINDS as readonly string[]).includes(skill["kind"])
      ) {
        errors.push(
          `${at}.kind must be one of ${SNAPSHOT_SKILL_KINDS.join(", ")}`,
        );
      }
      if (!isNonEmptyString(skill["path"])) {
        errors.push(`${at}.path must be a non-empty string`);
      }
      if (
        skill["importState"] !== undefined &&
        skill["importState"] !== "active" &&
        skill["importState"] !== "closed"
      ) {
        errors.push(`${at}.importState must be "active" or "closed"`);
      }
      if (
        skill["originalPath"] !== undefined &&
        !isNonEmptyString(skill["originalPath"])
      ) {
        errors.push(`${at}.originalPath must be a non-empty string`);
      }
      if (
        skill["pluginId"] !== undefined &&
        !isNonEmptyString(skill["pluginId"])
      ) {
        errors.push(`${at}.pluginId must be a non-empty string`);
      }
    });
  }
  if (!Array.isArray(value["loadableRoots"])) {
    errors.push("loadableRoots must be an array of strings");
  } else {
    checkStringArray(value["loadableRoots"], "loadableRoots", errors);
  }
  if (value["disabledPluginIds"] !== undefined) {
    checkStringArray(value["disabledPluginIds"], "disabledPluginIds", errors);
  }
  if (value["nativeDisabledNames"] !== undefined) {
    checkStringArray(value["nativeDisabledNames"], "nativeDisabledNames", errors);
  }
  if (value["emptyLists"] !== undefined) {
    if (!Array.isArray(value["emptyLists"])) {
      errors.push("emptyLists must be an array of skill kinds");
    } else {
      for (const entry of value["emptyLists"]) {
        if (
          typeof entry !== "string" ||
          !(SNAPSHOT_SKILL_KINDS as readonly string[]).includes(entry)
        ) {
          errors.push(
            `emptyLists entries must be one of ${SNAPSHOT_SKILL_KINDS.join(", ")}`,
          );
          break;
        }
      }
    }
  }
  return errors;
}

/** Kinds present in the snapshot's `skills` list. */
export function kindsPresent(
  snapshot: Pick<OpenMausBotSnapshotV1, "skills">,
): Set<OpenMausBotSkillKind> {
  return new Set(snapshot.skills.map((skill) => skill.kind));
}

export type SnapshotLoadResult =
  | { ok: true; snapshot: OpenMausBotSnapshotV1 }
  | {
      ok: false;
      reason: "missing" | "invalid-json" | "invalid-shape";
      errors: string[];
    };

/**
 * Read and validate a snapshot JSON file. Read-only. `missing` covers
 * both a nonexistent path and an unreadable file: either way the
 * inventory cannot be enumerated from that path.
 */
export function loadSnapshotFile(filePath: string): SnapshotLoadResult {
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch {
    return { ok: false, reason: "missing", errors: [`snapshot file is missing or unreadable`] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, reason: "invalid-json", errors: ["snapshot file is not valid JSON"] };
  }
  const errors = validateSnapshotShape(parsed);
  if (errors.length > 0) {
    return { ok: false, reason: "invalid-shape", errors };
  }
  return { ok: true, snapshot: parsed as OpenMausBotSnapshotV1 };
}

/** Strip adapter-only fields when handing a snapshot to the PoC. */
export function toPocSnapshot(
  snapshot: OpenMausBotSnapshotV1,
): OpenMausBotSnapshot {
  const out: OpenMausBotSnapshot = {
    version: snapshot.version,
    skills: snapshot.skills.map((skill) => {
      const entry: OpenMausBotSnapshotSkill = {
        name: skill.name,
        kind: skill.kind,
        path: skill.path,
      };
      if (skill.importState !== undefined) {
        entry.importState = skill.importState;
      }
      if (skill.originalPath !== undefined) {
        entry.originalPath = skill.originalPath;
      }
      if (skill.pluginId !== undefined) {
        entry.pluginId = skill.pluginId;
      }
      return entry;
    }),
    loadableRoots: [...snapshot.loadableRoots],
  };
  if (snapshot.disabledPluginIds !== undefined) {
    out.disabledPluginIds = [...snapshot.disabledPluginIds];
  }
  if (snapshot.nativeDisabledNames !== undefined) {
    out.nativeDisabledNames = [...snapshot.nativeDisabledNames];
  }
  return out;
}
