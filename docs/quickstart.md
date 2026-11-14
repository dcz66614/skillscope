# Quickstart

SkillScope audits which skills a coding agent can actually load, from which sources, against a policy you write. It never executes a skill, never writes to a host directory, and never touches the network.

## Prerequisites

- Node.js 24 or later (`node --version`).
- No account, no API key, no network access. Everything runs locally.

## Install

```sh
git clone <this repository>
cd skillscope
npm ci
npm run build
```

`npm ci` installs exactly two runtime dependencies (`smol-toml`, `yaml`, both pinned in the lockfile). There are no other runtime dependencies.

## Your first audit

```sh
# 1. Create a starter profile. It points at a synthetic home
#    (./.skillscope-home), never at your real home directory.
node dist/cli/index.js init

# 2. Audit it. A JSON report is written next to the profile.
node dist/cli/index.js audit --profile skillscope.json

# 3. Same audit as a self-contained HTML report (no external resources).
node dist/cli/index.js audit --profile skillscope.json --format html
```

The starter profile points at empty conventional roots, so the first audit is honestly INCOMPLETE (exit 2): the USER and ADMIN sources cannot be enumerated because they do not exist yet. That is the fail-closed answer — an audit that cannot see a required source never reports PASS.

## Audit a repo directly

```sh
node dist/cli/index.js audit --engine codex --cwd .
```

This reads `<dir>/skillscope.json`. If there is no profile file, the CLI exits 3 and tells you to run `init` first. It never guesses host roots.

## Reading the result

The console prints one line per skill instance (`✓` eligible, `✗` disabled / invalid / unknown, `~` discovered but not loaded), one line per finding, a coverage line, and a `RESULT:` line:

```text
CODEX / profile: codex-demo-fail
  ✗ repo/.agents/skills/deploy/SKILL.md
  ✓ repo/.agents/skills/release/SKILL.md
  ✗ user/.agents/skills/deploy/SKILL.md
  ! NAME_SELECTOR_BLAST_RADIUS [P1] (GLOBAL): name selector "deploy" affects 2 distinct instances
  coverage: 5/5 sources enumerated
RESULT: FAIL
```

The HTML report shows the same result as a Scope Matrix (bot × source), the findings, the coverage and the report hashes. The JSON report is canonical JSON (UTF-8, LF, NFC, stable key order) and validates against the frozen `skillscope.report/v1` schema in `schemas/`.

## Exit codes

| Code | Result | Meaning |
| --- | --- | --- |
| 0 | PASS | All required sources enumerated; the effective set matches the policy. |
| 1 | FAIL | At least one confirmed scope deviation. |
| 2 | INCOMPLETE | A required source could not be enumerated. Never weakened to 0. |
| 3 | Input / config error | Missing or malformed profile, invalid policy, unknown option. |
| 4 | Internal error | The audit or the report write failed unexpectedly. |

## CI mode

```sh
node dist/cli/index.js audit --profile skillscope.json --ci
```

`--ci` prints exactly one machine-readable line to stdout and keeps the exit codes above:

```text
skillscope: RESULT=FAIL exit=1 report=/path/to/skillscope.report.json
```

A ready-to-copy GitHub Actions example is in `.github/workflows/skillscope.yml`. It only calls the locally built CLI — no remote action, no download, no upload.

## The built-in demo

```sh
npm run demo
```

Audits three synthetic profiles (one per engine, one per audit state: Codex FAIL, Claude Code PASS, OpenMausBot INCOMPLETE), writes JSON + HTML reports and a screenshot to `03_evidence/T009/demo/`, and verifies determinism (same profile twice → identical JSON bytes). The demo needs no account, no LLM, no network and no real skills.

## Verify the installation itself

```sh
npm run s0:gate
```

Replays the frozen S0 gate: 48 synthetic fixtures through the production adapters and the independent Python Oracle, 100 replays with a single gate hash. Exit 0 means the installation agrees with the Oracle.

## Writing a policy

The profile file (`skillscope.json`, schema `skillscope.profile/v1`) carries a `policy` block:

```json
{
  "policy": {
    "allowed_scopes": ["REPO", "USER"],
    "forbidden_scopes": ["PLUGIN"],
    "forbidden_names": ["deploy"]
  }
}
```

The policy is always passed to the rule engine — a missing policy would silently drop every policy finding, so the CLI never runs an audit without one. See [docs/host-rules.md](host-rules.md) for what each host's scopes mean.
