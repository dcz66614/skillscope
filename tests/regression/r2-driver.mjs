/**
 * R2 regression driver — runs the FIX-T013R permission scenario as the
 * unprivileged user `nobody`, so a chmod-000 skill subdirectory really
 * denies (same staging pattern as tests/regression/r1-driver.mjs).
 *
 * The vitest suite stages a fixture copy + a copy of the built `dist/`
 * + `node_modules/smol-toml` + `node_modules/yaml` into a world-readable
 * mkdtemp directory under ~/workspace, applies the fixture's `deny.json`
 * (chmod 000), copies this file next to `dist/`, and runs:
 *
 *   runuser -u nobody -- node r2-driver.mjs <scenario> <staged-fixture-dir>
 *
 * The driver only reads; it prints one JSON object to stdout. Never run
 * it as root and expect a permission denial: root bypasses chmod 000.
 */
import { readFileSync } from "node:fs";
import { resolveClaudePoc } from "./dist/adapters/claude/claude-poc.js";
import {
  resolveClaudeAudit,
} from "./dist/resolver/index.js";

const [scenario, base] = process.argv.slice(2);
if (scenario === undefined || base === undefined) {
  console.error("usage: node r2-driver.mjs <scenario> <fixture-dir>");
  process.exit(3);
}

function summarize(label, result) {
  const audit = result.audit ?? result;
  return {
    label,
    status: audit.status,
    instances: (audit.instances ?? audit.skills ?? []).map((i) => ({
      sourceScope: i.sourceScope,
      logicalName: i.logicalName,
      status: i.status,
    })),
    findings: (audit.findings ?? []).map((f) => ({
      id: f.id,
      severity: f.severity,
      sourceScope: f.sourceScope,
      detail: f.detail,
    })),
    coverage: audit.coverage ?? null,
    unknownScopes: audit.coverage?.unknownScopes ?? audit.unknownSources ?? [],
  };
}

const results = [];

// ---------- r2-02: Claude synced/ readable, only skill subdir unreadable ----------
// P2-T013R-02 (TS side): the synced directory itself is readable, but its
// only skill subdirectory is chmod 000. The TS accountSyncDir check must
// see the SKILL_MD_UNREADABLE/EACCES skip (hasUnverifiable) and report
// ACCOUNT_SYNC UNKNOWN — not a silent absence.
if (scenario === "r2-02") {
  const roots = [
    {
      sourceRootId: "personal",
      scope: "PERSONAL",
      path: `${base}/home/.claude/skills`,
      required: true,
    },
    {
      sourceRootId: "project",
      scope: "PROJECT",
      path: `${base}/repo/.claude/skills`,
      required: true,
    },
  ];
  const policy = { allowedScopes: ["PERSONAL", "PROJECT", "ACCOUNT_SYNC"] };
  const poc = resolveClaudePoc({
    profileId: "r2-02",
    cwd: `${base}/repo`,
    sourceRoots: roots,
    accountSyncDir: `${base}/home/.claude/skills/synced`,
    policy,
  });
  results.push(summarize("claude-poc", poc));
  results.push(summarize("claude-kernel", resolveClaudeAudit(poc, policy)));
}

console.log(JSON.stringify({ scenario, results }));
