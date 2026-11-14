/**
 * Claude Code PoC fixture + unit tests (T003).
 *
 * Each fixture in tests/fixtures/s0/claude/<id>/ holds a profile.json
 * (adapter input, paths relative to the fixture dir) and an expected.json
 * hand-derived from PROJECT_BOOK §4.4. The test asserts the adapter
 * reproduces the expected instances, findings, coverage and status.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveClaudeFixture,
  type ClaudePocInput,
  type ClaudePocResult,
} from "../../src/adapters/claude/claude-poc.js";

const CLAUDE_FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/s0/claude",
);

interface Expected {
  instances: Array<{ logicalName: string; sourceScope: string; status: string }>;
  findings: string[];
  status: string;
  coverage: {
    enumeratedSources: number;
    requiredSources: number;
    unknownScopes: string[];
  };
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function normalizeInstances(result: ClaudePocResult): string[] {
  return result.instances
    .map((inst) => `${inst.logicalName}|${inst.sourceScope}|${inst.status}`)
    .sort();
}

function normalizeExpected(expected: Expected): string[] {
  return expected.instances
    .map((inst) => `${inst.logicalName}|${inst.sourceScope}|${inst.status}`)
    .sort();
}

function checkFixture(fixtureId: string): void {
  const dir = path.join(CLAUDE_FIXTURES, fixtureId);
  const profile = loadJson<ClaudePocInput>(path.join(dir, "profile.json"));
  const expected = loadJson<Expected>(path.join(dir, "expected.json"));
  const result = resolveClaudeFixture(profile, dir);
  expect(normalizeInstances(result)).toEqual(normalizeExpected(expected));
  expect(result.findings.map((finding) => finding.id).sort()).toEqual(
    [...expected.findings].sort(),
  );
  expect(result.status).toBe(expected.status);
  expect(result.coverage).toEqual(expected.coverage);
}

describe("claude PoC fixtures", () => {
  for (const fixtureId of [
    "c01-basic",
    "c02-root-nested-coexist",
    "c03-plugin-namespace",
    "c04-adddir-and-sync",
    "c05-name-override-blast",
    "c06-sync-unenumerated",
    "c07-nested-scope-leak",
    "c08-invalid-manifest",
    "c09-enterprise-personal-same-name",
    "c10-plugin-override-scoped",
    "c11-adddir-unvisited-nested",
    "c12-duplicate-content-p2",
    "c13-enterprise-scope-leak",
    "c14-plugin-namespace-flattened",
    "c15-adddir-missing-required",
    "c16-override-blast-three-scopes",
  ]) {
    it(`${fixtureId} matches its hand-derived expected result`, () => {
      checkFixture(fixtureId);
    });
  }
});

describe("claude PoC rules (unit)", () => {
  const tmpRoot = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    "../fixtures/s0/claude",
  );

  it("unvisited nested root is out of session scope, not unknown", () => {
    const dir = path.join(tmpRoot, "c02-root-nested-coexist");
    const profile = loadJson<ClaudePocInput>(path.join(dir, "profile.json"));
    const nested = profile.sourceRoots.find((root) => root.scope === "NESTED");
    expect(nested).toBeDefined();
    const unvisited: ClaudePocInput = {
      ...profile,
      sourceRoots: profile.sourceRoots.map((root) =>
        root.scope === "NESTED" ? { ...root, visited: false } : root,
      ),
    };
    const result = resolveClaudeFixture(unvisited, dir);
    expect(result.instances.map((inst) => inst.logicalName)).toEqual(["deploy"]);
    expect(result.instances[0]?.sourceScope).toBe("PROJECT");
    expect(result.status).toBe("PASS");
    expect(result.coverage).toEqual({
      enumeratedSources: 2,
      requiredSources: 2,
      unknownScopes: [],
    });
  });

  it("namespaced override disables only the plugin instance", () => {
    const dir = path.join(tmpRoot, "c03-plugin-namespace");
    const profile = loadJson<ClaudePocInput>(path.join(dir, "profile.json"));
    const result = resolveClaudeFixture(
      { ...profile, skillOverrides: { "acme:deploy": "off" } },
      dir,
    );
    const byName = new Map(result.instances.map((inst) => [inst.logicalName, inst.status]));
    expect(byName.get("acme:deploy")).toBe("DISABLED");
    expect(byName.get("deploy")).toBe("ELIGIBLE");
    expect(result.findings.map((finding) => finding.id)).toEqual([]);
    expect(result.status).toBe("PASS");
  });

  it("bare override never touches a namespaced plugin instance", () => {
    const dir = path.join(tmpRoot, "c03-plugin-namespace");
    const profile = loadJson<ClaudePocInput>(path.join(dir, "profile.json"));
    const result = resolveClaudeFixture(
      { ...profile, skillOverrides: { deploy: "off" } },
      dir,
    );
    const byName = new Map(result.instances.map((inst) => [inst.logicalName, inst.status]));
    expect(byName.get("deploy")).toBe("DISABLED");
    expect(byName.get("acme:deploy")).toBe("ELIGIBLE");
    // Only one instance matched: no blast radius.
    expect(result.findings.map((finding) => finding.id)).toEqual([]);
  });

  it("override matching nothing is a no-op", () => {
    const dir = path.join(tmpRoot, "c01-basic");
    const profile = loadJson<ClaudePocInput>(path.join(dir, "profile.json"));
    const result = resolveClaudeFixture(
      { ...profile, skillOverrides: { "no-such-skill": "off" } },
      dir,
    );
    expect(result.status).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  it("missing required directory is UNKNOWN, never PASS", () => {
    const result = resolveClaudeFixture(
      {
        profileId: "missing-root",
        cwd: ".",
        sourceRoots: [
          {
            sourceRootId: "project",
            scope: "PROJECT",
            path: "./does-not-exist",
            required: true,
          },
        ],
      },
      path.join(tmpRoot, "c01-basic"),
    );
    expect(result.status).toBe("INCOMPLETE");
    expect(result.coverage.unknownScopes).toEqual(["PROJECT"]);
    expect(result.findings.map((finding) => finding.id)).toEqual([
      "SOURCE_NOT_ENUMERATED",
    ]);
  });
});
