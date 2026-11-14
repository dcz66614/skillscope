/**
 * Claude Code rules matrix (P023 T008, S2).
 *
 * The normative matrix lives in `claude-rules.json` next to this module
 * (frozen, versioned, `claude-rules/v1`). This file is the hand-written
 * mirror the adapter actually imports — the runtime dependency set
 * stays smol-toml + yaml (ADR-003/ADR-004), so no JSON-module import
 * is added. The test suite (`tests/claude/rules.test.ts`) asserts the
 * two agree on the version, the scope list, the settings precedence,
 * the settings file names and the disable mechanisms, so they cannot
 * drift silently (same pattern as T007's snapshot.ts vs schema file).
 *
 * Rule sources: Claude Code docs "Settings files and precedence"
 * (four settings files; managed highest; additionalDirectories,
 * extraKnownMarketplaces, trust gating), "Plugin settings"
 * (enabledPlugins `"plugin-name@marketplace-name": true/false`),
 * "Manage mods for your organization" (strictKnownMarketplaces,
 * disableSideloadFlags, --plugin-dir); PROJECT_BOOK §4.4.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

/** Version carried by `claude-rules.json`. */
export const CLAUDE_RULES_VERSION = "claude-rules/v1";

/** The seven Claude scopes (PROJECT_BOOK §4.4). */
export const CLAUDE_SCOPES: readonly string[] = [
  "ENTERPRISE",
  "PERSONAL",
  "PROJECT",
  "NESTED",
  "ADD_DIR",
  "PLUGIN",
  "ACCOUNT_SYNC",
];

/** Settings layers, highest precedence first. */
export const SETTINGS_PRECEDENCE: readonly string[] = [
  "managed",
  "user",
  "project",
  "local",
];

/** Settings file name per layer (no paths — paths resolve in settings.ts). */
export const SETTINGS_FILES: Readonly<Record<string, string>> = {
  managed: "managed-settings.json",
  user: "settings.json",
  project: "settings.json",
  local: "settings.local.json",
};

/** Disable mechanisms the adapter reads from settings layers. */
export const DISABLE_MECHANISM_KEYS: readonly string[] = [
  "enabledPlugins",
  "skillOverrides",
];

/** Unknown-scope name for an unreadable settings layer. */
export function settingsUnknownScope(layer: string): string {
  return `${layer.toUpperCase()}_SETTINGS`;
}

/**
 * Load the normative rules matrix for a cross-check. The adapter does
 * not call this at audit time (the constants above are the runtime
 * truth); the rules tests use it to prove the JSON file and this
 * module agree.
 */
export function loadClaudeRulesMatrix(): Record<string, unknown> {
  const file = path.join(
    path.dirname(fileURLToPath(import.meta.url)),
    "claude-rules.json",
  );
  return JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
}
