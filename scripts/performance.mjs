#!/usr/bin/env node
/**
 * Performance measurement (`npm run test:performance`, P023 T012, S4).
 *
 * Measures the frozen PROJECT_BOOK §10.3 targets on this VM, with
 * 500 synthetic Skill Instances (deterministic fixture from
 * scripts/perf-fixture.mjs, generated in a temp dir and deleted
 * afterwards — no real skills, no network):
 *
 *   - CLI full scan (audit --format json): target median ≤ 5 s
 *   - HTML report generation (audit --format html): target median ≤ 2 s
 *   - Peak RSS of the CLI process: target ≤ 300 MiB
 *   - Canonical hash stability: audit_sha256 identical across runs
 *   - Instance count: exactly 500, exit code 0 (PASS)
 *
 * Each measurement is the median of 3 runs. Wall time includes Node
 * startup (the CLI a developer actually runs). Peak RSS is read
 * from /proc/<pid>/status VmHWM, polled while the child runs — no
 * external tool, no /usr/bin/time dependency. On a platform without
 * /proc, peak RSS is recorded as null and the memory target is
 * reported as not measured (never silently passed).
 *
 * Results (plus environment info) are written to
 * 03_evidence/T012/performance.json. Exit 0 only when every target
 * is met; a miss is reported with the real measured baseline —
 * targets are never adjusted here (PROJECT_BOOK §10.3: adjusting a
 * non-core target needs an ADR, and correctness/Oracle/offline
 * thresholds must never be lowered).
 */

import { execSync, spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { generatePerfFixture } from "./perf-fixture.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CLI = path.join(ROOT, "dist", "cli", "index.js");
const OUT_DIR = path.join(ROOT, "03_evidence", "T012");
const OUT_JSON = path.join(OUT_DIR, "performance.json");

const INSTANCE_COUNT = 500;
const RUNS = 3;
const TARGET_SCAN_MS = 5000;
const TARGET_HTML_MS = 2000;
const TARGET_RSS_BYTES = 300 * 1024 * 1024;

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/**
 * Run the CLI once, measuring wall time and peak RSS (VmHWM).
 * Returns { exitCode, stdout, stderr, wallMs, peakRssBytes }.
 */
function runCliOnce(args) {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const child = spawn(process.execPath, [CLI, ...args], {
      cwd: ROOT,
      env: { ...process.env },
    });
    let stdout = "";
    let stderr = "";
    let peakRssBytes = null;
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    const timer = setInterval(() => {
      try {
        const status = fs.readFileSync(`/proc/${child.pid}/status`, "utf8");
        const match = status.match(/^VmHWM:\s+(\d+)\s+kB$/m);
        if (match !== null) {
          const rss = Number(match[1]) * 1024;
          if (peakRssBytes === null || rss > peakRssBytes) {
            peakRssBytes = rss;
          }
        }
      } catch {
        // Child already exited between polls; ignore.
      }
    }, 5);
    child.on("close", (code) => {
      clearInterval(timer);
      resolve({
        exitCode: code ?? 4,
        stdout,
        stderr,
        wallMs: performance.now() - start,
        peakRssBytes,
      });
    });
  });
}

function readCpuModel() {
  try {
    const cpuinfo = fs.readFileSync("/proc/cpuinfo", "utf8");
    const match = cpuinfo.match(/^model name\s+:\s+(.+)$/m);
    return match !== null ? match[1].trim() : "unknown";
  } catch {
    return "unknown";
  }
}

async function main() {
  execSync("npm run build", { cwd: ROOT, stdio: "pipe" });
  const fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-perf-"));
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "skillscope-perf-out-"));
  const failures = [];
  const result = {
    schema: "skillscope.performance/v1",
    generated_utc: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: `${os.platform()} ${os.arch()}`,
      os_release: os.release(),
      cpu_model: readCpuModel(),
      cpu_count: os.cpus().length,
      total_memory_bytes: os.totalmem(),
      load_average_1m: os.loadavg()[0],
      uptime_seconds: Math.round(os.uptime()),
    },
    fixture: { instance_count: INSTANCE_COUNT, runs: RUNS },
    targets: {
      scan_ms: TARGET_SCAN_MS,
      html_ms: TARGET_HTML_MS,
      peak_rss_bytes: TARGET_RSS_BYTES,
    },
    measurements: {},
    verdict: "FAIL",
  };
  try {
    generatePerfFixture(fixtureDir, { count: INSTANCE_COUNT });
    const profilePath = path.join(fixtureDir, "profile.json");

    const scanRuns = [];
    const htmlRuns = [];
    let firstHash = null;
    let observedCount = null;
    let hashStable = true;
    for (let i = 0; i < RUNS; i += 1) {
      const out = path.join(outDir, `scan-${i}.report.json`);
      const run = await runCliOnce([
        "audit",
        "--profile",
        profilePath,
        "--format",
        "json",
        "--out",
        out,
      ]);
      scanRuns.push(run);
      if (run.exitCode !== 0) {
        failures.push(
          `json run ${i}: exit ${run.exitCode} (expected 0); stderr: ${run.stderr.slice(0, 300)}`,
        );
        continue;
      }
      const report = JSON.parse(fs.readFileSync(out, "utf8"));
      if (firstHash === null) {
        firstHash = report.audit_sha256;
        observedCount = report.observed_count;
      } else if (report.audit_sha256 !== firstHash) {
        hashStable = false;
        failures.push(`json run ${i}: audit_sha256 differs from run 0 (canonical hash unstable)`);
      }
    }
    for (let i = 0; i < RUNS; i += 1) {
      const out = path.join(outDir, `html-${i}.report.html`);
      const run = await runCliOnce([
        "audit",
        "--profile",
        profilePath,
        "--format",
        "html",
        "--out",
        out,
      ]);
      htmlRuns.push(run);
      if (run.exitCode !== 0) {
        failures.push(
          `html run ${i}: exit ${run.exitCode} (expected 0); stderr: ${run.stderr.slice(0, 300)}`,
        );
      }
    }

    const scanMs = scanRuns.map((r) => Math.round(r.wallMs));
    const htmlMs = htmlRuns.map((r) => Math.round(r.wallMs));
    const peakRss = [...scanRuns, ...htmlRuns]
      .map((r) => r.peakRssBytes)
      .filter((v) => v !== null);
    const peakRssBytes = peakRss.length > 0 ? Math.max(...peakRss) : null;
    result.measurements = {
      scan_ms: scanMs,
      scan_ms_median: median(scanMs),
      html_ms: htmlMs,
      html_ms_median: median(htmlMs),
      peak_rss_bytes: peakRssBytes,
      peak_rss_mib:
        peakRssBytes === null ? null : Math.round((peakRssBytes / (1024 * 1024)) * 10) / 10,
      audit_sha256: firstHash,
      observed_count: observedCount,
      hash_stable: hashStable,
    };
    if (observedCount !== INSTANCE_COUNT) {
      failures.push(`observed_count ${observedCount} (expected ${INSTANCE_COUNT})`);
    }
    if (median(scanMs) > TARGET_SCAN_MS) {
      failures.push(`scan median ${median(scanMs)} ms exceeds target ${TARGET_SCAN_MS} ms`);
    }
    if (median(htmlMs) > TARGET_HTML_MS) {
      failures.push(`html median ${median(htmlMs)} ms exceeds target ${TARGET_HTML_MS} ms`);
    }
    if (peakRssBytes === null) {
      failures.push("peak RSS could not be measured on this platform (/proc unavailable)");
    } else if (peakRssBytes > TARGET_RSS_BYTES) {
      failures.push(`peak RSS ${peakRssBytes} B exceeds target ${TARGET_RSS_BYTES} B`);
    }
    result.verdict = failures.length === 0 ? "PASS" : "FAIL";
    result.failures = failures;
  } finally {
    fs.rmSync(fixtureDir, { recursive: true, force: true });
    fs.rmSync(outDir, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.writeFileSync(OUT_JSON, `${JSON.stringify(result, null, 2)}\n`, "utf8");
  const m = result.measurements;
  console.log(
    [
      `performance: ${result.verdict}`,
      `scan: ${m.scan_ms?.join(", ")} ms (median ${m.scan_ms_median}, target ≤ ${TARGET_SCAN_MS})`,
      `html: ${m.html_ms?.join(", ")} ms (median ${m.html_ms_median}, target ≤ ${TARGET_HTML_MS})`,
      `peak RSS: ${m.peak_rss_mib ?? "n/a"} MiB (target ≤ 300)`,
      `instances: ${m.observed_count}/${INSTANCE_COUNT}, hash stable: ${m.hash_stable}`,
      `evidence: ${OUT_JSON}`,
    ].join("\n"),
  );
  if (failures.length > 0) {
    console.error(`performance: FAIL — ${failures.join("; ")}`);
    process.exit(1);
  }
}

await main();
