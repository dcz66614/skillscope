/**
 * Claude Code plugin marketplaces and plugin roots (P023 T008, S2).
 *
 * A marketplace is a directory that holds plugins; a plugin is a
 * directory that holds skills. Plugin roots handed to the PoC follow
 * the PoC's scan contract: a root is a directory whose immediate
 * subdirectories are skills (`<root>/<skill>/SKILL.md`, see the S0
 * c03 fixture, `plugin-acme/deploy/SKILL.md`).
 *
 * Layouts accepted (documented in claude-rules.json):
 *   - Default plugin directory `<home>/.claude/plugins`:
 *       `<plugins>/marketplaces/<marketplace>/<plugin>` (real layout)
 *       and flat `<plugins>/<plugin>` (adapter shorthand).
 *   - A declared directory marketplace `<marketplace>`:
 *       `<marketplace>/<plugin>/skills` when present, else
 *       `<marketplace>/<plugin>`.
 *   - An explicit extra plugin directory (`--plugin-dir` style):
 *       the directory itself is one plugin root.
 *
 * Registered vs extra: a plugin root is REGISTERED when it comes from
 * the default plugin directory or from a marketplace declared in a
 * settings layer (`extraKnownMarketplaces`). A root from an explicit
 * extra plugin directory that no settings layer declares is EXTRA:
 * the host loads it, but the settings' disable mapping was not
 * written against it — that is exactly the conflict the adapter
 * reports as DISABLE_MISMATCH (see adapter.ts).
 *
 * A marketplace directory that is declared but missing or unreadable
 * is not silently empty: the caller gets a
 * `missingMarketplaces` entry and the adapter reports
 * SOURCE_NOT_ENUMERATED for PLUGIN. A missing DEFAULT plugin
 * directory, by contrast, means no user plugins are installed and is
 * not an error. A git-source marketplace cannot be fetched offline:
 * it is reported as `unresolvableMarketplaces` and the adapter
 * reports it the same way.
 *
 * The module only reads directories. No writes, no network, no clock.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import type { MarketplaceDeclaration } from "./settings.js";

export interface PluginRootRecord {
  sourceRootId: string;
  /** Absolute path of the skill root handed to the PoC. */
  path: string;
  pluginName: string;
  /** Marketplace that provided the plugin, or null for the flat default dir / explicit dirs. */
  marketplace: string | null;
  registered: boolean;
}

export interface MarketplaceResolution {
  /** Plugin roots found, sorted by sourceRootId. */
  roots: PluginRootRecord[];
  /** Declared marketplace names whose directory is missing or unreadable. */
  missingMarketplaces: string[];
  /** Declared marketplace names with a git source (cannot be fetched offline). */
  unresolvableMarketplaces: string[];
  /** Plugin directory names that could not be read. */
  skippedPlugins: string[];
}

function sanitizeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/** Canonical sourceRootId for a plugin root. */
export function pluginSourceRootId(marketplace: string | null, plugin: string): string {
  const market = marketplace === null ? "default" : sanitizeSegment(marketplace);
  return `plugin-${market}-${sanitizeSegment(plugin)}`;
}

function listSubdirectories(dirAbs: string): string[] | null {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dirAbs, { withFileTypes: true });
  } catch {
    return null;
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

function isDirectory(dirAbs: string): boolean {
  try {
    return fs.statSync(dirAbs).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve one plugin directory to its skill root: `<plugin>/skills`
 * when present, else the plugin directory itself (S0 c03 layout).
 */
export function pluginSkillRoot(pluginDirAbs: string): string {
  const skillsDir = path.join(pluginDirAbs, "skills");
  return isDirectory(skillsDir) ? skillsDir : pluginDirAbs;
}

/**
 * Enumerate the plugins inside one marketplace directory. Returns
 * null when the marketplace directory itself cannot be listed.
 */
function enumerateMarketplacePlugins(
  marketplaceAbs: string,
  marketplaceName: string,
  registered: boolean,
  skipped: string[],
): PluginRootRecord[] | null {
  const plugins = listSubdirectories(marketplaceAbs);
  if (plugins === null) {
    return null;
  }
  const roots: PluginRootRecord[] = [];
  for (const plugin of plugins) {
    const pluginDir = path.join(marketplaceAbs, plugin);
    roots.push({
      sourceRootId: pluginSourceRootId(marketplaceName, plugin),
      path: pluginSkillRoot(pluginDir),
      pluginName: plugin,
      marketplace: marketplaceName,
      registered,
    });
  }
  return roots;
}

/**
 * Resolve marketplace declarations into plugin roots. `fixtureDir`
 * resolves relative marketplace paths. Directory declarations whose
 * directory cannot be listed land in `missingMarketplaces`; git-source
 * declarations land in `unresolvableMarketplaces` (never fetched).
 */
export function resolveMarketplaces(
  declarations: readonly MarketplaceDeclaration[],
  fixtureDir: string,
): MarketplaceResolution {
  const roots: PluginRootRecord[] = [];
  const missingMarketplaces: string[] = [];
  const unresolvableMarketplaces: string[] = [];
  const skippedPlugins: string[] = [];
  for (const declaration of declarations) {
    if (declaration.source?.type === "git") {
      unresolvableMarketplaces.push(declaration.name);
      continue;
    }
    const rawPath =
      declaration.path ?? declaration.source?.path;
    if (rawPath === undefined) {
      // Shape validation guarantees a path or a source; this is
      // defensive — treat a pathless declaration as missing.
      missingMarketplaces.push(declaration.name);
      continue;
    }
    const marketplaceAbs = path.isAbsolute(rawPath)
      ? rawPath
      : path.resolve(fixtureDir, rawPath);
    const found = enumerateMarketplacePlugins(
      marketplaceAbs,
      declaration.name,
      true,
      skippedPlugins,
    );
    if (found === null) {
      missingMarketplaces.push(declaration.name);
      continue;
    }
    roots.push(...found);
  }
  roots.sort((a, b) => (a.sourceRootId < b.sourceRootId ? -1 : 1));
  return {
    roots,
    missingMarketplaces: [...missingMarketplaces].sort(),
    unresolvableMarketplaces: [...unresolvableMarketplaces].sort(),
    skippedPlugins: [...skippedPlugins].sort(),
  };
}

/**
 * Enumerate the default plugin directory `<home>/.claude/plugins`.
 * Missing means no user plugins: empty roots, no error. The real
 * layout nests marketplaces under `marketplaces/<name>/`; flat plugin
 * directories directly under `plugins/` are also accepted.
 */
export function enumerateDefaultPluginDir(
  homeDirAbs: string,
): MarketplaceResolution {
  const pluginsDir = path.join(homeDirAbs, ".claude", "plugins");
  const roots: PluginRootRecord[] = [];
  const skippedPlugins: string[] = [];
  const marketplacesDir = path.join(pluginsDir, "marketplaces");
  const markets = listSubdirectories(marketplacesDir);
  if (markets !== null) {
    for (const market of markets) {
      const found = enumerateMarketplacePlugins(
        path.join(marketplacesDir, market),
        market,
        true,
        skippedPlugins,
      );
      if (found !== null) {
        roots.push(...found);
      }
    }
  }
  const flat = listSubdirectories(pluginsDir);
  if (flat !== null) {
    for (const plugin of flat) {
      if (plugin === "marketplaces" || plugin === "cache") {
        continue;
      }
      const pluginDir = path.join(pluginsDir, plugin);
      roots.push({
        sourceRootId: pluginSourceRootId(null, plugin),
        path: pluginSkillRoot(pluginDir),
        pluginName: plugin,
        marketplace: null,
        registered: true,
      });
    }
  }
  roots.sort((a, b) => (a.sourceRootId < b.sourceRootId ? -1 : 1));
  return {
    roots,
    missingMarketplaces: [],
    unresolvableMarketplaces: [],
    skippedPlugins: [...skippedPlugins].sort(),
  };
}

/**
 * Turn explicit extra plugin directories (--plugin-dir style) into
 * plugin roots. Each directory is one plugin; the plugin name is the
 * directory's basename unless the caller names a marketplace. These
 * roots are EXTRA (registered: false) unless the caller marks them
 * registered.
 */
export function extraPluginDirRoots(
  dirs: readonly { path: string; marketplace?: string; pluginName?: string }[],
  fixtureDir: string,
): PluginRootRecord[] {
  const roots: PluginRootRecord[] = [];
  for (const dir of dirs) {
    const dirAbs = path.isAbsolute(dir.path)
      ? dir.path
      : path.resolve(fixtureDir, dir.path);
    const pluginName =
      dir.pluginName ?? path.basename(dirAbs);
    roots.push({
      sourceRootId: pluginSourceRootId(dir.marketplace ?? null, pluginName),
      path: pluginSkillRoot(dirAbs),
      pluginName,
      marketplace: dir.marketplace ?? null,
      registered: false,
    });
  }
  roots.sort((a, b) => (a.sourceRootId < b.sourceRootId ? -1 : 1));
  return roots;
}
