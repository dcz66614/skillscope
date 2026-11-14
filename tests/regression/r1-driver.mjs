/**
 * R1 regression driver — runs the FIX-R1 permission scenarios as the
 * unprivileged user `nobody`, so chmod-000 paths really deny.
 *
 * The vitest suite stages a fixture copy + a copy of the built `dist/`
 * + `node_modules/smol-toml` + `node_modules/yaml` into a world-readable
 * mkdtemp directory under ~/workspace, applies the fixture's `deny.json`
 * (chmod 000), copies this file next to `dist/`, and runs:
 *
 *   runuser -u nobody -- node r1-driver.mjs <scenario> <staged-fixture-dir>
 *
 * The driver only reads; it prints one JSON object to stdout. Never run
 * it as root and expect a permission denial: root bypasses chmod 000.
 */
import { readFileSync } from "node:fs";
import { resolveCodexSkills } from "./dist/adapters/codex/codex-poc.js";
import { resolveClaudePoc } from "./dist/adapters/claude/claude-poc.js";
import { auditClaude } from "./dist/adapters/claude/adapter.js";
import { resolveOpenMausBotPoc } from "./dist/adapters/openmausbot/openmausbot-poc.js";
import { auditOpenMausBot } from "./dist/adapters/openmausbot/adapter.js";
import {
  resolveCodexAudit,
  resolveClaudeAudit,
  resolveOpenMausBotAudit,
} from "./dist/resolver/index.js";

const [scenario, base] = process.argv.slice(2);
if (scenario === undefined || base === undefined) {
  console.error("usage: node r1-driver.mjs <scenario> <fixture-dir>");
  process.exit(3);
}

const snap = (dir) => JSON.parse(readFileSync(`${dir}/snapshot.json`, "utf8"));

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
    ...(audit.flags ? { flags: audit.flags } : {}),
    ...(audit.configReadable !== undefined
      ? { configReadable: audit.configReadable }
      : {}),
  };
}

const results = [];

// ---------- r1-01: Codex REPO skills root unreadable ----------
if (scenario === "r1-01") {
  const poc = resolveCodexSkills({
    caseId: "r1-01",
    layoutRoot: base,
    cwd: `${base}/repo`,
    repoRoot: `${base}/repo`,
    homeRoot: `${base}/home`,
    adminRoot: `${base}/admin`,
    bundledPath: `${base}/bundled.json`,
    pluginsPath: `${base}/plugins.json`,
  });
  results.push(summarize("codex-poc", poc));
  results.push(
    summarize(
      "codex-kernel",
      resolveCodexAudit(poc, { forbiddenScopes: ["REPO"] }),
    ),
  );
}

// ---------- r1-02: Claude SKILL.md unreadable ----------
if (scenario === "r1-02") {
  const roots = [
    {
      sourceRootId: "project",
      scope: "PROJECT",
      path: `${base}/repo/.claude/skills`,
      required: true,
    },
  ];
  const policy = { forbiddenScopes: ["PROJECT"] };
  const poc = resolveClaudePoc({
    profileId: "r1-02",
    cwd: `${base}/repo`,
    sourceRoots: roots,
    policy,
  });
  results.push(summarize("claude-poc", poc));
  results.push(summarize("claude-kernel", resolveClaudeAudit(poc, policy)));
  results.push(
    summarize(
      "claude-full-adapter",
      auditClaude({
        profileId: "r1-02-full",
        cwd: `${base}/repo`,
        sourceRoots: roots,
        homeDir: `${base}/home`,
        repoDir: `${base}/repo`,
        fixtureDir: base,
        policy,
      }).audit,
    ),
  );
}

// ---------- r1-03-unreadable: Claude synced/ directory unreadable ----------
if (scenario === "r1-03-unreadable") {
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
    profileId: "r1-03-unreadable",
    cwd: `${base}/repo`,
    sourceRoots: roots,
    accountSyncDir: `${base}/home/.claude/skills/synced`,
    policy,
  });
  results.push(summarize("claude-poc", poc));
  results.push(summarize("claude-kernel", resolveClaudeAudit(poc, policy)));
}

// ---------- OMB cases ----------
function ombCase(label, baseDir, policy, { full = true } = {}) {
  const s = snap(baseDir);
  const pocInput = {
    profileId: label,
    botId: "demo",
    dataDir: `${baseDir}/data`,
    snapshot: {
      version: s.version,
      skills: s.skills.map((k) => ({
        name: k.name,
        kind: k.kind,
        path: `${baseDir}/${k.path.replace(/^\.\//, "")}`,
      })),
      loadableRoots: s.loadableRoots.map((p) => `${baseDir}/${p.replace(/^\.\//, "")}`),
    },
    policy,
  };
  const poc = resolveOpenMausBotPoc(pocInput);
  results.push(summarize(`${label}-poc`, poc));
  results.push(
    summarize(`${label}-kernel`, resolveOpenMausBotAudit(poc, policy)),
  );
  if (full) {
    results.push(
      summarize(
        `${label}-full-adapter`,
        auditOpenMausBot({
          profileId: label,
          botId: "demo",
          dataDir: `${baseDir}/data`,
          snapshot: s,
          fixtureDir: baseDir,
          policy,
        }).audit,
      ),
    );
  }
}

if (scenario === "r1-02a") {
  ombCase("r1-02a", base, { forbiddenScopes: ["SHARED_LIBRARY"] });
}

if (scenario === "r1-02b") {
  const s = snap(base);
  const poc = resolveOpenMausBotPoc({
    profileId: "r1-02b",
    botId: "demo",
    dataDir: `${base}/data`,
    snapshot: {
      version: s.version,
      skills: s.skills.map((k) => ({
        name: k.name,
        kind: k.kind,
        path: `${base}/${k.path.replace(/^\.\//, "")}`,
      })),
      loadableRoots: s.loadableRoots.map((p) => `${base}/${p.replace(/^\.\//, "")}`),
    },
    policy: { allowedScopes: ["SHARED_LIBRARY"] },
  });
  results.push(summarize("r1-02b-poc", poc));
  results.push(
    summarize(
      "r1-02b-kernel",
      resolveOpenMausBotAudit(poc, { allowedScopes: ["SHARED_LIBRARY"] }),
    ),
  );
}

console.log(JSON.stringify({ scenario, results }));
