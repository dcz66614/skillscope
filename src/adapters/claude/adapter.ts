/**
 * Claude Code full read-only adapter (P023 T008, S2).
 *
 * The T003 PoC (`claude-poc.ts`) is the S0 production side and is NOT
 * modified here: the S0 gate calls it directly, and this adapter layers
 * on top of it. The adapter wires the host's real settings files and
 * plugin marketplaces into the T006 rule engine (`src/resolver`),
 * adding the checks the PoC does not own:
 *
 *   1. Settings layers (§4.4, Claude Code docs "Settings files and
 *      precedence"): managed > user > project > local. Each layer is
 *      loaded from an explicit path or from the fixture home/repo
 *      defaults; a layer file that is present but unreadable, invalid
 *      JSON, or invalid in shape makes that layer's effect unknowable
 *      (ADR-009) — INCOMPLETE with an unknown scope named after the
 *      layer (MANAGED_SETTINGS / USER_SETTINGS / PROJECT_SETTINGS /
 *      LOCAL_SETTINGS). A missing layer file is not an error.
 *   2. Effective disables: `enabledPlugins` ("plugin@marketplace" or
 *      bare "plugin" → boolean; false disables) and `skillOverrides`
 *      (name → "off") merged by precedence. A USER-layer disable of a
 *      skill the PROJECT layer would otherwise load is applied
 *      (instance DISABLED) and recorded in
 *      `diagnostics.overriddenByUser`; it is deterministic, not
 *      INCOMPLETE.
 *   3. Plugin marketplaces: `extraKnownMarketplaces` directory entries
 *      and the default `<home>/.claude/plugins` directory are
 *      enumerated as PLUGIN roots (`<marketplace>/<plugin>/skills`
 *      when present, else `<marketplace>/<plugin>`). A declared
 *      marketplace that is missing/unreadable is SOURCE_NOT_ENUMERATED
 *      for PLUGIN; a git-source marketplace cannot be fetched offline
 *      and is reported the same way, never silently ignored.
 *   4. Extra plugin directories (--plugin-dir style) are EXTRA roots:
 *      the host loads them, but the settings' disable mapping was not
 *      written against them. A plugin disabled by `enabledPlugins` in
 *      registered roots but still ELIGIBLE from an extra directory is
 *      DISABLE_MISMATCH (P1, FAIL). `skillOverrides` disables cover
 *      every root by construction, so they cannot produce this conflict.
 *   5. Trust gating: when `trusted` is false, settings-derived ADD_DIR
 *      roots (`additionalDirectories`) and marketplace roots do not
 *      load — their instances are DISCOVERED, never ELIGIBLE.
 *      `strictKnownMarketplaces` (managed layer only) refuses
 *      unregistered extra plugin directories the same way.
 *   6. Namespace reconciliation: plugin skills (`acme:deploy`) and
 *      bare skills (`deploy`) are distinct instances; the adapter
 *      records the observed pairs in diagnostics and never merges them.
 *   7. Full-manifest re-check (T005 parser): skills the PoC's minimal
 *      parser passes but the full parser rejects gain INVALID_MANIFEST
 *      (P2); PoC-flagged skills are not double-reported.
 *   8. T005 bounded discovery over the derived PLUGIN / ADD_DIR roots
 *      so a symlink escaping the scan root becomes SYMLINK_OUTSIDE_ROOT
 *      through the kernel.
 *   9. Standard-source completeness gate (FIX-R1, P1-R1-03 / P0-R1-03):
 *      PERSONAL and PROJECT are fixed locations, so the adapter
 *      derives their roots from homeDir / repoDir when the profile
 *      omits them but skills sit on disk there (or the directory
 *      cannot be read); the synced directory is handed to the PoC so
 *      undeclared account-synced skills make ACCOUNT_SYNC UNKNOWN.
 *      A scope the profile already declares is never re-derived.
 *      NESTED (session-visited only) and ENTERPRISE (managed-settings
 *      directory, not a fixed path) are not derived.
 *
 * Policy (ADR-005/ADR-006) is owned by the kernel: the adapter passes
 * the caller's policy through to `resolveClaudeAudit` and never
 * compares policy itself. The effective set is ELIGIBLE only, so a
 * DISCOVERED skill (trust-gated, strict-refused, or host flag off)
 * never leaks and an UNKNOWN skill never leaks either — it fails
 * closed as INCOMPLETE instead.
 *
 * Read-only: the adapter only reads settings / marketplace / SKILL.md
 * files. It never writes settings.json, settings.local.json,
 * managed-settings.json or any plugin marketplace config, never calls
 * the Claude API, never reads the real user home directory (defaults
 * resolve under the caller-supplied fixture home/repo dirs), and never
 * flattens a plugin namespace. Finding details never contain absolute
 * paths: paths are reported fixture-relative or by skill name.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverSkillRoot } from "../../discovery/discovery.js";
import { classifyPath, isContentUnknownSkip } from "../../fsutil/index.js";
import { parseManifest } from "../../manifest/manifest.js";
import type { PolicyV1 } from "../../policy/index.js";
import {
  resolveClaudeAudit,
  type AuditResult,
  type DiscoveryInput,
} from "../../resolver/index.js";
import {
  resolveClaudeFixture,
  type ClaudePocFinding,
  type ClaudePocResult,
  type ClaudeSourceRootInput,
} from "./claude-poc.js";
import {
  scanSkillRoot,
} from "../shared/skill-scan.js";
import {
  enumerateDefaultPluginDir,
  extraPluginDirRoots,
  resolveMarketplaces,
  type PluginRootRecord,
} from "./marketplace.js";
import {
  isLayerUnknown,
  loadSettingsLayer,
  managedStrictKnownMarketplaces,
  mergeAdditionalDirectories,
  mergeEffectiveDisables,
  mergeMarketplaces,
  resolveFixtureRelative,
  unknownScopeForLayer,
  type ClaudeSettingsLayer,
  type SettingsLayerName,
} from "./settings.js";

export type SettingsLayerStatus = ClaudeSettingsLayer["status"];

export interface ExtraPluginDirInput {
  /** Fixture-relative (or absolute) path of the plugin directory. */
  path: string;
  /** Marketplace the directory belongs to, if any. */
  marketplace?: string;
  /** Plugin name; defaults to the directory basename. */
  pluginName?: string;
}

export interface ClaudeAdapterInput {
  profileId: string;
  cwd: string;
  /**
   * Caller-provided PoC source roots (ENTERPRISE / PERSONAL / PROJECT /
   * NESTED / ADD_DIR / ACCOUNT_SYNC). Caller-provided PLUGIN roots are
   * accepted too and treated as registered.
   */
  sourceRoots: ClaudeSourceRootInput[];
  /** Explicit settings-layer paths (fixture-relative when given). */
  managedSettingsPath?: string;
  userSettingsPath?: string;
  projectSettingsPath?: string;
  localSettingsPath?: string;
  /** Synthetic home dir for default paths (fixture-relative). Defaults to os.homedir(). */
  homeDir?: string;
  /** Repo dir for default project/local settings paths (fixture-relative). Defaults to cwd. */
  repoDir?: string;
  /** Extra plugin directories (--plugin-dir style). NOT registered in settings. */
  extraPluginDirs?: readonly ExtraPluginDirInput[];
  /** Caller-provided name-based disables; settings layers win per name. */
  skillOverrides?: Record<string, "off">;
  /** Whether the folder is trusted (settings additionalDirectories / marketplaces apply only after trust). Default true. */
  trusted?: boolean;
  /** User policy, passed through to the kernel (ADR-005). */
  policy?: PolicyV1;
  /** Directory fixture-relative paths resolve against. Defaults to process.cwd(). */
  fixtureDir?: string;
}

export interface ClaudeAdapterResult {
  profileId: string;
  /** Settings layers in precedence order (managed first). */
  settingsLayers: ClaudeSettingsLayer[];
  /** Effective disables after the precedence merge. */
  effectiveDisables: {
    disabledPlugins: string[];
    skillOverrides: string[];
    overriddenByUser: string[];
  };
  /** Plugin roots handed to the PoC (registered + extra), sorted by sourceRootId. */
  pluginRoots: PluginRootRecord[];
  audit: AuditResult;
  diagnostics: {
    overriddenByUser: string[];
    /** Plugin names disabled in registered roots but ELIGIBLE from an extra directory. */
    extraPluginConflicts: string[];
    /** Declared marketplace names whose directory is missing or unreadable. */
    missingMarketplaces: string[];
    /** Declared marketplace names with a git source (unresolvable offline). */
    unresolvableMarketplaces: string[];
    /** ADD_DIR roots that were missing or unreadable (also in the PoC coverage). */
    missingAdditionalDirs: string[];
    manifestRechecks: {
      checked: number;
      /** Canonical instance ids the full parser rejects. */
      invalid: string[];
    };
    /** Observed bare-vs-namespaced coexistence pairs (never merged). */
    namespacePairs: Array<{
      baseName: string;
      bare: string | null;
      namespaced: string[];
    }>;
    untrusted: boolean;
    strictKnownMarketplaces: boolean;
  };
}

interface RootInfo {
  sourceRootId: string;
  pathAbs: string;
  scope: string;
  pluginName?: string;
  marketplace?: string | null;
  registered: boolean;
  /** Settings-derived root that does not load until the folder is trusted. */
  trustGated: boolean;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort();
}

/** Does a disabledPlugins entry cover this plugin root? */
function pluginDisabledBy(
  disabledPlugins: readonly string[],
  pluginName: string,
  marketplace: string | null,
): boolean {
  for (const entry of disabledPlugins) {
    const at = entry.indexOf("@");
    if (at < 0) {
      if (entry === pluginName) {
        return true;
      }
    } else if (
      entry.slice(0, at) === pluginName &&
      entry.slice(at + 1) === marketplace
    ) {
      return true;
    }
  }
  return false;
}

function sourceNotEnumerated(
  sourceScope: string,
  detail: string,
): ClaudePocFinding {
  return {
    id: "SOURCE_NOT_ENUMERATED",
    severity: "P1",
    sourceScope,
    detail,
    instanceIds: [],
  };
}

/**
 * Strip absolute paths from a finding detail. The frozen PoC embeds the
 * absolute root path in its missing-root detail; the adapter's output
 * contract (§4.2 rule 5) forbids absolute paths in finding text, so
 * the adapter rewrites the fixture-dir prefix to `<FIXTURE_DIR>`.
 * The PoC itself is NOT modified (S0 frozen).
 */
function sanitizeDetail(detail: string, fixtureDir: string): string {
  if (detail.includes(fixtureDir)) {
    return detail.split(fixtureDir).join("<FIXTURE_DIR>");
  }
  return detail;
}

function dedupeRootIds(roots: RootInfo[], protectedIds: ReadonlySet<string>): RootInfo[] {
  const seen = new Set<string>(protectedIds);
  const out: RootInfo[] = [];
  for (const root of roots) {
    if (protectedIds.has(root.sourceRootId)) {
      // Caller-provided roots keep their ids (they are already in the
      // PoC input under that id); never rename them.
      out.push(root);
      continue;
    }
    let id = root.sourceRootId;
    let n = 2;
    while (seen.has(id)) {
      id = `${root.sourceRootId}-${n}`;
      n += 1;
    }
    seen.add(id);
    out.push(id === root.sourceRootId ? root : { ...root, sourceRootId: id });
  }
  return out;
}

/**
 * Run the full Claude Code audit: load the settings layers, derive
 * plugin and additional-directory roots, run the frozen PoC, apply the
 * adapter's completeness checks, and hand the result to the T006
 * kernel for policy comparison and status derivation.
 */
export function auditClaude(input: ClaudeAdapterInput): ClaudeAdapterResult {
  const fixtureDir =
    input.fixtureDir !== undefined
      ? path.resolve(input.fixtureDir)
      : process.cwd();
  const homeDir =
    input.homeDir !== undefined
      ? resolveFixtureRelative(input.homeDir, fixtureDir)
      : os.homedir();
  const repoDir =
    input.repoDir !== undefined
      ? resolveFixtureRelative(input.repoDir, fixtureDir)
      : path.resolve(fixtureDir, input.cwd);
  const trusted = input.trusted !== false;

  // ---- 0. Standard-source completeness gate (FIX-R1, P1-R1-03 /
  // P0-R1-03). PERSONAL (`~/.claude/skills`) and PROJECT
  // (`<repo>/.claude/skills`) are fixed, well-known locations. A
  // profile that omits them while skills sit on disk at those
  // locations used to audit PASS with the skills — and any policy on
  // their scopes — silently unenumerated. Derive the root when the
  // directory holds skills or cannot be read; a missing or empty
  // directory is a known absence and derives nothing. NESTED is not
  // derived: it depends on which subdirectories the session actually
  // visited, and an unvisited nested directory is a known absence,
  // not unknown content. ENTERPRISE comes from the managed-settings
  // directory, not a fixed path, so it is not derived either.
  // ACCOUNT_SYNC is handled by the PoC via `accountSyncDir`: without
  // a snapshot there is nothing to enumerate synced skills from, so
  // the PoC reports the scope UNKNOWN when synced skills exist on
  // disk (P0-R1-03). A scope the profile already declares is never
  // re-derived, whatever path the profile gives it.
  const declaredScopes = new Set(input.sourceRoots.map((root) => root.scope));
  const declaredIds = new Set(input.sourceRoots.map((root) => root.sourceRootId));
  const derivedRoots: ClaudeSourceRootInput[] = [];
  const deriveStandardRoot = (
    scope: "PERSONAL" | "PROJECT",
    sourceRootId: string,
    dirAbs: string,
  ): void => {
    if (declaredScopes.has(scope)) {
      return;
    }
    const access = classifyPath(dirAbs);
    if (access === "missing") {
      return;
    }
    let id = sourceRootId;
    let n = 2;
    while (declaredIds.has(id)) {
      id = `${sourceRootId}-${n}`;
      n += 1;
    }
    declaredIds.add(id);
    if (access === "unreadable") {
      // The PoC reports the root unknown (ROOT_MISSING_OR_UNREADABLE).
      derivedRoots.push({ sourceRootId: id, scope, path: dirAbs, required: true });
      return;
    }
    const scanned = scanSkillRoot(dirAbs);
    if (
      scanned.skills.length > 0 ||
      scanned.skipped.some((entry) =>
        isContentUnknownSkip(entry.reason, entry.code),
      )
    ) {
      derivedRoots.push({ sourceRootId: id, scope, path: dirAbs, required: true });
    }
  };
  deriveStandardRoot(
    "PERSONAL",
    "personal",
    path.join(homeDir, ".claude", "skills"),
  );
  deriveStandardRoot(
    "PROJECT",
    "project",
    path.join(repoDir, ".claude", "skills"),
  );
  const accountSyncDir = declaredScopes.has("ACCOUNT_SYNC")
    ? undefined
    : path.join(homeDir, ".claude", "skills", "synced");

  // ---- 1. Settings layers. ----
  const layerPaths: Record<SettingsLayerName, string | null> = {
    managed:
      input.managedSettingsPath !== undefined
        ? resolveFixtureRelative(input.managedSettingsPath, fixtureDir)
        : null,
    user:
      input.userSettingsPath !== undefined
        ? resolveFixtureRelative(input.userSettingsPath, fixtureDir)
        : path.join(homeDir, ".claude", "settings.json"),
    project:
      input.projectSettingsPath !== undefined
        ? resolveFixtureRelative(input.projectSettingsPath, fixtureDir)
        : path.join(repoDir, ".claude", "settings.json"),
    local:
      input.localSettingsPath !== undefined
        ? resolveFixtureRelative(input.localSettingsPath, fixtureDir)
        : path.join(repoDir, ".claude", "settings.local.json"),
  };
  const layers: ClaudeSettingsLayer[] = (
    ["managed", "user", "project", "local"] as const
  ).map((name) => loadSettingsLayer(name, layerPaths[name]));
  const effectiveDisables = mergeEffectiveDisables(layers);
  const marketplaces = mergeMarketplaces(layers);
  const additionalDirs = mergeAdditionalDirectories(layers);
  const strictKnown = managedStrictKnownMarketplaces(layers);

  // ---- 2. Plugin roots: registered marketplaces + default dir + extra dirs. ----
  const marketplaceResolution = resolveMarketplaces(marketplaces, fixtureDir);
  const defaultResolution = enumerateDefaultPluginDir(homeDir);
  const extraRoots = extraPluginDirRoots(input.extraPluginDirs ?? [], fixtureDir);

  const rootInfos: RootInfo[] = [];
  const pushPluginRoot = (
    record: PluginRootRecord,
    trustGated: boolean,
  ): void => {
    rootInfos.push({
      sourceRootId: record.sourceRootId,
      pathAbs: record.path,
      scope: "PLUGIN",
      pluginName: record.pluginName,
      marketplace: record.marketplace,
      registered: record.registered,
      trustGated,
    });
  };
  for (const record of marketplaceResolution.roots) {
    pushPluginRoot(record, true);
  }
  for (const record of defaultResolution.roots) {
    pushPluginRoot(record, false);
  }
  for (const record of extraRoots) {
    // Extra dirs live in their own sourceRootId namespace so they can
    // never collide with a registered root for the same plugin.
    const extra: PluginRootRecord = {
      ...record,
      sourceRootId: `plugin-extra-${record.marketplace === null ? "default" : record.marketplace}-${record.pluginName}`,
    };
    pushPluginRoot(extra, false);
  }
  // Caller-provided PLUGIN roots are registered by definition; record
  // them so plugin-level disables and discovery cover them too.
  for (const root of input.sourceRoots) {
    if (root.scope !== "PLUGIN") {
      continue;
    }
    rootInfos.push({
      sourceRootId: root.sourceRootId,
      pathAbs: path.isAbsolute(root.path)
        ? root.path
        : path.resolve(fixtureDir, root.path),
      scope: "PLUGIN",
      pluginName: root.pluginName,
      marketplace: null,
      registered: true,
      trustGated: false,
    });
  }

  // ---- 3. ADD_DIR roots from settings additionalDirectories. ----
  const addDirRootIds: string[] = [];
  const missingAdditionalDirs: string[] = [];
  additionalDirs.forEach((dir, index) => {
    const dirAbs = resolveFixtureRelative(dir, fixtureDir);
    const skillsAbs = path.join(dirAbs, ".claude", "skills");
    const sourceRootId = `adddir-${index + 1}`;
    addDirRootIds.push(sourceRootId);
    if (!fs.existsSync(skillsAbs)) {
      missingAdditionalDirs.push(dir);
    }
    rootInfos.push({
      sourceRootId,
      pathAbs: skillsAbs,
      scope: "ADD_DIR",
      registered: true,
      trustGated: true,
    });
  });

  const callerIds = new Set(input.sourceRoots.map((root) => root.sourceRootId));
  const dedupedRoots = dedupeRootIds(rootInfos, callerIds);
  const rootInfoById = new Map(dedupedRoots.map((root) => [root.sourceRootId, root]));

  // ---- 4. PoC run. ----
  // FIX-R1: the standard roots derived in step 0 join the PoC input,
  // so an omitted PERSONAL / PROJECT root with skills on disk is
  // enumerated (or reported unknown) instead of silently absent.
  const pocRoots: ClaudeSourceRootInput[] = [...input.sourceRoots, ...derivedRoots];
  for (const root of dedupedRoots) {
    if (callerIds.has(root.sourceRootId)) {
      // Already in the PoC input under this id; do not add it twice.
      continue;
    }
    if (root.scope === "PLUGIN") {
      pocRoots.push({
        sourceRootId: root.sourceRootId,
        scope: "PLUGIN",
        path: root.pathAbs,
        required: true,
        ...(root.pluginName !== undefined ? { pluginName: root.pluginName } : {}),
      });
    } else {
      pocRoots.push({
        sourceRootId: root.sourceRootId,
        scope: "ADD_DIR",
        path: root.pathAbs,
        required: true,
      });
    }
  }
  const mergedOverrides: Record<string, "off"> = {
    ...(input.skillOverrides ?? {}),
  };
  for (const name of effectiveDisables.skillOverrides) {
    mergedOverrides[name] = "off";
  }
  const poc: ClaudePocResult = resolveClaudeFixture(
    {
      profileId: input.profileId,
      cwd: input.cwd,
      sourceRoots: pocRoots,
      skillOverrides: mergedOverrides,
      // FIX-R1 (P0-R1-03): the synced directory, for the PoC's
      // undeclared-ACCOUNT_SYNC check. Undefined when the profile
      // declares an ACCOUNT_SYNC root.
      ...(accountSyncDir !== undefined ? { accountSyncDir } : {}),
      ...(input.policy !== undefined
        ? {
            policy: {
              ...(input.policy.allowedScopes !== undefined
                ? { allowedScopes: input.policy.allowedScopes }
                : {}),
              ...(input.policy.forbiddenScopes !== undefined
                ? { forbiddenScopes: input.policy.forbiddenScopes }
                : {}),
            },
          }
        : {}),
    },
    fixtureDir,
  );

  // ---- 5. Post-process instance statuses. ----
  const instances = poc.instances.map((inst) => ({ ...inst }));
  // Trust gating and strict-marketplace refusal first: the host does
  // not load these skills, so they are DISCOVERED, not ELIGIBLE.
  for (const inst of instances) {
    if (inst.status !== "ELIGIBLE") {
      continue;
    }
    const info = rootInfoById.get(inst.sourceRootId);
    if (info === undefined) {
      continue;
    }
    const trustBlocked = !trusted && info.trustGated;
    const strictBlocked =
      strictKnown && info.scope === "PLUGIN" && !info.registered;
    if (trustBlocked || strictBlocked) {
      inst.status = "DISCOVERED";
    }
  }
  // Plugin-level disables (enabledPlugins) apply to registered plugin
  // roots only, and only to instances the host would otherwise load.
  // The instance ids disabled here are recorded: only a plugin-level
  // disable can produce the extra-dir DISABLE_MISMATCH below (a
  // skillOverrides disable covers every root by construction).
  const disabledByPluginMapping = new Set<string>();
  for (const inst of instances) {
    if (inst.status !== "ELIGIBLE") {
      continue;
    }
    const info = rootInfoById.get(inst.sourceRootId);
    if (
      info === undefined ||
      info.scope !== "PLUGIN" ||
      !info.registered ||
      info.pluginName === undefined
    ) {
      continue;
    }
    if (
      pluginDisabledBy(
        effectiveDisables.disabledPlugins,
        info.pluginName,
        info.marketplace ?? null,
      )
    ) {
      inst.status = "DISABLED";
      disabledByPluginMapping.add(inst.instanceId);
    }
  }

  const extraFindings: ClaudePocFinding[] = [];
  const extraUnknownScopes: string[] = [];
  const diagnostics: ClaudeAdapterResult["diagnostics"] = {
    overriddenByUser: effectiveDisables.overriddenByUser,
    extraPluginConflicts: [],
    missingMarketplaces: marketplaceResolution.missingMarketplaces,
    unresolvableMarketplaces: marketplaceResolution.unresolvableMarketplaces,
    missingAdditionalDirs,
    manifestRechecks: { checked: 0, invalid: [] },
    namespacePairs: [],
    untrusted: !trusted,
    strictKnownMarketplaces: strictKnown,
  };

  // ---- 6a. Unreadable settings layers (ADR-009). ----
  for (const layer of layers) {
    if (!isLayerUnknown(layer)) {
      continue;
    }
    const scope = unknownScopeForLayer(layer);
    extraUnknownScopes.push(scope);
    extraFindings.push(
      sourceNotEnumerated(
        scope,
        `${layer.name} settings could not be read (${layer.status}: ${layer.errors.join("; ")}); ` +
          `its overrides of lower layers cannot be determined`,
      ),
    );
  }

  // ---- 6b. Missing / unresolvable marketplaces. ----
  for (const name of marketplaceResolution.missingMarketplaces) {
    extraUnknownScopes.push("PLUGIN");
    extraFindings.push(
      sourceNotEnumerated(
        "PLUGIN",
        `declared marketplace "${name}" is missing or unreadable; its plugins cannot be enumerated`,
      ),
    );
  }
  for (const name of marketplaceResolution.unresolvableMarketplaces) {
    extraUnknownScopes.push("PLUGIN");
    extraFindings.push(
      sourceNotEnumerated(
        "PLUGIN",
        `declared marketplace "${name}" is a git source and cannot be fetched offline; its plugins cannot be enumerated`,
      ),
    );
  }

  // ---- 6c. Extra-dir disable conflict (DISABLE_MISMATCH). Only a
  // plugin-level disable (enabledPlugins) can produce it: the plugin
  // is disabled in registered roots, yet the same plugin name is
  // still ELIGIBLE from an unregistered extra directory.
  const disabledPluginNames = new Set<string>();
  for (const id of disabledByPluginMapping) {
    const inst = instances.find((entry) => entry.instanceId === id);
    const info =
      inst === undefined ? undefined : rootInfoById.get(inst.sourceRootId);
    if (info?.pluginName !== undefined) {
      disabledPluginNames.add(info.pluginName);
    }
  }
  const conflictPlugins = new Set<string>();
  for (const inst of instances) {
    if (inst.status !== "ELIGIBLE") {
      continue;
    }
    const info = rootInfoById.get(inst.sourceRootId);
    if (
      info === undefined ||
      info.scope !== "PLUGIN" ||
      info.registered ||
      info.pluginName === undefined ||
      !disabledPluginNames.has(info.pluginName)
    ) {
      continue;
    }
    conflictPlugins.add(info.pluginName);
    extraFindings.push({
      id: "DISABLE_MISMATCH",
      severity: "P1",
      sourceScope: "PLUGIN",
      detail:
        `plugin "${info.pluginName}" is disabled by settings in registered roots ` +
        `but skill "${inst.logicalName}" is still ELIGIBLE from unregistered extra plugin directory ` +
        `(source root ${inst.sourceRootId}); the disable mapping does not cover it`,
      instanceIds: [inst.instanceId],
    });
  }
  diagnostics.extraPluginConflicts = [...conflictPlugins].sort();

  // ---- 6d. Full-manifest re-check (T005 parser over the PoC minimum). ----
  const rootPathById = new Map<string, string>();
  for (const root of pocRoots) {
    rootPathById.set(
      root.sourceRootId,
      path.isAbsolute(root.path) ? root.path : path.resolve(fixtureDir, root.path),
    );
  }
  for (const inst of instances) {
    if (inst.relativePath.startsWith("snapshot/")) {
      continue;
    }
    const rootPath = rootPathById.get(inst.sourceRootId);
    if (rootPath === undefined) {
      continue;
    }
    let content: string;
    try {
      content = fs.readFileSync(path.join(rootPath, inst.relativePath), "utf8");
    } catch {
      continue;
    }
    const alreadyFlagged = poc.findings.some(
      (finding) =>
        finding.id === "INVALID_MANIFEST" &&
        finding.instanceIds.includes(inst.instanceId),
    );
    if (alreadyFlagged) {
      continue;
    }
    diagnostics.manifestRechecks.checked += 1;
    const manifest = parseManifest(content);
    if (!manifest.valid) {
      diagnostics.manifestRechecks.invalid.push(inst.instanceId);
      extraFindings.push({
        id: "INVALID_MANIFEST",
        severity: "P2",
        sourceScope: inst.sourceScope,
        detail: `SKILL.md for "${inst.logicalName}" fails full frontmatter validation: ${manifest.errors.join(", ")}`,
        instanceIds: [inst.instanceId],
      });
    }
  }

  // ---- 6e. Namespace coexistence pairs (observed, never merged). ----
  const bareByBase = new Map<string, string>();
  const namespacedByBase = new Map<string, string[]>();
  for (const inst of instances) {
    if (inst.status === "INVALID") {
      continue;
    }
    const colon = inst.logicalName.indexOf(":");
    if (colon < 0) {
      bareByBase.set(inst.logicalName, inst.logicalName);
    } else {
      const base = inst.logicalName.slice(colon + 1);
      const group = namespacedByBase.get(base) ?? [];
      group.push(inst.logicalName);
      namespacedByBase.set(base, group);
    }
  }
  for (const [base, namespaced] of [...namespacedByBase.entries()].sort()) {
    diagnostics.namespacePairs.push({
      baseName: base,
      bare: bareByBase.get(base) ?? null,
      namespaced: [...new Set(namespaced)].sort(),
    });
  }

  // ---- 7. T005 discovery over every scanned root (symlink escapes).
  // Caller roots are included: the PoC follows symlinks without
  // checking whether they escape the scan root.
  const discoveryInputs: DiscoveryInput[] = [];
  const seenDiscoveryRoots = new Set<string>();
  for (const root of pocRoots) {
    if (root.scope === "ACCOUNT_SYNC" || root.path === "") {
      continue;
    }
    const rootAbs = path.isAbsolute(root.path)
      ? root.path
      : path.resolve(fixtureDir, root.path);
    if (seenDiscoveryRoots.has(rootAbs)) {
      continue;
    }
    seenDiscoveryRoots.add(rootAbs);
    const result = discoverSkillRoot(rootAbs);
    discoveryInputs.push({ sourceScope: root.scope, skipped: result.skipped });
  }

  // ---- 8. Kernel (ADR-005/ADR-006): policy + status derivation. ----
  // PoC finding details are sanitised first: the frozen PoC embeds
  // absolute root paths in its missing-root detail, and the adapter's
  // output contract forbids absolute paths in finding text.
  const sanitizedPocFindings = poc.findings.map((finding) => ({
    ...finding,
    detail: sanitizeDetail(finding.detail, fixtureDir),
  }));
  const modifiedPoc: ClaudePocResult = {
    ...poc,
    instances,
    findings: [...sanitizedPocFindings, ...extraFindings],
    coverage: {
      enumeratedSources: poc.coverage.enumeratedSources,
      requiredSources: poc.coverage.requiredSources,
      unknownScopes: sortedUnique([
        ...poc.coverage.unknownScopes,
        ...extraUnknownScopes,
      ]),
    },
  };
  const audit = resolveClaudeAudit(modifiedPoc, input.policy, discoveryInputs);

  // Plugin roots for the report (registered + extra, by sourceRootId).
  const pluginRoots: PluginRootRecord[] = dedupedRoots
    .filter((root) => root.scope === "PLUGIN")
    .map((root) => ({
      sourceRootId: root.sourceRootId,
      path: root.pathAbs,
      pluginName: root.pluginName ?? "",
      marketplace: root.marketplace ?? null,
      registered: root.registered,
    }))
    .sort((a, b) => (a.sourceRootId < b.sourceRootId ? -1 : 1));

  return {
    profileId: input.profileId,
    settingsLayers: layers,
    effectiveDisables: {
      disabledPlugins: effectiveDisables.disabledPlugins,
      skillOverrides: effectiveDisables.skillOverrides,
      overriddenByUser: effectiveDisables.overriddenByUser,
    },
    pluginRoots,
    audit,
    diagnostics,
  };
}
