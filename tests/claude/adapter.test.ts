/**
 * Claude Code full-adapter tests (P023 T008).
 *
 * Fixtures live in tests/fixtures/t008/claude/<id>/ (NOT in
 * tests/fixtures/s0/, so the S0 gate is untouched). Each profile.json
 * is a ClaudeAdapterInput with fixture-relative paths; the test adds
 * `fixtureDir`. All fixtures are synthetic; the adapter never writes
 * to the host (the b01 tree-hash test proves it) and never reads the
 * real user home (defaults resolve under the fixture home/repo dirs).
 */
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  auditClaude,
  type ClaudeAdapterInput,
  type ClaudeAdapterResult,
} from "../../src/adapters/claude/adapter.js";

const FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/t008/claude",
);

function loadInput(
  id: string,
  overrides: Partial<ClaudeAdapterInput> = {},
): ClaudeAdapterInput {
  const dir = path.join(FIXTURES, id);
  const raw = JSON.parse(
    fs.readFileSync(path.join(dir, "profile.json"), "utf8"),
  ) as ClaudeAdapterInput;
  return { ...raw, fixtureDir: dir, ...overrides };
}

function fixtureDir(id: string): string {
  return path.join(FIXTURES, id);
}

function findingIds(result: ClaudeAdapterResult): string[] {
  return result.audit.findings.map((finding) => finding.id).sort();
}

function instanceByName(
  result: ClaudeAdapterResult,
  logicalName: string,
) {
  return result.audit.instances.find(
    (inst) => inst.logicalName === logicalName,
  );
}

function instancesOf(
  result: ClaudeAdapterResult,
  logicalName: string,
) {
  return result.audit.instances.filter(
    (inst) => inst.logicalName === logicalName,
  );
}

function layerStatus(
  result: ClaudeAdapterResult,
  name: string,
): string | undefined {
  return result.settingsLayers.find((layer) => layer.name === name)?.status;
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
      } else if (entry.isSymbolicLink()) {
        out.set(rel, `symlink:${fs.readlinkSync(full)}`);
      }
    }
  };
  walk(root);
  return out;
}

describe("three-layer enumeration (USER / PROJECT / PLUGIN)", () => {
  it("b01: enterprise + personal + project + nested + plugin enumerate; PASS", () => {
    const result = auditClaude(loadInput("b01-basic-layers"));
    expect(result.audit.status).toBe("PASS");
    expect(findingIds(result)).toEqual([]);
    expect(result.audit.coverage).toEqual({
      enumeratedSources: 5,
      requiredSources: 5,
      unknownScopes: [],
    });
    expect(instanceByName(result, "release")?.sourceScope).toBe("ENTERPRISE");
    expect(instanceByName(result, "notes")?.sourceScope).toBe("PERSONAL");
    expect(instanceByName(result, "deploy")?.sourceScope).toBe("PROJECT");
    expect(instanceByName(result, "internal-tool")?.sourceScope).toBe("NESTED");
    expect(instanceByName(result, "acme:deploy")?.sourceScope).toBe("PLUGIN");
    expect(result.audit.instances).toHaveLength(5);
    // Settings layers: managed/user/project present, local missing
    // (a missing layer file is not an error).
    expect(layerStatus(result, "managed")).toBe("present");
    expect(layerStatus(result, "user")).toBe("present");
    expect(layerStatus(result, "project")).toBe("present");
    expect(layerStatus(result, "local")).toBe("missing");
    // Namespace coexistence is observed, never merged.
    expect(result.diagnostics.namespacePairs).toEqual([
      { baseName: "deploy", bare: "deploy", namespaced: ["acme:deploy"] },
    ]);
  });

  it("b16: ACCOUNT_SYNC without a snapshot is INCOMPLETE", () => {
    const result = auditClaude(loadInput("b16-account-sync"));
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["ACCOUNT_SYNC"]);
    expect(findingIds(result)).toEqual(["SOURCE_NOT_ENUMERATED"]);
  });
});

describe("settings layers and user overrides (ADR-009)", () => {
  it("b02: a user-layer skillOverrides disables only the bare skill", () => {
    const result = auditClaude(loadInput("b02-user-override"));
    expect(result.audit.status).toBe("PASS");
    expect(instanceByName(result, "deploy")?.status).toBe("DISABLED");
    expect(instanceByName(result, "acme:deploy")?.status).toBe("ELIGIBLE");
    expect(result.diagnostics.overriddenByUser).toEqual(["deploy"]);
    expect(findingIds(result)).toEqual([]);
  });

  it("b03: an unreadable user settings file is INCOMPLETE (USER_SETTINGS)", () => {
    const result = auditClaude(loadInput("b03-user-settings-unreadable"));
    expect(layerStatus(result, "user")).toBe("invalid-json");
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["USER_SETTINGS"]);
    expect(findingIds(result)).toEqual(["SOURCE_NOT_ENUMERATED"]);
    const finding = result.audit.findings[0];
    expect(finding?.detail).toContain("user settings could not be read");
  });

  it("b04: an unreadable managed settings file is INCOMPLETE (MANAGED_SETTINGS)", () => {
    const result = auditClaude(loadInput("b04-managed-settings-unreadable"));
    expect(layerStatus(result, "managed")).toBe("invalid-json");
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["MANAGED_SETTINGS"]);
  });

  it("b17: a settings file with the wrong shape is INCOMPLETE (invalid-shape)", () => {
    const result = auditClaude(loadInput("b17-settings-shape-invalid"));
    expect(layerStatus(result, "user")).toBe("invalid-shape");
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["USER_SETTINGS"]);
  });
});

describe("plugin enable/disable mapping (enabledPlugins)", () => {
  it("b05: enabledPlugins disables acme@team-market; notes stays eligible", () => {
    const result = auditClaude(loadInput("b05-enabled-plugins"));
    expect(result.audit.status).toBe("PASS");
    const marketplaceAcme = instancesOf(result, "acme:deploy").find(
      (inst) => inst.instanceId === "plugin-team-market-acme:deploy/SKILL.md",
    );
    expect(marketplaceAcme?.status).toBe("DISABLED");
    expect(instanceByName(result, "notes:notes")?.status).toBe("ELIGIBLE");
    expect(result.diagnostics.overriddenByUser).toEqual(["acme@team-market"]);
    // The caller-provided plugin-acme root is a different installation
    // of the same plugin: same logical name, distinct instance.
    const callerAcme = instancesOf(result, "acme:deploy").find(
      (inst) => inst.instanceId === "plugin-acme:deploy/SKILL.md",
    );
    expect(callerAcme?.status).toBe("ELIGIBLE");
    // Two distinct instances share one logical name: P2 only.
    expect(findingIds(result)).toEqual(["SAME_NAME_COLLISION"]);
  });

  it("b06: the same plugin from an unregistered extra dir is DISABLE_MISMATCH (FAIL)", () => {
    const result = auditClaude(loadInput("b06-extra-plugin-dir-conflict"));
    expect(result.audit.status).toBe("FAIL");
    const extra = instancesOf(result, "acme:deploy").find(
      (inst) => inst.instanceId === "plugin-extra-team-market-acme:deploy/SKILL.md",
    );
    expect(extra?.status).toBe("ELIGIBLE");
    expect(result.diagnostics.extraPluginConflicts).toEqual(["acme"]);
    const mismatch = result.audit.findings.find(
      (finding) => finding.id === "DISABLE_MISMATCH",
    );
    expect(mismatch).toBeDefined();
    expect(mismatch?.sourceScope).toBe("PLUGIN");
    expect(mismatch?.instanceIds).toEqual([
      "plugin-extra-team-market-acme:deploy/SKILL.md",
    ]);
    expect(mismatch?.detail).toContain("disable mapping does not cover it");
    // The registered copy is DISABLED; only the extra copy mismatches.
    expect(
      result.audit.findings.filter((f) => f.id === "DISABLE_MISMATCH"),
    ).toHaveLength(1);
  });

  it("b09: strictKnownMarketplaces refuses the extra dir (DISCOVERED, no mismatch)", () => {
    const result = auditClaude(loadInput("b09-strict-marketplaces"));
    expect(result.diagnostics.strictKnownMarketplaces).toBe(true);
    const extra = instancesOf(result, "acme:deploy").find(
      (inst) => inst.instanceId === "plugin-extra-default-acme:deploy/SKILL.md",
    );
    expect(extra?.status).toBe("DISCOVERED");
    expect(result.diagnostics.extraPluginConflicts).toEqual([]);
    expect(findingIds(result)).toEqual(["SAME_NAME_COLLISION"]);
    expect(result.audit.status).toBe("PASS");
  });
});

describe("marketplaces and additional directories", () => {
  it("b07: a marketplace declared in project settings is enumerated", () => {
    const result = auditClaude(loadInput("b07-extra-marketplace"));
    expect(result.audit.status).toBe("PASS");
    expect(
      result.pluginRoots.some(
        (root) => root.sourceRootId === "plugin-team-market-acme",
      ),
    ).toBe(true);
    expect(
      result.pluginRoots.find(
        (root) => root.sourceRootId === "plugin-team-market-acme",
      )?.marketplace,
    ).toBe("team-market");
  });

  it("b08: a git-source marketplace is INCOMPLETE, never silently ignored", () => {
    const result = auditClaude(loadInput("b08-git-marketplace"));
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["PLUGIN"]);
    expect(result.diagnostics.unresolvableMarketplaces).toEqual([
      "remote-market",
    ]);
    expect(findingIds(result)).toEqual(["SOURCE_NOT_ENUMERATED"]);
  });

  it("b10: an untrusted folder leaves settings-derived ADD_DIR skills DISCOVERED", () => {
    const result = auditClaude(loadInput("b10-untrusted"));
    expect(result.diagnostics.untrusted).toBe(true);
    expect(instanceByName(result, "guide")?.sourceScope).toBe("ADD_DIR");
    expect(instanceByName(result, "guide")?.status).toBe("DISCOVERED");
    expect(result.audit.status).toBe("PASS");
  });

  it("b11: additionalDirectories — one present, one missing is INCOMPLETE", () => {
    const result = auditClaude(loadInput("b11-additional-directories"));
    expect(instanceByName(result, "guide")?.status).toBe("ELIGIBLE");
    expect(result.audit.status).toBe("INCOMPLETE");
    expect(result.audit.coverage.unknownScopes).toEqual(["ADD_DIR"]);
    expect(result.diagnostics.missingAdditionalDirs).toEqual([
      "./missing-docs",
    ]);
    expect(findingIds(result)).toEqual(["SOURCE_NOT_ENUMERATED"]);
  });
});

describe("namespace rules", () => {
  it("b13: acme:deploy vs deploy vs other:deploy coexist; override hits one", () => {
    const result = auditClaude(loadInput("b13-namespace-collision"));
    expect(result.audit.status).toBe("PASS");
    expect(instanceByName(result, "acme:deploy")?.status).toBe("DISABLED");
    expect(instanceByName(result, "deploy")?.status).toBe("ELIGIBLE");
    expect(instanceByName(result, "other:deploy")?.status).toBe("ELIGIBLE");
    // No finding links the namespaced instances to the bare one:
    // they are three distinct instances, not one merged name.
    expect(findingIds(result)).toEqual([]);
    expect(result.diagnostics.namespacePairs).toEqual([
      {
        baseName: "deploy",
        bare: "deploy",
        namespaced: ["acme:deploy", "other:deploy"],
      },
    ]);
    expect(result.diagnostics.overriddenByUser).toEqual(["acme:deploy"]);
  });
});

describe("full-manifest re-check (T005 parser over the PoC minimum)", () => {
  it("b12: reserved name and duplicate keys gain INVALID_MANIFEST (P2) but stay ELIGIBLE", () => {
    const result = auditClaude(loadInput("b12-manifest-recheck"));
    expect(result.audit.status).toBe("PASS");
    const invalid = result.audit.findings.filter(
      (finding) => finding.id === "INVALID_MANIFEST",
    );
    expect(invalid).toHaveLength(2);
    expect(invalid.map((finding) => finding.severity)).toEqual(["P2", "P2"]);
    expect(invalid.some((finding) => finding.detail.includes("reserved-name"))).toBe(true);
    expect(invalid.some((finding) => finding.detail.includes("yaml-parse-error"))).toBe(true);
    expect(instanceByName(result, "claude-helper")?.status).toBe("ELIGIBLE");
    expect(instanceByName(result, "dup-keys")?.status).toBe("ELIGIBLE");
    expect(result.diagnostics.manifestRechecks.checked).toBe(7);
    expect(result.diagnostics.manifestRechecks.invalid).toEqual([
      "project:claude-helper/SKILL.md",
      "project:dup-keys/SKILL.md",
    ]);
  });
});

describe("symlink escapes (T005 discovery through the kernel)", () => {
  it("b18: a symlink escaping its plugin root is SYMLINK_OUTSIDE_ROOT / INCOMPLETE", () => {
    const result = auditClaude(loadInput("b18-symlink-escape"));
    expect(result.audit.status).toBe("INCOMPLETE");
    const finding = result.audit.findings.find(
      (entry) => entry.id === "SYMLINK_OUTSIDE_ROOT",
    );
    expect(finding).toBeDefined();
    expect(finding?.sourceScope).toBe("PLUGIN");
    expect(finding?.status).toBe("UNKNOWN");
    // The target was still read by the PoC (fail-closed: the escape
    // is flagged even though the content was seen).
    expect(instanceByName(result, "acme:secret")?.status).toBe("ELIGIBLE");
  });
});

describe("policy through the kernel (ADR-005 / ADR-006)", () => {
  it("b14: forbidden PLUGIN leaks; forbidden bare name does not match acme:deploy", () => {
    const result = auditClaude(loadInput("b14-policy"));
    expect(result.audit.status).toBe("FAIL");
    expect(result.audit.policy.applied).toBe(true);
    expect(findingIds(result)).toEqual(["DISABLE_MISMATCH", "SCOPE_LEAK"]);
    const leak = result.audit.findings.find(
      (finding) => finding.id === "SCOPE_LEAK",
    );
    expect(leak?.instanceIds).toEqual(["plugin-acme:deploy/SKILL.md"]);
    const mismatch = result.audit.findings.find(
      (finding) => finding.id === "DISABLE_MISMATCH",
    );
    expect(mismatch?.instanceIds).toEqual(["project:deploy/SKILL.md"]);
  });

  it("b14 without a policy: no policy findings at all (ADR-005)", () => {
    const input = loadInput("b14-policy");
    const result = auditClaude({ ...input, policy: undefined });
    expect(result.audit.policy.applied).toBe(false);
    expect(findingIds(result)).toEqual([]);
    expect(result.audit.status).toBe("PASS");
  });
});

describe("host writes: zero", () => {
  it("auditing b01 leaves every file byte-identical (no new, removed or changed files)", () => {
    const dir = fixtureDir("b01-basic-layers");
    const before = treeHash(dir);
    auditClaude(loadInput("b01-basic-layers"));
    const after = treeHash(dir);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [rel, hash] of before) {
      expect(after.get(rel)).toBe(hash);
    }
  });

  it("no finding detail leaks an absolute fixture path", () => {
    for (const id of [
      "b03-user-settings-unreadable",
      "b06-extra-plugin-dir-conflict",
      "b08-git-marketplace",
      "b11-additional-directories",
      "b18-symlink-escape",
    ]) {
      const dir = fixtureDir(id);
      const result = auditClaude(loadInput(id));
      for (const finding of result.audit.findings) {
        expect(finding.detail).not.toContain(dir);
        expect(finding.detail).not.toContain(FIXTURES);
      }
    }
  });
});
