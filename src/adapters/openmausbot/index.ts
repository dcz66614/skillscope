/**
 * OpenMausBot adapter public surface (P023 T007).
 *
 * - `openmausbot-poc.ts` — the frozen T003 PoC (S0 production side).
 * - `snapshot.ts` — the versioned snapshot contract + validation/loading.
 * - `adapter.ts` — the full read-only adapter (data-dir resolution,
 *   snapshot acquisition, completeness checks, kernel wiring).
 */
export {
  auditOpenMausBot,
  DEFAULT_REQUIRE_LISTS,
  type DataDirSource,
  type OpenMausBotAdapterInput,
  type OpenMausBotAdapterResult,
  type ScanRootInput,
  type SnapshotSource,
} from "./adapter.js";
export {
  OPENMAUSBOT_SNAPSHOT_VERSION,
  type OpenMausBotPocFinding,
  type OpenMausBotPocInput,
  type OpenMausBotPocResult,
  type OpenMausBotSkillKind,
  type OpenMausBotSnapshot,
  type OpenMausBotSnapshotSkill,
} from "./openmausbot-poc.js";
export {
  kindsPresent,
  loadSnapshotFile,
  OPENMAUSBOT_SNAPSHOT_SCHEMA_ID,
  SNAPSHOT_SKILL_KINDS,
  toPocSnapshot,
  validateSnapshotShape,
  type OpenMausBotSnapshotV1,
  type SnapshotLoadResult,
} from "./snapshot.js";
