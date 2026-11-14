/**
 * Claude Code adapter public barrel (P023 T008, S2).
 *
 * `auditClaude` is the full read-only adapter (settings layers,
 * marketplaces, extra plugin dirs, trust gating, kernel wiring). The
 * T003 PoC (`claude-poc.ts`) stays the S0 production side and is
 * re-exported here for callers that need the frozen behaviour.
 */

export { auditClaude } from "./adapter.js";
export type {
  ClaudeAdapterInput,
  ClaudeAdapterResult,
  ExtraPluginDirInput,
} from "./adapter.js";
export {
  CLAUDE_RULES_VERSION,
  CLAUDE_SCOPES,
  loadClaudeRulesMatrix,
  SETTINGS_PRECEDENCE,
} from "./rules.js";
export {
  loadSettingsLayer,
  mergeAdditionalDirectories,
  mergeEffectiveDisables,
  mergeMarketplaces,
  validateSettingsShape,
} from "./settings.js";
export type {
  ClaudeSettings,
  ClaudeSettingsLayer,
  EffectiveDisables,
  MarketplaceDeclaration,
  SettingsLayerName,
  SettingsLayerStatus,
} from "./settings.js";
export {
  enumerateDefaultPluginDir,
  extraPluginDirRoots,
  pluginSkillRoot,
  pluginSourceRootId,
  resolveMarketplaces,
} from "./marketplace.js";
export type {
  MarketplaceResolution,
  PluginRootRecord,
} from "./marketplace.js";
export {
  resolveClaudeFixture,
  resolveClaudePoc,
} from "./claude-poc.js";
export type {
  ClaudePocFinding,
  ClaudePocInput,
  ClaudePocResult,
  ClaudeScope,
  ClaudeSourceRootInput,
} from "./claude-poc.js";
