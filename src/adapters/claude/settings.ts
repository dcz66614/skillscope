/**
 * Claude Code settings layers (P023 T008, S2).
 *
 * Settings files, highest precedence first (Claude Code docs,
 * "Settings files and precedence"):
 *
 *   managed  managed-settings.json   (explicit path only — the adapter
 *                                      never defaults to a machine path)
 *   user     ~/.claude/settings.json
 *   project  .claude/settings.json
 *   local    .claude/settings.local.json
 *
 * Keys the adapter reads (see claude-rules.json for the frozen matrix):
 *   enabledPlugins          Record<"<plugin>@<marketplace>" | "<plugin>", boolean>
 *                           false disables that plugin's skills.
 *   skillOverrides          Record<logical name, "off"> — name-based
 *                           disables (PROJECT_BOOK §4.4); no path selector.
 *   extraKnownMarketplaces  Array of marketplace declarations:
 *                           {name, path} or {name, source: {type: "directory", path}}
 *                           (directory marketplace, resolvable offline) or
 *                           {name, source: {type: "git", url}}
 *                           (git marketplace, unresolvable offline).
 *   additionalDirectories   string[] — extra working directories; each
 *                           contributes <dir>/.claude/skills as ADD_DIR.
 *   strictKnownMarketplaces boolean — only the managed layer's value is
 *                           honoured (managed marketplace restriction).
 *
 * Unknown keys are ignored: a settings file carries many keys the audit
 * does not care about. A known key with the wrong type is a shape error.
 *
 * Fail-closed (ADR-009): a layer file that is present but unreadable,
 * invalid JSON, or invalid in shape makes that layer's effect
 * unknowable, so the audit is INCOMPLETE with an unknown scope named
 * after the layer (MANAGED_SETTINGS / USER_SETTINGS /
 * PROJECT_SETTINGS / LOCAL_SETTINGS). A missing layer file is not an
 * error — the layer simply does not apply.
 *
 * Precedence merge: for each key the highest-precedence layer that sets
 * it wins. `overriddenByUser` records the disable entries whose winning
 * layer is USER and which no lower layer also disabled — i.e. the cases
 * where the user layer changed the outcome versus what the project
 * layer alone would load. Those are applied deterministically (the
 * instance is DISABLED), not INCOMPLETE.
 *
 * The module is pure except for reading the layer files. No writes, no
 * network, no clock.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import {
  SETTINGS_PRECEDENCE,
  settingsUnknownScope,
} from "./rules.js";

export type SettingsLayerName = "managed" | "user" | "project" | "local";

export const SETTINGS_LAYER_NAMES: readonly SettingsLayerName[] = [
  "managed",
  "user",
  "project",
  "local",
];

export type SettingsLayerStatus =
  | "present"
  | "missing"
  | "unreadable"
  | "invalid-json"
  | "invalid-shape";

/** One marketplace declaration, as read from a settings file. */
export interface MarketplaceDeclaration {
  name: string;
  /** Directory marketplace: resolvable offline. */
  path?: string;
  /** Git marketplace: unresolvable offline (recorded, never fetched). */
  source?: { type: "git"; url: string } | { type: "directory"; path: string };
}

/** The settings keys the adapter understands. */
export interface ClaudeSettings {
  enabledPlugins?: Record<string, boolean>;
  skillOverrides?: Record<string, "off">;
  extraKnownMarketplaces?: MarketplaceDeclaration[];
  additionalDirectories?: string[];
  strictKnownMarketplaces?: boolean;
}

export interface ClaudeSettingsLayer {
  name: SettingsLayerName;
  /** Absolute path that was attempted, or null when no path was given. */
  path: string | null;
  status: SettingsLayerStatus;
  settings: ClaudeSettings | null;
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/**
 * Validate the adapter-relevant shape of a settings document. Unknown
 * keys are ignored. Returns error strings; empty means valid.
 */
export function validateSettingsShape(value: unknown): string[] {
  const errors: string[] = [];
  if (!isRecord(value)) {
    return ["settings document must be a JSON object"];
  }
  const enabledPlugins = value["enabledPlugins"];
  if (enabledPlugins !== undefined) {
    if (!isRecord(enabledPlugins)) {
      errors.push("enabledPlugins must be an object");
    } else {
      for (const [key, entry] of Object.entries(enabledPlugins)) {
        if (typeof entry !== "boolean") {
          errors.push(
            `enabledPlugins[${JSON.stringify(key)}] must be a boolean`,
          );
          break;
        }
      }
    }
  }
  const skillOverrides = value["skillOverrides"];
  if (skillOverrides !== undefined) {
    if (!isRecord(skillOverrides)) {
      errors.push("skillOverrides must be an object");
    } else {
      for (const [key, entry] of Object.entries(skillOverrides)) {
        if (entry !== "off") {
          errors.push(
            `skillOverrides[${JSON.stringify(key)}] must be "off"`,
          );
          break;
        }
      }
    }
  }
  const marketplaces = value["extraKnownMarketplaces"];
  if (marketplaces !== undefined) {
    if (!Array.isArray(marketplaces)) {
      errors.push("extraKnownMarketplaces must be an array");
    } else {
      for (const entry of marketplaces) {
        if (!isRecord(entry) || !isNonEmptyString(entry["name"])) {
          errors.push(
            "extraKnownMarketplaces entries must be objects with a non-empty name",
          );
          break;
        }
        const entryPath = entry["path"];
        const source = entry["source"];
        if (
          entryPath !== undefined &&
          !isNonEmptyString(entryPath) &&
          source === undefined
        ) {
          errors.push(
            `extraKnownMarketplaces[${JSON.stringify(entry["name"])}] path must be a non-empty string`,
          );
          break;
        }
        if (source !== undefined) {
          if (!isRecord(source)) {
            errors.push(
              `extraKnownMarketplaces[${JSON.stringify(entry["name"])}] source must be an object`,
            );
            break;
          }
          if (source["type"] === "git") {
            if (!isNonEmptyString(source["url"])) {
              errors.push(
                `extraKnownMarketplaces[${JSON.stringify(entry["name"])}] git source must have a non-empty url`,
              );
              break;
            }
          } else if (source["type"] === "directory") {
            if (!isNonEmptyString(source["path"])) {
              errors.push(
                `extraKnownMarketplaces[${JSON.stringify(entry["name"])}] directory source must have a non-empty path`,
              );
              break;
            }
          } else {
            errors.push(
              `extraKnownMarketplaces[${JSON.stringify(entry["name"])}] source type must be "git" or "directory"`,
            );
            break;
          }
        } else if (entryPath === undefined) {
          errors.push(
            `extraKnownMarketplaces[${JSON.stringify(entry["name"])}] must have a path or a source`,
          );
          break;
        }
      }
    }
  }
  const additionalDirectories = value["additionalDirectories"];
  if (additionalDirectories !== undefined) {
    if (
      !Array.isArray(additionalDirectories) ||
      additionalDirectories.some((entry) => !isNonEmptyString(entry))
    ) {
      errors.push("additionalDirectories must be an array of non-empty strings");
    }
  }
  if (
    value["strictKnownMarketplaces"] !== undefined &&
    typeof value["strictKnownMarketplaces"] !== "boolean"
  ) {
    errors.push("strictKnownMarketplaces must be a boolean");
  }
  return errors;
}

function parseSettingsDocument(
  raw: string,
  layer: SettingsLayerName,
  filePath: string,
): ClaudeSettingsLayer {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch (error) {
    return {
      name: layer,
      path: filePath,
      status: "invalid-json",
      settings: null,
      errors: [
        `settings file is not valid JSON (${error instanceof Error ? error.message : "parse error"})`,
      ],
    };
  }
  const errors = validateSettingsShape(parsed);
  if (errors.length > 0) {
    return {
      name: layer,
      path: filePath,
      status: "invalid-shape",
      settings: null,
      errors,
    };
  }
  return {
    name: layer,
    path: filePath,
    status: "present",
    settings: parsed as ClaudeSettings,
    errors: [],
  };
}

/**
 * Load one settings layer from an absolute path. A null path means the
 * layer has no file to load (managed settings without an explicit path,
 * for example): the layer is missing, not an error.
 */
export function loadSettingsLayer(
  layer: SettingsLayerName,
  filePath: string | null,
): ClaudeSettingsLayer {
  if (filePath === null) {
    return { name: layer, path: null, status: "missing", settings: null, errors: [] };
  }
  let raw: string;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | undefined)?.code;
    if (code === "ENOENT" || code === "ENOTDIR") {
      return { name: layer, path: filePath, status: "missing", settings: null, errors: [] };
    }
    return {
      name: layer,
      path: filePath,
      status: "unreadable",
      settings: null,
      errors: [
        `settings file could not be read (${error instanceof Error ? error.message : "read error"})`,
      ],
    };
  }
  return parseSettingsDocument(raw, layer, filePath);
}

/** Whether a layer's unreadability makes the audit INCOMPLETE. */
export function isLayerUnknown(layer: ClaudeSettingsLayer): boolean {
  return (
    layer.status === "unreadable" ||
    layer.status === "invalid-json" ||
    layer.status === "invalid-shape"
  );
}

/** Unknown-scope name for an unknowable layer (ADR-009). */
export function unknownScopeForLayer(layer: ClaudeSettingsLayer): string {
  return settingsUnknownScope(layer.name);
}

export interface EffectiveDisables {
  /** Plugin keys disabled by the winning layer: "plugin@marketplace" or bare "plugin". */
  disabledPlugins: string[];
  /** Logical names disabled by the winning layer. */
  skillOverrides: string[];
  /**
   * Disable entries whose winning layer is USER and which no lower
   * layer also disabled — the user layer changed the outcome versus
   * the project layer alone. Deterministic, recorded, not INCOMPLETE.
   */
  overriddenByUser: string[];
}

/**
 * Merge the four layers by precedence. Layers are given in any order;
 * the merge walks local → project → user → managed so the highest
 * precedence wins per key. A layer that failed to load contributes
 * nothing (its unknowability is reported separately as UNKNOWN).
 */
export function mergeEffectiveDisables(
  layers: readonly ClaudeSettingsLayer[],
): EffectiveDisables {
  const byName = new Map<string, SettingsLayerName>();
  const pluginDisabled = new Map<string, SettingsLayerName>();
  // Lowest precedence first, so higher layers overwrite.
  const ascending = [...SETTINGS_PRECEDENCE].reverse() as SettingsLayerName[];
  const byLayer = new Map(layers.map((layer) => [layer.name, layer]));
  const lowerDisabledNames = new Set<string>();
  const lowerDisabledPlugins = new Set<string>();
  for (const layerName of ascending) {
    const layer = byLayer.get(layerName);
    const settings = layer?.settings;
    if (settings === undefined || settings === null) {
      continue;
    }
    const overrides = settings.skillOverrides ?? {};
    for (const name of Object.keys(overrides).sort()) {
      byName.set(name, layerName);
    }
    const enabled = settings.enabledPlugins ?? {};
    for (const key of Object.keys(enabled).sort()) {
      if (enabled[key] === false) {
        pluginDisabled.set(key, layerName);
      } else {
        // A higher-precedence `true` re-enables: remove the disable.
        pluginDisabled.delete(key);
      }
    }
    if (layerName === "local" || layerName === "project") {
      for (const name of Object.keys(overrides)) {
        lowerDisabledNames.add(name);
      }
      for (const [key, value] of Object.entries(enabled)) {
        if (value === false) {
          lowerDisabledPlugins.add(key);
        }
      }
    }
  }
  const overriddenByUser: string[] = [];
  for (const [name, layerName] of [...byName.entries()].sort()) {
    if (layerName === "user" && !lowerDisabledNames.has(name)) {
      overriddenByUser.push(name);
    }
  }
  for (const [key, layerName] of [...pluginDisabled.entries()].sort()) {
    if (layerName === "user" && !lowerDisabledPlugins.has(key)) {
      overriddenByUser.push(key);
    }
  }
  overriddenByUser.sort();
  return {
    disabledPlugins: [...pluginDisabled.keys()].sort(),
    skillOverrides: [...byName.keys()].sort(),
    overriddenByUser,
  };
}

/**
 * Collect marketplace declarations across layers. The highest-precedence
 * layer that declares a marketplace name wins its path; declarations
 * are returned in declaration order (sorted by name for determinism).
 */
export function mergeMarketplaces(
  layers: readonly ClaudeSettingsLayer[],
): MarketplaceDeclaration[] {
  const byName = new Map<string, MarketplaceDeclaration>();
  for (const layerName of SETTINGS_PRECEDENCE as readonly SettingsLayerName[]) {
    const layer = layers.find((entry) => entry.name === layerName);
    const entries = layer?.settings?.extraKnownMarketplaces ?? [];
    for (const entry of entries) {
      if (!byName.has(entry.name)) {
        byName.set(entry.name, entry);
      }
    }
  }
  return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : 1));
}

/** Collect additionalDirectories across layers (union, sorted). */
export function mergeAdditionalDirectories(
  layers: readonly ClaudeSettingsLayer[],
): string[] {
  const dirs = new Set<string>();
  for (const layer of layers) {
    for (const dir of layer.settings?.additionalDirectories ?? []) {
      dirs.add(dir);
    }
  }
  return [...dirs].sort();
}

/**
 * Whether the managed layer restricts marketplaces to the registered
 * set. Only the managed layer's value is honoured.
 */
export function managedStrictKnownMarketplaces(
  layers: readonly ClaudeSettingsLayer[],
): boolean {
  const managed = layers.find((layer) => layer.name === "managed");
  return managed?.settings?.strictKnownMarketplaces === true;
}

/** Resolve a fixture-relative path against fixtureDir (absolute passes through). */
export function resolveFixtureRelative(value: string, fixtureDir: string): string {
  return path.isAbsolute(value) ? value : path.resolve(fixtureDir, value);
}
