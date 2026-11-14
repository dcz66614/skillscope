#!/usr/bin/env node
/**
 * T001 environment probe (IMPLEMENTATION_PLAN §3.1).
 *
 * Runs the frozen Linux environment commands, plus CPU / memory / disk /
 * browser checks, and writes a JSON record to 03_evidence/T001/env-probe.json.
 * Read-only: it never modifies host configuration, skills, or credentials.
 * Usage: node ./scripts/env/probe.mjs
 */
import { execFile } from "node:child_process";
import { statfsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { cpus, freemem, totalmem } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const OUT = resolve(ROOT, "03_evidence", "T001", "env-probe.json");

function run(command, args = []) {
  return execFileAsync(command, args, { cwd: ROOT, timeout: 30_000 })
    .then(({ stdout }) => ({ command: [command, ...args].join(" "), exitCode: 0, output: stdout.trim() }))
    .catch((error) => ({
      command: [command, ...args].join(" "),
      exitCode: typeof error.code === "number" ? error.code : 1,
      output: (error.stdout || "").trim(),
      error: String(error.stderr || error.message || error).trim().slice(0, 500),
    }));
}

async function main() {
  const probe = {
    probedAtUtc: new Date().toISOString(),
    workdir: ROOT,
    commands: {},
    cpu: { count: cpus().length, model: cpus()[0]?.model ?? "unknown" },
    memory: { totalBytes: totalmem(), freeBytes: freemem() },
    disk: {},
    browsers: {},
    registryReachable: false,
  };

  const uname = await run("uname", ["-a"]);
  probe.commands.uname = uname;
  probe.commands.nodeVersion = await run("node", ["-v"]);
  probe.commands.npmVersion = await run("npm", ["-v"]);
  probe.commands.pythonVersion = await run("python3", ["--version"]);
  probe.commands.gitVersion = await run("git", ["--version"]);
  probe.commands.nodePlatform = await run("node", ["-p", "process.platform + ' ' + process.arch"]);
  probe.commands.pythonDetail = await run("python3", [
    "-c",
    "import os,sys; print(sys.version); print(os.path.realpath('.'))",
  ]);
  probe.commands.pyYaml = await run("python3", ["-c", "import yaml; print(yaml.__version__)"]);
  probe.commands.nodeToml = await run("node", [
    "-e",
    "console.log(process.getBuiltinModule('node:toml') ? 'present' : 'absent')",
  ]);

  try {
    const stat = statfsSync(ROOT);
    probe.disk = {
      blockSize: stat.bsize,
      totalBytes: stat.blocks * stat.bsize,
      freeBytes: stat.bfree * stat.bsize,
      availableBytes: stat.bavail * stat.bsize,
    };
  } catch (error) {
    probe.disk = { error: String(error.message || error) };
  }

  for (const name of ["chromium", "chromium-browser", "google-chrome", "firefox"]) {
    const found = await run("sh", ["-c", `command -v ${name}`]);
    probe.browsers[name] = found.exitCode === 0 ? found.output : null;
  }

  const registry = await run("npm", ["view", "typescript", "version"]);
  probe.registryReachable = registry.exitCode === 0;
  probe.commands.npmRegistry = registry;

  await mkdir(dirname(OUT), { recursive: true });
  await writeFile(OUT, `${JSON.stringify(probe, null, 2)}\n`, "utf8");
  console.log(`env probe written: ${OUT}`);
  console.log(JSON.stringify(probe, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
