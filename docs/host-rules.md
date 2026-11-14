# Host rules

SkillScope resolves skill scope for three hosts. The rules below are the frozen, implemented behaviour — not a summary of the hosts' documentation. Where a host's behaviour cannot be determined from public config, the audit reports INCOMPLETE instead of guessing.

The frozen rule matrices live in the repo: `src/adapters/claude/claude-rules.json` (`skillscope.claude-rules/v1`), `src/adapters/openmausbot/openmausbot-snapshot-v1.json` (`openmausbot-snapshot/v1`), and the Codex PoC (`skillscope.codex-poc-result/v1`).

## Shared semantics (all hosts)

- **Instance identity** is `source root + canonical path + content hash`. Two paths with the same name are two instances; two paths with identical content are two instances. A symlink alias of one real path merges into that instance and keeps the alias.
- **Effective set = ELIGIBLE only.** A skill the host discovered but did not load (flag off, untrusted folder) is DISCOVERED: it is reported, but it does not leak and does not mismatch. The audit describes the current state; it does not warn about a flag being flipped later.
- **Unknown is INCOMPLETE, never empty.** A source that was not enumerated is reported as unknown. It is never treated as an empty set, and an audit with an unknown required source can never be PASS.
- **Policy comparison belongs to the rule engine.** The adapters report what the host would load; the engine compares the effective set against the profile policy and emits the policy findings. The profile policy is always passed through — a missing passthrough would silently drop every policy finding.
- **Unknown host versions are INCOMPLETE.** A snapshot or config whose version is not recognised is not audited under old rules.

## Codex

Sources: `config.toml`, `bundled.json`, `plugins.json`; scopes REPO, USER, ADMIN, SYSTEM, PLUGIN.

- REPO skills come from `<repo>/.agents/skills`; USER from `<home>/.agents/skills`; ADMIN from the admin root's `skills/` directory.
- SYSTEM skills come from `config.toml` / `bundled.json`; PLUGIN skills from `plugins.json`.
- A name selector (for example disabling `deploy`) applies to every instance with that logical name, across roots. When it hits more than one distinct instance, that is `NAME_SELECTOR_BLAST_RADIUS` (P1, FAIL).
- A config file that exists but cannot be read or parsed makes its scope unknown (fail-closed): SYSTEM / PLUGIN report unknown, never silently empty.
- The ADMIN root is the dirname of the ADMIN source root's path in the profile (the path names the skills directory, for example `./admin/skills`); without an ADMIN root it defaults to `<profileDir>/admin`.

## Claude Code

Sources: settings layers, marketplaces, extra plugin directories, additional directories, account sync. Scopes: ENTERPRISE, PERSONAL, PROJECT, NESTED, ADD_DIR, PLUGIN, ACCOUNT_SYNC.

- **Settings precedence:** managed > user > project > local. Managed settings cannot be overridden. A settings layer file that is present but unreadable, invalid JSON, or invalid in shape makes that layer's effect unknowable: INCOMPLETE with an unknown scope named after the layer (`MANAGED_SETTINGS` / `USER_SETTINGS` / `PROJECT_SETTINGS` / `LOCAL_SETTINGS`). A missing layer file is not an error.
- **Disabling plugins** reads the documented `enabledPlugins` key (`"<plugin>@<marketplace>": false`, or a bare `"<plugin>": false` for every marketplace). `disabledPlugins` is not a Claude Code settings key and is not read.
- **Disabling skills** reads `skillOverrides` (`"<logical name>": "off"`). Namespaces are never flattened: `acme:deploy` and `deploy` are two instances, and disabling one never touches the other.
- **User overrides are deterministic.** A readable USER layer disabling a skill the PROJECT layer would load is applied (instance DISABLED) and recorded in `diagnostics.overriddenByUser` — not INCOMPLETE.
- **Marketplaces:** the default plugin directory is `<home>/.claude/plugins`; marketplaces are discovered as `<plugins>/marketplaces/<marketplace>/<plugin>` and as flat `<plugins>/<plugin>`. A git-source marketplace that cannot be fetched offline is INCOMPLETE, never silently ignored. With `strictKnownMarketplaces` (managed layer only), skills from unregistered extra plugin directories are DISCOVERED, not ELIGIBLE.
- **Trust gating:** `additionalDirectories` and marketplace roots apply only after the folder is trusted. In an untrusted folder their skills are DISCOVERED, never ELIGIBLE.
- **Account sync:** account-synced skills are enumerable only from a host snapshot. Without one, ACCOUNT_SYNC is `SOURCE_NOT_ENUMERATED` / INCOMPLETE.
- **Extra plugin directory conflict:** a plugin disabled by `enabledPlugins` in registered roots but still loadable (ELIGIBLE) from an unregistered extra plugin directory is `DISABLE_MISMATCH` (P1, FAIL).

## OpenMausBot

Sources: public `config.json` flags, library opt-out, and a versioned bot snapshot (`openmausbot-snapshot/v1`). The snapshot is the SkillScope-side contract: it lists the skills the host claims the bot can load.

- **The snapshot is required.** No snapshot, a missing snapshot file, non-JSON, or an invalid shape means the per-bot inventory cannot be enumerated: INCOMPLETE with unknown scope `SNAPSHOT`. An unknown snapshot version means the whole inventory is unenumerated.
- **Per-bot lists are explicit.** A list (assigned / imported / plugin) that is neither present in `skills` nor declared empty in `emptyLists` is missing, not empty — absence is ambiguous and fails closed.
- **Plugin disabling** uses `disabledPluginIds`: a plugin skill whose id is listed is DISABLED and does not leak. A plugin skill with no `pluginId` cannot be switched off at all, so it is UNKNOWN / INCOMPLETE rather than silently treated as switchable.
- **Reconciliation:** the adapter compares the snapshot against the skill directories actually present on disk (bounded discovery). A skill on disk but not in any list is INCOMPLETE.
- SkillScope never writes `config.json` or `library-opt-out.json`, never calls a private API, and never guesses an unpublished storage layout. A bot whose skills live only in unpublished storage is INCOMPLETE for those skills.

## What is not covered

- Host versions newer than the frozen rule matrices. A newer host is INCOMPLETE until its rules are recorded and frozen.
- Skills that only exist in a host's unpublished storage (no public config, no snapshot). They are INCOMPLETE, not absent.
- Future flag flips. DISCOVERED skills are reported as discovered; the audit does not predict what happens if a flag is turned on later.
