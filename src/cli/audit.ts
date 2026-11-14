/**
 * CLI audit runner (P023 T009, S3).
 *
 * Loads a frozen skillscope.profile/v1 file, wires it into the right
 * host adapter, hands the result plus the profile policy to the T006
 * kernel, and builds the frozen skillscope.report/v1 (PROJECT_BOOK
 * §6.3). Exit codes follow the CLI contract (§6.4): 0 PASS, 1 FAIL,
 * 2 INCOMPLETE, 3 input/config format error, 4 internal error.
 *
 * Profile → adapter mapping (frozen, see ADR-013). All profile paths
 * are resolved relative to the profile file's directory:
 *   - codex: cwd/repo_root/home_root from the profile; the ADMIN root
 *     is the dirname of the ADMIN source root's path (the path names
 *     the skills directory, e.g. "./admin/skills"), defaulting to
 *     "<profileDir>/admin"; bundled.json / plugins.json are read from
 *     the profile directory when present, and are otherwise absent
 *     (SYSTEM / PLUGIN then report unknown, per the PoC's fail-closed
 *     rule — never silently treated as empty). config.toml (FIX-R1,
 *     P1-R1-04): explicit profile `config_path` wins; else
 *     "<profileDir>/config.toml" when present; else
 *     "<home_root>/.codex/config.toml" when present; else absent.
 *     A present-but-unreadable config is passed through (the PoC
 *     fails closed on it) — it is never mistaken for absent. An
 *     explicit `config_path` naming a missing file is an input error
 *     (exit 3). The resolved config path and its source are printed
 *     in the console summary, so the choice is never silent.
 *   - claude-code: profile source_roots pass through to the full
 *     adapter (auditClaude) with fixtureDir = profile dir; settings
 *     layers default from home_root / repo_root. No settings paths
 *     are invented beyond the adapter's own defaults. The adapter
 *     derives undeclared PERSONAL / PROJECT roots and the synced
 *     directory from home_root / repo_root (FIX-R1, P1-R1-03 /
 *     P0-R1-03).
 *   - openmausbot: dataDir, botId and snapshot from the profile
 *     contract (FIX-R1, P1-R1-01): explicit `data_dir` wins, else
 *     OMB_DATA_DIR from the caller environment, else
 *     "<home_root>/.openmausbot" (the adapter's own resolution — the
 *     CLI no longer forces dataDir "./data" or env {}); `bot_id` is
 *     required (a missing bot_id is an input error, exit 3 —
 *     profile_id is the audit profile id, not a bot id); `snapshot`
 *     from explicit `snapshot_path`, else "./snapshot.json" when
 *     present; a missing snapshot is INCOMPLETE per ADR-007, never
 *     silently empty. scan roots come from the profile's
 *     BOT_ASSIGNED / SHARED_LIBRARY / IMPORTED source roots;
 *     homeDir = home_root, so defaults never touch the real user
 *     home. The resolved bot id, data dir (+ source) and snapshot
 *     are printed in the console summary.
 *   - policy: profile.policy (snake_case) is mapped to PolicyV1
 *     (camelCase) and validated; it is ALWAYS passed to the kernel
 *     (ADR-005) — a missing policy passthrough would silently drop
 *     every policy finding.
 *
 * Report hashes (frozen, see ADR-013):
 *   - inventory_sha256 = canonicalSha256(audit.instances).
 *   - audit_sha256 = canonicalSha256(report with audit_sha256 null):
 *     a report cannot hash itself, so the field is filled after the
 *     rest of the report is hashed.
 *   - oracle_result_sha256 = null: the CLI never runs the Python
 *     Oracle (tests-only); a null here is honest, not a gap.
 *   - observed_count = null while INCOMPLETE (schema text, §6.3).
 *
 * Redaction: the report is passed through src/privacy `redactReport`
 * BEFORE hashing and writing, so the hash is verifiable from the
 * shared artifact and no absolute path or credential value can enter
 * it. Finding detail text in the HTML is redacted the same way
 * (home/cwd/profile-dir bases + caller roots).
 *
 * The audit never writes into a scanned directory: the only writes
 * are the report file at the caller's --out path (or the default next
 * to the profile file) and, for `init`, the profile file itself.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { resolveCodexSkills } from "../adapters/codex/codex-poc.js";
import { auditClaude } from "../adapters/claude/adapter.js";
import type { ClaudeScope } from "../adapters/claude/claude-poc.js";
import { auditOpenMausBot } from "../adapters/openmausbot/adapter.js";
import { canonicalSha256 } from "../canonical/index.js";
import type { AuditStatus, ReportV1 } from "../contracts/index.js";
import { classifyPath } from "../fsutil/index.js";
import {
  loadProfile,
  validateAgainstSchemaId,
  writeJsonFile,
  REPORT_SCHEMA_ID,
} from "../io/index.js";
import { validatePolicy, type PolicyV1 } from "../policy/index.js";
import { redactReport } from "../privacy/index.js";
import { renderReportHtml } from "../report/index.js";
import {
  resolveClaudeAudit,
  resolveCodexAudit,
  resolveOpenMausBotAudit,
  type AuditResult,
} from "../resolver/index.js";

export type AuditFormat = "json" | "html";

export interface AuditRunOptions {
  /** Profile file path (resolved against process.cwd() when relative). */
  profilePath: string;
  format?: AuditFormat;
  /** Explicit output path; default is next to the profile file. */
  outPath?: string;
}

/**
 * FIX-R1: the engine-specific inputs the CLI resolved for this audit,
 * printed in the console summary so a reader can see exactly which
 * user config / data directory / bot identity was audited. Nothing
 * here enters the frozen report: it is operator-facing provenance,
 * not audit evidence.
 */
export interface EngineDetails {
  /** Codex: the config.toml that was read (absent when none was found). */
  configPath?: string;
  /** Codex: where the config path came from. */
  configSource?: "explicit" | "profile" | "home" | "absent";
  /** OpenMausBot: the bot id from the profile's explicit `bot_id`. */
  botId?: string;
  /** OpenMausBot: the resolved data directory (adapter-resolved). */
  dataDir?: string;
  /** OpenMausBot: where the data directory came from. */
  dataDirSource?: "explicit" | "env" | "default";
  /** OpenMausBot: the snapshot that was read (absent when none was found). */
  snapshotPath?: string;
}

export interface AuditRunResult {
  exitCode: 0 | 1 | 2 | 3 | 4;
  audit: AuditResult | null;
  report: ReportV1 | null;
  reportPath: string | null;
  /** Absolute path of the profile file that was audited. */
  profileAbsPath: string | null;
  /** Engine-specific resolved inputs (FIX-R1 provenance; see EngineDetails). */
  engineDetails?: EngineDetails;
  error?: string;
}

const EXIT_FOR_STATUS: Record<AuditStatus, 0 | 1 | 2> = {
  PASS: 0,
  FAIL: 1,
  INCOMPLETE: 2,
};

function exists(filePath: string): boolean {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

/**
 * Resolve the Codex user config for a profile (FIX-R1, P1-R1-04).
 *
 * Precedence: explicit profile `config_path` > "<profileDir>/config.toml"
 * > "<home_root>/.codex/config.toml" > absent. A path that exists OR
 * is unreadable counts as found: an unreadable config must reach the
 * PoC, which fails closed on it, and must never be mistaken for "no
 * config" (the old `existsSync` check made exactly that mistake). An
 * explicit `config_path` naming a genuinely missing file is an input
 * error — the profile names a file that is not there — while a missing
 * default location is simply absent.
 */
function resolveCodexConfig(
  profile: Record<string, unknown>,
  profileDir: string,
):
  | { ok: true; configPath?: string; source: "explicit" | "profile" | "home" | "absent" }
  | { ok: false; error: string } {
  const resolve = (p: string): string => path.resolve(profileDir, p);
  const explicit = profile["config_path"];
  if (typeof explicit === "string" && explicit.length > 0) {
    const abs = resolve(explicit);
    if (classifyPath(abs) === "missing") {
      return {
        ok: false,
        error: `explicit config_path ${JSON.stringify(explicit)} does not exist (resolved to ${abs})`,
      };
    }
    return { ok: true, configPath: abs, source: "explicit" };
  }
  const profileConfig = path.join(profileDir, "config.toml");
  if (classifyPath(profileConfig) !== "missing") {
    return { ok: true, configPath: profileConfig, source: "profile" };
  }
  const homeConfig = path.join(
    resolve(profile["home_root"] as string),
    ".codex",
    "config.toml",
  );
  if (classifyPath(homeConfig) !== "missing") {
    return { ok: true, configPath: homeConfig, source: "home" };
  }
  return { ok: true, source: "absent" };
}

/**
 * Resolve the OpenMausBot contract inputs for a profile (FIX-R1,
 * P1-R1-01). `bot_id` is required: the profile must name the bot
 * whose opt-out state is audited — `profile_id` is the audit profile
 * id, not a bot id, and is never silently used as one. An explicit
 * `data_dir` / `snapshot_path` naming a missing path is an input
 * error (the profile names a location that is not there); otherwise
 * the adapter resolves the data dir (explicit > OMB_DATA_DIR >
 * <home_root>/.openmausbot) and the snapshot (explicit >
 * ./snapshot.json when present, else missing → INCOMPLETE per
 * ADR-007).
 */
function resolveOmbInputs(
  profile: Record<string, unknown>,
  profileDir: string,
):
  | { ok: true; botId: string; dataDir?: string; snapshotPath?: string }
  | { ok: false; error: string } {
  const resolve = (p: string): string => path.resolve(profileDir, p);
  const botId = profile["bot_id"];
  if (typeof botId !== "string" || botId.length === 0) {
    return {
      ok: false,
      error: `openmausbot profile requires explicit "bot_id" (the bot whose opt-out state is audited); "profile_id" is the audit profile id, not a bot id`,
    };
  }
  const out: { botId: string; dataDir?: string; snapshotPath?: string } = {
    botId,
  };
  const dataDir = profile["data_dir"];
  if (typeof dataDir === "string" && dataDir.length > 0) {
    const abs = resolve(dataDir);
    if (classifyPath(abs) === "missing") {
      return {
        ok: false,
        error: `explicit data_dir ${JSON.stringify(dataDir)} does not exist (resolved to ${abs})`,
      };
    }
    out.dataDir = abs;
  }
  const snapshotPath = profile["snapshot_path"];
  if (typeof snapshotPath === "string" && snapshotPath.length > 0) {
    const abs = resolve(snapshotPath);
    if (classifyPath(abs) === "missing") {
      return {
        ok: false,
        error: `explicit snapshot_path ${JSON.stringify(snapshotPath)} does not exist (resolved to ${abs})`,
      };
    }
    out.snapshotPath = abs;
  } else if (classifyPath(path.join(profileDir, "snapshot.json")) !== "missing") {
    out.snapshotPath = "./snapshot.json";
  }
  return { ok: true, ...out };
}

/** Engine inputs resolved by runAudit before the adapter runs. */
interface ResolvedEngineInputs {
  codexConfigPath?: string;
  codexConfigSource: "explicit" | "profile" | "home" | "absent";
  ombBotId?: string;
  ombDataDir?: string;
  ombSnapshotPath?: string;
}

/** Map the profile's snake_case policy to PolicyV1 (camelCase). */
export function mapProfilePolicy(
  policy: Record<string, unknown>,
): { policy: PolicyV1; errors: string[] } {
  const mapped: PolicyV1 = {};
  if (policy["allowed_scopes"] !== undefined) {
    mapped.allowedScopes = policy["allowed_scopes"] as string[];
  }
  if (policy["forbidden_scopes"] !== undefined) {
    mapped.forbiddenScopes = policy["forbidden_scopes"] as string[];
  }
  if (policy["forbidden_names"] !== undefined) {
    mapped.forbiddenNames = policy["forbidden_names"] as string[];
  }
  return { policy: mapped, errors: validatePolicy(mapped) };
}

function runAdapter(
  profile: Record<string, unknown>,
  profileDir: string,
  policy: PolicyV1,
  inputs: ResolvedEngineInputs,
): { audit: AuditResult; engineDetails?: EngineDetails } {
  const engine = profile["engine"] as string;
  const resolve = (p: string): string => path.resolve(profileDir, p);
  const roots = (profile["source_roots"] as Array<Record<string, unknown>>).map(
    (root) => ({
      sourceRootId: root["sourceRootId"] as string,
      scope: root["scope"] as string,
      path: root["path"] as string,
      required: root["required"] as boolean,
    }),
  );

  if (engine === "codex") {
    const adminRootEntry = roots.find((root) => root.scope === "ADMIN");
    const adminRoot =
      adminRootEntry !== undefined
        ? path.dirname(resolve(adminRootEntry.path))
        : resolve("admin");
    const native = resolveCodexSkills({
      caseId: profile["profile_id"] as string,
      layoutRoot: profileDir,
      cwd: resolve(profile["cwd"] as string),
      repoRoot: resolve(profile["repo_root"] as string),
      homeRoot: resolve(profile["home_root"] as string),
      adminRoot,
      ...(inputs.codexConfigPath !== undefined
        ? { configPath: inputs.codexConfigPath }
        : {}),
      ...(exists(path.join(profileDir, "bundled.json"))
        ? { bundledPath: path.join(profileDir, "bundled.json") }
        : {}),
      ...(exists(path.join(profileDir, "plugins.json"))
        ? { pluginsPath: path.join(profileDir, "plugins.json") }
        : {}),
    });
    return {
      audit: resolveCodexAudit(native, policy),
      engineDetails: {
        ...(inputs.codexConfigPath !== undefined
          ? { configPath: inputs.codexConfigPath }
          : {}),
        configSource: inputs.codexConfigSource,
      },
    };
  }

  if (engine === "claude-code") {
    const result = auditClaude({
      profileId: profile["profile_id"] as string,
      cwd: resolve(profile["cwd"] as string),
      sourceRoots: roots.map((root) => ({
        sourceRootId: root.sourceRootId,
        scope: root.scope as ClaudeScope,
        path: root.path,
        required: root.required,
      })),
      homeDir: profile["home_root"] as string,
      repoDir: profile["repo_root"] as string,
      fixtureDir: profileDir,
      policy,
    });
    return { audit: result.audit };
  }

  if (engine === "openmausbot") {
    const scanScopes = new Set(["BOT_ASSIGNED", "SHARED_LIBRARY", "IMPORTED"]);
    const result = auditOpenMausBot({
      profileId: profile["profile_id"] as string,
      // FIX-R1 (P1-R1-01): the bot id comes from the profile's explicit
      // `bot_id`, never from profile_id.
      botId: inputs.ombBotId as string,
      ...(inputs.ombDataDir !== undefined
        ? { dataDir: inputs.ombDataDir }
        : {}),
      homeDir: profile["home_root"] as string,
      fixtureDir: profileDir,
      // FIX-R1 (P1-R1-01): the caller environment is passed through so
      // OMB_DATA_DIR is honoured when the profile does not declare an
      // explicit data_dir. The adapter still resolves explicit >
      // env > <home>/.openmausbot, and reports which one won.
      env: process.env,
      ...(inputs.ombSnapshotPath !== undefined
        ? { snapshotPath: inputs.ombSnapshotPath }
        : {}),
      scanRoots: roots
        .filter((root) => scanScopes.has(root.scope))
        .map((root) => ({ scope: root.scope, path: root.path })),
      policy,
    });
    return {
      audit: result.audit,
      engineDetails: {
        botId: result.botId,
        dataDir: result.dataDir,
        dataDirSource: result.dataDirSource,
        ...(inputs.ombSnapshotPath !== undefined
          ? {
              snapshotPath: path.isAbsolute(inputs.ombSnapshotPath)
                ? inputs.ombSnapshotPath
                : path.resolve(profileDir, inputs.ombSnapshotPath),
            }
          : {}),
      },
    };
  }

  throw new Error(`unsupported engine in profile: ${JSON.stringify(engine)}`);
}

/** Build the frozen ReportV1 from a kernel AuditResult (unredacted). */
export function buildReport(audit: AuditResult): ReportV1 {
  return {
    schema: "skillscope.report/v1",
    profile_id: audit.profileId,
    status: audit.status,
    expected_count: audit.policy.expectedCount,
    observed_count: audit.status === "INCOMPLETE" ? null : audit.instances.length,
    coverage: {
      enumerated_sources: audit.coverage.enumeratedSources,
      required_sources: audit.coverage.requiredSources,
    },
    findings: audit.findings.map((finding) => ({
      id: finding.id,
      severity: finding.severity,
      source_scope: finding.sourceScope,
      status: finding.status,
    })),
    inventory_sha256: canonicalSha256(audit.instances),
    oracle_result_sha256: null,
    audit_sha256: null,
  };
}

/**
 * Redact a report, fill audit_sha256 over the redacted content (with
 * the field itself null), and validate the result against the frozen
 * schema. Returns the shareable report.
 */
export function finalizeReport(
  audit: AuditResult,
  options: { home?: string; cwd?: string; roots?: readonly string[] } = {},
): ReportV1 {
  const redacted = redactReport(buildReport(audit), {
    home: options.home ?? os.homedir(),
    cwd: options.cwd ?? process.cwd(),
    roots: options.roots ?? [],
  }) as ReportV1;
  const withHash: ReportV1 = {
    ...redacted,
    audit_sha256: canonicalSha256({ ...redacted, audit_sha256: null }),
  };
  const problems = validateAgainstSchemaId(withHash, REPORT_SCHEMA_ID);
  if (problems.length > 0) {
    throw new Error(`built report fails ${REPORT_SCHEMA_ID} validation: ${problems.join("; ")}`);
  }
  return withHash;
}

function defaultOutPath(profileAbsPath: string, format: AuditFormat): string {
  const dir = path.dirname(profileAbsPath);
  const stem = path.basename(profileAbsPath).replace(/\.json$/i, "");
  return path.join(dir, `${stem}.report.${format}`);
}

/**
 * Run one audit from a profile file. Never throws for expected
 * failures: load/validation problems are exit 3, adapter or report
 * failures are exit 4.
 */
export function runAudit(options: AuditRunOptions): AuditRunResult {
  const format: AuditFormat = options.format ?? "json";
  const profileAbsPath = path.resolve(options.profilePath);
  const profileDir = path.dirname(profileAbsPath);

  const loaded = loadProfile(profileAbsPath);
  if (!loaded.ok) {
    return {
      exitCode: 3,
      audit: null,
      report: null,
      reportPath: null,
      profileAbsPath,
      error: `cannot load profile ${profileAbsPath}: ${loaded.error.message}`,
    };
  }
  const profile = loaded.value as Record<string, unknown>;
  const { policy, errors } = mapProfilePolicy(
    profile["policy"] as Record<string, unknown>,
  );
  if (errors.length > 0) {
    return {
      exitCode: 3,
      audit: null,
      report: null,
      reportPath: null,
      profileAbsPath,
      error: `invalid policy in ${profileAbsPath}: ${errors.join("; ")}`,
    };
  }

  // FIX-R1 (P1-R1-01 / P1-R1-04): resolve the engine-specific
  // contract inputs before the adapter runs. A contract violation
  // (missing bot_id, an explicit path naming a missing file) is an
  // input error (exit 3), not an adapter failure.
  const engine = profile["engine"] as string;
  let inputs: ResolvedEngineInputs = { codexConfigSource: "absent" };
  if (engine === "codex") {
    const resolved = resolveCodexConfig(profile, profileDir);
    if (!resolved.ok) {
      return {
        exitCode: 3,
        audit: null,
        report: null,
        reportPath: null,
        profileAbsPath,
        error: `invalid codex config in ${profileAbsPath}: ${resolved.error}`,
      };
    }
    inputs = {
      codexConfigPath: resolved.configPath,
      codexConfigSource: resolved.source,
    };
  } else if (engine === "openmausbot") {
    const resolved = resolveOmbInputs(profile, profileDir);
    if (!resolved.ok) {
      return {
        exitCode: 3,
        audit: null,
        report: null,
        reportPath: null,
        profileAbsPath,
        error: `invalid openmausbot contract in ${profileAbsPath}: ${resolved.error}`,
      };
    }
    inputs = {
      codexConfigSource: "absent",
      ombBotId: resolved.botId,
      ombDataDir: resolved.dataDir,
      ombSnapshotPath: resolved.snapshotPath,
    };
  }

  let audit: AuditResult;
  let engineDetails: EngineDetails | undefined;
  try {
    ({ audit, engineDetails } = runAdapter(profile, profileDir, policy, inputs));
  } catch (err) {
    return {
      exitCode: 4,
      audit: null,
      report: null,
      reportPath: null,
      profileAbsPath,
      error: `audit failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let report: ReportV1;
  try {
    report = finalizeReport(audit, { roots: [profileDir] });
  } catch (err) {
    return {
      exitCode: 4,
      audit,
      report: null,
      reportPath: null,
      profileAbsPath,
      engineDetails,
      error: `report build failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const outPath = options.outPath !== undefined ? path.resolve(options.outPath) : defaultOutPath(profileAbsPath, format);
  try {
    if (format === "json") {
      writeJsonFile(outPath, report);
    } else {
      const redactedAudit = redactReport(audit, {
        home: os.homedir(),
        cwd: process.cwd(),
        roots: [profileDir],
      }) as AuditResult;
      fs.writeFileSync(outPath, renderReportHtml(redactedAudit, report), "utf8");
    }
  } catch (err) {
    return {
      exitCode: 4,
      audit,
      report,
      reportPath: null,
      profileAbsPath,
      engineDetails,
      error: `cannot write report ${outPath}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  return {
    exitCode: EXIT_FOR_STATUS[audit.status],
    audit,
    report,
    reportPath: outPath,
    profileAbsPath,
    engineDetails,
  };
}
