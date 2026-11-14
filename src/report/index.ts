/**
 * Static HTML report renderer (P023 T009, S3).
 *
 * Renders one AuditResult (T006 kernel output) plus its ReportV1
 * (PROJECT_BOOK §6.3) into a single self-contained HTML document.
 *
 * Hard rules (PROJECT_BOOK §7.4, T009 task card):
 *   - The renderer NEVER recomputes the verdict. It reads
 *     `audit.status`, `audit.findings` and `audit.coverage` as given
 *     and only counts instances per scope for the matrix display.
 *     Counting is presentation, not a verdict: a scope cell shows how
 *     many instances the resolver already reported there.
 *   - No external resources: no <link>, no <script src>, no http(s)
 *     URL in any src/href/action, no @import, no url(...). Inline
 *     <style> only. `scanExternalResources` proves it.
 *   - The exact redacted ReportV1 JSON is embedded verbatim
 *     (canonical form) in a <script type="application/json"> block,
 *     so the HTML and the JSON file carry the same canonical result:
 *     same status, same finding ids, same counts, same audit_sha256.
 *     The embedded JSON must parse to the same value as the JSON
 *     report file (asserted by tests/cli).
 *   - All interpolated values are HTML-escaped. Finding detail text
 *     is redacted (src/privacy) by the caller before it reaches this
 *     module; the renderer additionally escapes it.
 *
 * Pure module: no file access, no clock, no network.
 */

import { canonicalizeJson } from "../canonical/index.js";
import type { ReportV1 } from "../contracts/index.js";
import type { AuditResult } from "../resolver/index.js";

/** Scope columns of the §7.1 matrix, in display order. */
export const MATRIX_SCOPES: readonly string[] = [
  "REPO",
  "USER",
  "ADMIN",
  "SYSTEM",
  "PLUGIN",
  "ACCOUNT_SYNC",
  "BOT_ASSIGNED",
  "SHARED_LIBRARY",
  "IMPORTED",
];

/** Explicit one-line meaning of each audit state (T009 pass criterion). */
export const STATUS_MEANING: Readonly<Record<string, string>> = {
  PASS: "all required sources enumerated; expected set matches policy; no confirmed deviations",
  FAIL: "at least one confirmed scope deviation or policy violation",
  INCOMPLETE:
    "a required source could not be enumerated; completeness cannot be proven",
};

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * Scan an HTML document for external-resource references. Returns the
 * offending matches (empty = self-contained). Checked patterns: <link>,
 * <script src>, <img src>, any src=/href=/action= pointing at http(s):
 * or //, @import, url(.
 */
export function scanExternalResources(html: string): string[] {
  const hits: string[] = [];
  const patterns: Array<[RegExp, string]> = [
    [/<link\b[^>]*>/gi, "<link> element"],
    [/<script\b[^>]*\bsrc\s*=/gi, "<script src>"],
    [/<img\b[^>]*\bsrc\s*=/gi, "<img src>"],
    [/\b(?:src|href|action)\s*=\s*["'](?:https?:)?\/\//gi, "external src/href/action URL"],
    [/@import\b/gi, "@import"],
    [/\burl\s*\(/gi, "url(...)"],
  ];
  for (const [re, label] of patterns) {
    const matches = html.match(re);
    if (matches !== null) {
      for (const match of matches) {
        hits.push(`${label}: ${match}`);
      }
    }
  }
  return hits;
}

function matrixScopes(audit: AuditResult): string[] {
  const present = new Set<string>();
  for (const inst of audit.instances) {
    present.add(inst.sourceScope);
  }
  for (const scope of audit.coverage.unknownScopes) {
    present.add(scope);
  }
  return MATRIX_SCOPES.filter((scope) => present.has(scope));
}

function matrixCell(audit: AuditResult, scope: string): string {
  if (audit.coverage.unknownScopes.includes(scope)) {
    return `<td class="unknown">unknown — not enumerated</td>`;
  }
  const inScope = audit.instances.filter((inst) => inst.sourceScope === scope);
  if (inScope.length === 0) {
    return `<td class="empty">0</td>`;
  }
  const byStatus = new Map<string, number>();
  for (const inst of inScope) {
    byStatus.set(inst.status, (byStatus.get(inst.status) ?? 0) + 1);
  }
  const breakdown = [...byStatus.entries()]
    .sort((a, b) => (a[0] < b[0] ? -1 : 1))
    .map(([status, count]) => `${count} ${status}`)
    .join(", ");
  return `<td><strong>${inScope.length}</strong><br><span class="sub">${escapeHtml(breakdown)}</span></td>`;
}

/**
 * Render the report. `report` must already be redacted and hashed by
 * the caller (src/cli/audit); the renderer embeds it verbatim and
 * displays its fields. Throws when the canonical report JSON would
 * break out of its <script> block.
 */
export function renderReportHtml(audit: AuditResult, report: ReportV1): string {
  const embedded = canonicalizeJson(report);
  if (embedded.includes("</script")) {
    throw new Error("report JSON contains a closing script tag; refusing to embed it");
  }
  const meaning = STATUS_MEANING[audit.status] ?? "";
  const scopes = matrixScopes(audit);
  const matrixHead = scopes.map((scope) => `<th>${escapeHtml(scope)}</th>`).join("");
  const matrixRow = scopes.map((scope) => matrixCell(audit, scope)).join("");
  const unknownScopes =
    audit.coverage.unknownScopes.length > 0
      ? audit.coverage.unknownScopes.map(escapeHtml).join(", ")
      : "none";
  const findingsRows =
    audit.findings.length === 0
      ? `<tr><td colspan="5">No findings.</td></tr>`
      : audit.findings
          .map(
            (finding) =>
              `<tr><td>${escapeHtml(finding.id)}</td>` +
              `<td>${escapeHtml(finding.severity)}</td>` +
              `<td>${escapeHtml(finding.sourceScope)}</td>` +
              `<td>${escapeHtml(finding.status)}</td>` +
              `<td>${escapeHtml(finding.detail)}` +
              (finding.instanceIds.length > 0
                ? `<br><span class="sub">${finding.instanceIds.map(escapeHtml).join(", ")}</span>`
                : "") +
              (finding.affectedCount !== undefined
                ? `<br><span class="sub">affected instances: ${finding.affectedCount}</span>`
                : "") +
              `</td></tr>`,
          )
          .join("\n");
  const instanceRows =
    audit.instances.length === 0
      ? `<tr><td colspan="6">No instances enumerated.</td></tr>`
      : audit.instances
          .map(
            (inst) =>
              `<tr><td>${escapeHtml(inst.instanceId)}</td>` +
              `<td>${escapeHtml(inst.logicalName)}</td>` +
              `<td>${escapeHtml(inst.sourceScope)}</td>` +
              `<td>${escapeHtml(inst.relativePath)}</td>` +
              `<td>${escapeHtml(inst.status)}</td>` +
              `<td class="mono">${escapeHtml(inst.contentSha256.slice(0, 12))}…</td></tr>`,
          )
          .join("\n");
  const observed =
    report.observed_count === null ? "null (incomplete enumeration)" : String(report.observed_count);
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>SkillScope report — ${escapeHtml(report.profile_id)} — ${escapeHtml(report.status)}</title>
<style>
body{font-family:system-ui,sans-serif;margin:2rem auto;max-width:1100px;padding:0 1rem;color:#1a1a1a}
h1{font-size:1.4rem}h2{font-size:1.1rem;margin-top:2rem}
.status{padding:.75rem 1rem;border-radius:.5rem;font-weight:700}
.status-PASS{background:#e6f4ea}.status-FAIL{background:#fce8e6}.status-INCOMPLETE{background:#fef7e0}
table{border-collapse:collapse;width:100%}th,td{border:1px solid #ccc;padding:.4rem .6rem;text-align:left;vertical-align:top}
th{background:#f2f2f2}.sub{color:#555;font-size:.85em}.mono{font-family:monospace}
td.unknown{background:#fef7e0}td.empty{color:#888}
dl{display:grid;grid-template-columns:12rem 1fr;gap:.25rem 1rem}dt{font-weight:700}dd{margin:0;font-family:monospace;overflow-wrap:anywhere}
</style>
</head>
<body>
<h1>SkillScope audit report</h1>
<p>Profile <strong>${escapeHtml(report.profile_id)}</strong> · Engine <strong>${escapeHtml(audit.engine)}</strong>${audit.botId !== undefined ? ` · Bot <strong>${escapeHtml(audit.botId)}</strong>` : ""}</p>
<div class="status status-${escapeHtml(report.status)}">RESULT: ${escapeHtml(report.status)} — ${escapeHtml(meaning)}</div>
<h2>Scope matrix</h2>
<p>Bot × source scope: instance counts per source scope, as reported by the resolver. Unknown scopes were not enumerated and are never shown as empty.</p>
<table>
<thead><tr><th>Bot / Session Profile</th>${matrixHead}</tr></thead>
<tbody><tr><td>${escapeHtml(audit.engine)} / ${escapeHtml(report.profile_id)}</td>${matrixRow}</tr></tbody>
</table>
<h2>Coverage</h2>
<p>Enumerated sources: <strong>${audit.coverage.enumeratedSources}</strong> of <strong>${audit.coverage.requiredSources}</strong> required. Unknown scopes: <strong>${unknownScopes}</strong>. Policy applied: <strong>${audit.policy.applied ? "yes" : "no"}</strong> (effective ${audit.policy.effectiveCount}, expected ${audit.policy.expectedCount}, violations ${audit.policy.violationCount}).</p>
<h2>Findings (${audit.findings.length})</h2>
<table>
<thead><tr><th>Finding</th><th>Severity</th><th>Scope</th><th>Status</th><th>Detail</th></tr></thead>
<tbody>
${findingsRows}
</tbody>
</table>
<h2>Skill instances (${audit.instances.length})</h2>
<table>
<thead><tr><th>Instance</th><th>Logical name</th><th>Scope</th><th>Relative path</th><th>Status</th><th>Content SHA-256</th></tr></thead>
<tbody>
${instanceRows}
</tbody>
</table>
<h2>Hashes</h2>
<dl>
<dt>audit_sha256</dt><dd>${escapeHtml(report.audit_sha256 ?? "null")}</dd>
<dt>inventory_sha256</dt><dd>${escapeHtml(report.inventory_sha256 ?? "null")}</dd>
<dt>oracle_result_sha256</dt><dd>${escapeHtml(report.oracle_result_sha256 ?? "null")}${report.oracle_result_sha256 === null ? " (not run — the CLI never executes the Python Oracle)" : ""}</dd>
<dt>expected_count</dt><dd>${report.expected_count}</dd>
<dt>observed_count</dt><dd>${escapeHtml(observed)}</dd>
</dl>
<script type="application/json" id="skillscope-report">${embedded}</script>
</body>
</html>
`;
}
