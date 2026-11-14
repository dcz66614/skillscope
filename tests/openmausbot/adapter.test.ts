/**
 * OpenMausBot full-adapter tests (P023 T007).
 *
 * Fixtures live in tests/fixtures/t007/openmausbot/<id>/ (NOT in
 * tests/fixtures/s0/, so the S0 gate is untouched). Each profile.json
 * is an OpenMausBotAdapterInput with fixture-relative paths; the
 * test adds `fixtureDir` (and an explicit `env` where the case needs
 * one). All fixtures are synthetic; the adapter never writes to the
 * host (the a01 tree-hash test proves it).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditOpenMausBot,
  type OpenMausBotAdapterInput,
  type OpenMausBotAdapterResult,
} from "../../src/adapters/openmausbot/adapter.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/t007/openmausbot",
);

function loadInput(
  id: string,
  overrides: Partial<OpenMausBotAdapterInput> = {},
): OpenMausBotAdapterInput {
  const dir = path.join(FIXTURES, id);
  const raw = JSON.parse(
    fs.readFileSync(path.join(dir, "profile.json"), "utf8"),
  ) as OpenMausBotAdapterInput;
  return { ...raw, fixtureDir: dir, ...overrides };
}

function fixtureDir(id: string): string {
  return path.join(FIXTURES, id);
}

function findingIds(result: OpenMausBotAdapterResult): string[] {
  return result.audit.findings.map((finding) => finding.id).sort();
}

function instanceByName(
  result: OpenMausBotAdapterResult,
  logicalName: string,
) {
  return result.audit.instances.find(
    (inst) => inst.logicalName === logicalName,
  );
}

function treeHash(root: string): Map<string, string> {
  const out = new Map<string, string>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full);
      if (entry.isDirectory()) {
        walk(full);
      } else if (entry.isFile()) {
        out.set(
          rel,
          createHash("sha256").update(fs.readFileSync(full)).digest("hex"),
        );
      }
    }
  };
  walk(root);
  return out;
}

describe("data-dir resolution (§4.5)", () => {
  it("a01: default home dir is used when nothing else is set", () => {
    const result = auditOpenMausBot(loadInput("a01-default-home"));
    expect(result.dataDirSource).toBe("default");
    expect(result.dataDir).toBe(
      path.join(fixtureDir("a01-default-home"), "home", ".openmausbot"),
    );
    expect(result.configSource).toBe("file");
    expect(result.snapshotSource).toBe("inline");
    expect(result.audit.status).toBe("PASS");
    expect(findingIds(result)).toEqual([]);
    expect(result.audit.coverage).toEqual({
      enumeratedSources: 2,
      requiredSources: 2,
      unknownScopes: [],
    });
    // Full inventory: assigned + imported ELIGIBLE, plugin DISABLED
    // by disabledPluginIds, library ELIGIBLE (library on, no opt-out).
    expect(instanceByName(result, "release")?.status).toBe("ELIGIBLE");
    expect(instanceByName(result, "docs")?.status).toBe("ELIGIBLE");
    expect(
      instanceByName(result, "openai-curated-remote:sites")?.status,
    ).toBe("DISABLED");
    expect(instanceByName(result, "every-docs")?.status).toBe("ELIGIBLE");
  });

  it("a02: OMB_DATA_DIR wins over the home default", () => {
    const dir = fixtureDir("a02-env-override");
    const result = auditOpenMausBot(
      loadInput("a02-env-override", {
        env: { OMB_DATA_DIR: path.join(dir, "env-data") },
      }),
    );
    expect(result.dataDirSource).toBe("env");
    expect(result.dataDir).toBe(path.join(dir, "env-data"));
    // Env config has skillsLibrary off (home config has it on): the
    // library skill is DISCOVERED, proving the env dir was read.
    expect(instanceByName(result, "every-docs")?.status).toBe("DISCOVERED");
    expect(result.audit.status).toBe("PASS");
  });

  it("a02 without env: the home default is read (library on)", () => {
    const result = auditOpenMausBot(loadInput("a02-env-override", { env: {} }));
    expect(result.dataDirSource).toBe("default");
    expect(instanceByName(result, "every-docs")?.status).toBe("ELIGIBLE");
  });

  it("a03: an explicit dataDir wins over OMB_DATA_DIR", () => {
    const dir = fixtureDir("a03-explicit-wins");
    const result = auditOpenMausBot(
      loadInput("a03-explicit-wins", {
        env: { OMB_DATA_DIR: path.join(dir, "env-data") },
      }),
    );
    expect(result.dataDirSource).toBe("explicit");
    expect(result.dataDir).toBe(path.join(dir, "data-explicit"));
    expect(result.configSource).toBe("file");
    expect(result.audit.status).toBe("PASS");
  });
});

describe("snapshot acquisition and version gate", () => {
  it("a04: no snapshot at all is INCOMPLETE (ADR-007), not an empty inventory", () => {
    const result = auditOpenMausBot(loadInput("a04-missing-snapshot"));
    expect(result.snapshotSource).toBe("missing");
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["SNAPSHOT"]);
    expect(result.audit.coverage.enumeratedSources).toBe(1);
    expect(result.audit.coverage.requiredSources).toBe(2);
    expect(findingIds(result)).toEqual(["SOURCE_NOT_ENUMERATED"]);
    expect(result.audit.instances).toEqual([]);
  });

  it("a01 with a v99 snapshot is INCOMPLETE via the PoC version gate", () => {
    const input = loadInput("a01-default-home");
    const snapshot = {
      ...(input.snapshot as Record<string, unknown>),
      version: "openmausbot-snapshot/v99",
    };
    const result = auditOpenMausBot({ ...input, snapshot });
    expect(result.snapshotSource).toBe("unknown-version");
    expect(result.snapshotVersion).toBe("openmausbot-snapshot/v99");
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["SNAPSHOT"]);
    expect(result.audit.instances).toEqual([]);
  });

  it("a01 with a malformed inline snapshot is INCOMPLETE (invalid-shape)", () => {
    const input = loadInput("a01-default-home");
    const result = auditOpenMausBot({
      ...input,
      snapshot: { version: "openmausbot-snapshot/v1", skills: "nope" },
    });
    expect(result.snapshotSource).toBe("invalid-shape");
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["SNAPSHOT"]);
    expect(findingIds(result)).toEqual(["SOURCE_NOT_ENUMERATED"]);
  });

  it("a14: a snapshot file loads; an invalid file and a missing file are INCOMPLETE", () => {
    const ok = auditOpenMausBot(loadInput("a14-snapshot-file"));
    expect(ok.snapshotSource).toBe("file");
    expect(ok.audit.status).toBe("PASS");
    expect(instanceByName(ok, "release")?.status).toBe("ELIGIBLE");
    expect(instanceByName(ok, "docs")?.status).toBe("ELIGIBLE");

    const bad = auditOpenMausBot(
      loadInput("a14-snapshot-file", { snapshotPath: "./snapshot-bad.json" }),
    );
    expect(bad.snapshotSource).toBe("invalid-json");
    expect(bad.audit.status).toBe("INCOMPLETE");
    expect(bad.audit.coverage.unknownScopes).toEqual(["SNAPSHOT"]);

    const missing = auditOpenMausBot(
      loadInput("a14-snapshot-file", { snapshotPath: "./does-not-exist.json" }),
    );
    expect(missing.snapshotSource).toBe("missing");
    expect(missing.audit.status).toBe("INCOMPLETE");
  });
});

describe("missing per-bot lists (ADR-007)", () => {
  it("a01 without the plugin list and without emptyLists is INCOMPLETE for PLUGIN", () => {
    const input = loadInput("a01-default-home");
    const snapshot = input.snapshot as Record<string, unknown>;
    const skills = (snapshot["skills"] as Array<Record<string, unknown>>).filter(
      (skill) => skill["kind"] !== "plugin",
    );
    const result = auditOpenMausBot({
      ...input,
      snapshot: { ...snapshot, skills },
    });
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["PLUGIN"]);
    expect(result.diagnostics.missingLists).toEqual(["plugin"]);
    expect(findingIds(result)).toEqual(["SOURCE_NOT_ENUMERATED"]);
  });

  it("the same snapshot with emptyLists ['plugin'] passes (explicit empty, not missing)", () => {
    const input = loadInput("a01-default-home");
    const snapshot = input.snapshot as Record<string, unknown>;
    const skills = (snapshot["skills"] as Array<Record<string, unknown>>).filter(
      (skill) => skill["kind"] !== "plugin",
    );
    const result = auditOpenMausBot({
      ...input,
      snapshot: { ...snapshot, skills, emptyLists: ["plugin"] },
    });
    expect(result.audit.status).toBe("PASS");
    expect(result.diagnostics.missingLists).toEqual([]);
  });
});

describe("plugin disable path (T006 leftover, #5449 item 8)", () => {
  it("a07: a plugin skill without pluginId is UNKNOWN / INCOMPLETE (ADR-008)", () => {
    const result = auditOpenMausBot(loadInput("a07-unattributed-plugin"));
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["PLUGIN"]);
    expect(result.diagnostics.unattributedPlugins).toEqual(["sites"]);
    const sites = instanceByName(result, "sites");
    expect(sites?.status).toBe("UNKNOWN");
    const finding = result.audit.findings.find(
      (f) => f.id === "SOURCE_NOT_ENUMERATED" && f.sourceScope === "PLUGIN",
    );
    expect(finding).toBeDefined();
    expect(finding?.detail).toContain("no pluginId");
  });

  it("a08: disabledPluginIds switches the plugin off through the kernel; the undisabled one leaks", () => {
    const result = auditOpenMausBot(loadInput("a08-disable-path"));
    expect(result.audit.status).toBe("FAIL");
    expect(result.audit.policy.applied).toBe(true);
    expect(result.audit.policy.violationCount).toBe(1);
    expect(
      instanceByName(result, "openai-curated-remote:sites")?.status,
    ).toBe("DISABLED");
    expect(instanceByName(result, "notes-plugin:notes")?.status).toBe("ELIGIBLE");
    const leaks = result.audit.findings.filter((f) => f.id === "SCOPE_LEAK");
    expect(leaks).toHaveLength(1);
    expect(leaks[0]?.sourceScope).toBe("PLUGIN");
    // The leak references the undisabled plugin instance only, by its
    // canonical audit key "<sourceRootId>:<relativePath>".
    expect(leaks[0]?.instanceIds).toEqual(["snapshot:plugin:notes/SKILL.md"]);
  });
});

describe("inventory completeness", () => {
  it("a09: a skill on disk but absent from the snapshot is INCOMPLETE (reconciliation)", () => {
    const result = auditOpenMausBot(loadInput("a09-reconciliation"));
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["SHARED_LIBRARY"]);
    expect(result.audit.coverage.requiredSources).toBe(3);
    expect(result.audit.coverage.enumeratedSources).toBe(3);
    expect(
      result.diagnostics.reconciliation.skillsMissingFromSnapshot,
    ).toEqual(["SHARED_LIBRARY:ghost"]);
    expect(result.diagnostics.reconciliation.skillsOnDisk).toBe(2);
    const finding = result.audit.findings.find(
      (f) =>
        f.id === "SOURCE_NOT_ENUMERATED" &&
        f.sourceScope === "SHARED_LIBRARY",
    );
    expect(finding?.detail).toContain('"ghost"');
    expect(finding?.detail).toContain("absent from the versioned snapshot");
  });

  it("a16: a snapshot skill dir with no readable SKILL.md is INCOMPLETE", () => {
    const result = auditOpenMausBot(loadInput("a16-no-skill-md"));
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["SHARED_LIBRARY"]);
    const finding = result.audit.findings.find(
      (f) =>
        f.id === "SOURCE_NOT_ENUMERATED" &&
        f.sourceScope === "SHARED_LIBRARY",
    );
    expect(finding?.detail).toContain("no readable SKILL.md");
    expect(finding?.detail).toContain('"empty-dir"');
  });

  it("a09 with a missing scan root is INCOMPLETE for that root", () => {
    const input = loadInput("a09-reconciliation");
    const result = auditOpenMausBot({
      ...input,
      scanRoots: [{ scope: "SHARED_LIBRARY", path: "./library-does-not-exist" }],
    });
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["SHARED_LIBRARY"]);
    expect(result.diagnostics.reconciliation.rootsMissing).toEqual([
      "SHARED_LIBRARY",
    ]);
  });
});

describe("full-manifest re-check (T005 parser over the PoC minimum)", () => {
  it("a10: reserved-name and duplicate-key manifests gain INVALID_MANIFEST (P2) but stay ELIGIBLE", () => {
    const result = auditOpenMausBot(loadInput("a10-manifest"));
    expect(result.audit.status).toBe("PASS");
    const invalid = result.audit.findings.filter(
      (f) => f.id === "INVALID_MANIFEST",
    );
    expect(invalid).toHaveLength(2);
    expect(invalid.map((f) => f.severity)).toEqual(["P2", "P2"]);
    expect(invalid.some((f) => f.detail.includes("reserved-name"))).toBe(true);
    expect(invalid.some((f) => f.detail.includes("yaml-parse-error"))).toBe(true);
    expect(instanceByName(result, "claude-helper")?.status).toBe("ELIGIBLE");
    expect(instanceByName(result, "dup-keys")?.status).toBe("ELIGIBLE");
    expect(result.diagnostics.manifestRechecks.checked).toBe(2);
    expect(result.diagnostics.manifestRechecks.invalid).toHaveLength(2);
  });
});

describe("fail-open config (PoC rules, through the adapter)", () => {
  it("a11: corrupt config.json is INCOMPLETE with FAIL_OPEN_CONFIG", () => {
    const result = auditOpenMausBot(loadInput("a11-corrupt-config"));
    expect(result.configSource).toBe("invalid");
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toContain("CONFIG");
    expect(findingIds(result)).toContain("FAIL_OPEN_CONFIG");
  });

  it("a12: corrupt opt-out file is INCOMPLETE with FAIL_OPEN_CONFIG (library on)", () => {
    const result = auditOpenMausBot(loadInput("a12-corrupt-optout"));
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toContain("SHARED_LIBRARY");
    expect(findingIds(result)).toContain("FAIL_OPEN_CONFIG");
  });
});

describe("policy through the kernel (ADR-005 / ADR-006)", () => {
  it("a15: an ELIGIBLE library skill in a forbidden scope leaks (FAIL)", () => {
    const result = auditOpenMausBot(loadInput("a15-policy"));
    expect(result.audit.status).toBe("FAIL");
    expect(result.audit.policy.applied).toBe(true);
    expect(result.audit.policy.violationCount).toBe(1);
    expect(findingIds(result)).toEqual(["SCOPE_LEAK"]);
  });

  it("a02 with the same policy: a DISCOVERED library skill does not leak (ADR-006)", () => {
    const dir = fixtureDir("a02-env-override");
    const result = auditOpenMausBot(
      loadInput("a02-env-override", {
        env: { OMB_DATA_DIR: path.join(dir, "env-data") },
        policy: { forbiddenScopes: ["SHARED_LIBRARY"] },
      }),
    );
    expect(instanceByName(result, "every-docs")?.status).toBe("DISCOVERED");
    expect(findingIds(result)).toEqual([]);
    expect(result.audit.status).toBe("PASS");
  });

  it("a15 without a policy: no policy findings at all (ADR-005)", () => {
    const input = loadInput("a15-policy");
    const result = auditOpenMausBot({ ...input, policy: undefined });
    expect(result.audit.policy.applied).toBe(false);
    expect(findingIds(result)).toEqual([]);
    expect(result.audit.status).toBe("PASS");
  });
});

describe("host writes: zero", () => {
  it("auditing a01 leaves every file byte-identical (no new, removed or changed files)", () => {
    const dir = fixtureDir("a01-default-home");
    const before = treeHash(dir);
    auditOpenMausBot(loadInput("a01-default-home"));
    const after = treeHash(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, hash] of before) {
      expect(after.get(rel)).toBe(hash);
    }
  });

  it("no finding detail leaks an absolute fixture path", () => {
    const dir = fixtureDir("a01-default-home");
    for (const id of ["a01-default-home", "a07-unattributed-plugin", "a09-reconciliation"]) {
      const result = auditOpenMausBot(loadInput(id));
      for (const finding of result.audit.findings) {
        expect(finding.detail).not.toContain(dir);
        expect(finding.detail).not.toContain(FIXTURES);
      }
    }
  });
});
