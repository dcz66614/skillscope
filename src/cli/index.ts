#!/usr/bin/env node
/**
 * SkillScope CLI entry point (P023 T009, S3).
 *
 * Commands (PROJECT_BOOK §6.4):
 *   skillscope init [--dir <dir>]
 *   skillscope audit --profile <path> [--format json|html] [--out <path>] [--ci]
 *   skillscope audit --engine <engine> --cwd <dir> [--format json|html] [--out <path>] [--ci]
 *   skillscope verify --fixtures s0
 *
 * Exit codes (§6.4): 0 PASS, 1 FAIL, 2 INCOMPLETE, 3 input/config
 * format error, 4 internal execution error.
 *
 * The `--engine/--cwd` audit form reads the profile from
 * `<cwd>/skillscope.json` (run `skillscope init` first when none
 * exists); the CLI never guesses host roots.
 *
 * `--ci` (T010, ADR-014) is a boolean flag on `audit` only: it
 * suppresses the multi-line §0.1 console summary and prints exactly
 * one machine-readable line to stdout
 * (`skillscope: RESULT=<STATUS|ERROR> exit=<code>[ report=<path>]`),
 * while the report file is still written and the exit code is
 * unchanged — INCOMPLETE still exits 2, never 0. `--ci` on any other
 * command is an input error (exit 3).
 *
 * The console summary prints one line per instance (✓ ELIGIBLE,
 * ✗ DISABLED / INVALID / UNKNOWN, ~ DISCOVERED), one line per
 * finding, the coverage line and the RESULT line — the §0.1 sample
 * shape. The summary never recomputes the verdict: it prints
 * `audit.status` as returned by the T006 kernel.
 */

import * as path from "node:path";
import { runAudit, type AuditRunResult } from "./audit.js";
import { runInit } from "./init.js";
import { runVerify } from "./verify.js";
import type { AuditResult } from "../resolver/index.js";

const USAGE = `Usage:
  skillscope init [--dir <dir>]
  skillscope audit --profile <path> [--format json|html] [--out <path>] [--ci]
  skillscope audit --engine <engine> --cwd <dir> [--format json|html] [--out <path>] [--ci]
  skillscope verify --fixtures s0`;

function fail(message: string): never {
  console.error(`skillscope: ${message}`);
  console.error(USAGE);
  process.exit(3);
}

const VALUE_OPTIONS = new Set([
  "profile",
  "format",
  "out",
  "engine",
  "cwd",
  "dir",
  "fixtures",
]);

/** Boolean flags (take no value). Only `--ci` on `audit` (ADR-014). */
const BOOLEAN_OPTIONS = new Set(["ci"]);

function parseArgs(argv: string[]): Map<string, string> {
  const out = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] as string;
    if (!arg.startsWith("--")) {
      fail(`unexpected argument: ${arg}`);
    }
    const name = arg.slice(2);
    if (BOOLEAN_OPTIONS.has(name)) {
      out.set(name, "true");
      continue;
    }
    if (!VALUE_OPTIONS.has(name)) {
      fail(`unknown option: --${name}`);
    }
    const value = argv[i + 1];
    if (value === undefined || value.startsWith("--")) {
      fail(`option --${name} needs a value`);
    }
    out.set(name, value);
    i += 1;
  }
  return out;
}

function statusMark(status: string): string {
  switch (status) {
    case "ELIGIBLE":
      return "✓";
    case "DISCOVERED":
      return "~";
    default:
      return "✗";
  }
}

/** Print the §0.1-style console summary for one audit. */
export function printAuditSummary(
  audit: AuditResult,
  reportPath: string | null,
  engineDetails?: AuditRunResult["engineDetails"],
): void {
  console.log(`${audit.engine.toUpperCase()} / profile: ${audit.profileId}`);
  // FIX-R1: the resolved engine inputs are printed first, so a reader
  // can see exactly which user config / data directory / bot identity
  // was audited. These lines are operator-facing provenance; they do
  // not enter the frozen report.
  if (engineDetails?.configSource !== undefined) {
    console.log(
      `  config: ${engineDetails.configPath ?? "none"} (source: ${engineDetails.configSource})`,
    );
  }
  if (engineDetails?.botId !== undefined) {
    console.log(`  bot: ${engineDetails.botId}`);
  }
  if (engineDetails?.dataDir !== undefined) {
    console.log(
      `  data dir: ${engineDetails.dataDir} (source: ${engineDetails.dataDirSource ?? "unknown"})`,
    );
  }
  if (engineDetails?.snapshotPath !== undefined) {
    console.log(`  snapshot: ${engineDetails.snapshotPath}`);
  }
  for (const inst of audit.instances) {
    const alias =
      inst.aliases.length > 0 ? ` (aliases: ${inst.aliases.join(", ")})` : "";
    console.log(`  ${statusMark(inst.status)} ${inst.sourceRootId}/${inst.relativePath}${alias}`);
  }
  for (const finding of audit.findings) {
    console.log(
      `  ! ${finding.id} [${finding.severity}] (${finding.sourceScope}): ${finding.detail}`,
    );
  }
  console.log(
    `  coverage: ${audit.coverage.enumeratedSources}/${audit.coverage.requiredSources} sources enumerated` +
      (audit.coverage.unknownScopes.length > 0
        ? `; unknown: ${audit.coverage.unknownScopes.join(", ")}`
        : ""),
  );
  console.log(`RESULT: ${audit.status}`);
  if (reportPath !== null) {
    console.log(`Report: ${reportPath}`);
  }
}

/**
 * Emit the audit outcome and return the exit code.
 *
 * Normal mode prints the §0.1 console summary. CI mode (ADR-014)
 * prints exactly one machine-readable line to stdout so CI logs stay
 * parseable; the exit code and the report file are unchanged.
 */
function exitFor(result: AuditRunResult, ci: boolean): number {
  if (result.error !== undefined) {
    console.error(`skillscope: ${result.error}`);
  }
  if (ci) {
    // The RESULT word is the audit status only when the report was
    // actually written; a failed report build/write (exit 4) is an
    // ERROR even when the audit itself passed — a CI parser must
    // never read RESULT=PASS from a run that exited 4.
    const status =
      result.reportPath !== null && result.audit !== null
        ? result.audit.status
        : "ERROR";
    const report =
      result.reportPath !== null ? ` report=${result.reportPath}` : "";
    console.log(`skillscope: RESULT=${status} exit=${result.exitCode}${report}`);
    return result.exitCode;
  }
  if (result.audit !== null) {
    printAuditSummary(result.audit, result.reportPath, result.engineDetails);
  }
  return result.exitCode;
}

function main(argv: string[]): number {
  const [command, ...rest] = argv;
  if (command === undefined || command === "--help" || command === "-h") {
    console.log(USAGE);
    return 0;
  }
  if (command === "init") {
    const args = parseArgs(rest);
    if (args.get("ci") === "true") {
      fail("--ci only applies to audit");
    }
    const result = runInit(args.get("dir") ?? ".");
    if (result.error !== undefined) {
      console.error(`skillscope: ${result.error}`);
      return result.exitCode;
    }
    console.log(`Created ${result.profilePath}`);
    console.log("Edit the profile, then run: skillscope audit --profile skillscope.json");
    return 0;
  }
  if (command === "audit") {
    const args = parseArgs(rest);
    const ci = args.get("ci") === "true";
    const format = args.get("format") ?? "json";
    if (format !== "json" && format !== "html") {
      fail(`--format must be json or html, got ${JSON.stringify(format)}`);
    }
    let profilePath = args.get("profile");
    if (profilePath === undefined) {
      const engine = args.get("engine");
      const cwd = args.get("cwd");
      if (engine === undefined || cwd === undefined) {
        fail("audit needs --profile <path>, or --engine <engine> --cwd <dir>");
      }
      if (!["codex", "claude-code", "openmausbot"].includes(engine)) {
        fail(`--engine must be codex, claude-code or openmausbot, got ${JSON.stringify(engine)}`);
      }
      profilePath = path.join(cwd, "skillscope.json");
    }
    return exitFor(
      runAudit({
        profilePath,
        format: format as "json" | "html",
        ...(args.get("out") !== undefined ? { outPath: args.get("out") as string } : {}),
      }),
      ci,
    );
  }
  if (command === "verify") {
    const args = parseArgs(rest);
    if (args.get("ci") === "true") {
      fail("--ci only applies to audit");
    }
    if (args.get("fixtures") !== "s0") {
      fail("verify needs --fixtures s0");
    }
    const result = runVerify();
    if (result.error !== undefined) {
      console.error(`skillscope: ${result.error}`);
      return result.exitCode;
    }
    console.log(`S0 gate: ${result.gateExitCode === 0 ? "PASS" : "FAIL"} (gate exit ${result.gateExitCode})`);
    return result.exitCode;
  }
  fail(`unknown command: ${command}`);
}

process.exit(main(process.argv.slice(2)));
