/**
 * OpenMausBot PoC fixture + unit tests (T003).
 *
 * Each fixture in tests/fixtures/s0/openmausbot/<id>/ holds a profile.json
 * (adapter input, paths relative to the fixture dir) and an expected.json
 * hand-derived from PROJECT_BOOK §4.5 and Issue #5449 fault modes. The
 * test asserts the adapter reproduces the expected instances, findings,
 * coverage, status and flags.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  resolveOpenMausBotFixture,
  type OpenMausBotPocInput,
  type OpenMausBotPocResult,
} from "../../src/adapters/openmausbot/openmausbot-poc.js";

const OMB_FIXTURES = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "../fixtures/s0/openmausbot",
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
  flags?: {
    claudeUserSkills: boolean;
    skillsLibrary: boolean;
    configSource: string;
  };
}

function loadJson<T>(filePath: string): T {
  return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
}

function normalizeInstances(result: OpenMausBotPocResult): string[] {
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
  const dir = path.join(OMB_FIXTURES, fixtureId);
  const profile = loadJson<OpenMausBotPocInput>(path.join(dir, "profile.json"));
  const expected = loadJson<Expected>(path.join(dir, "expected.json"));
  const result = resolveOpenMausBotFixture(profile, dir);
  expect(normalizeInstances(result)).toEqual(normalizeExpected(expected));
  expect(result.findings.map((finding) => finding.id).sort()).toEqual(
    [...expected.findings].sort(),
  );
  expect(result.status).toBe(expected.status);
  expect(result.coverage).toEqual(expected.coverage);
  if (expected.flags !== undefined) {
    expect(result.flags).toEqual(expected.flags);
  }
}

describe("openmausbot PoC fixtures", () => {
  for (const fixtureId of [
    "o01-optout",
    "o02-user-skills-on",
    "o03-no-config-defaults",
    "o04-imported-clean",
    "o05-optout-corrupt",
    "o06-imported-original-active",
    "o07-native-name-blast",
    "o08-plugin-no-switch",
    "o09-library-off-discovered",
    "o10-disabled-plugin-ids",
    "o11-optout-empty-list",
    "o12-user-skills-off-discovered",
    "o13-unknown-snapshot-version",
    "o14-missing-snapshot-skill-dir",
    "o15-invalid-config-json",
    "o16-shared-library-scope-leak",
  ]) {
    it(`${fixtureId} matches its hand-derived expected result`, () => {
      checkFixture(fixtureId);
    });
  }
});

describe("openmausbot PoC rules (unit)", () => {
  function baseInput(fixtureId: string): OpenMausBotPocInput {
    const dir = path.join(OMB_FIXTURES, fixtureId);
    return loadJson<OpenMausBotPocInput>(path.join(dir, "profile.json"));
  }

  it("invalid config.json is INCOMPLETE with a fail-open finding", () => {
    const dir = path.join(OMB_FIXTURES, "o01-optout");
    const dataDir = path.join(dir, "data-invalid-config");
    fs.mkdirSync(dataDir, { recursive: true });
    fs.writeFileSync(path.join(dataDir, "config.json"), "{not json\n");
    try {
      const input = baseInput("o01-optout");
      const result = resolveOpenMausBotFixture(
        { ...input, dataDir: "./data-invalid-config" },
        dir,
      );
      expect(result.status).toBe("INCOMPLETE");
      expect(result.flags.configSource).toBe("invalid");
      expect(result.coverage.unknownScopes).toContain("CONFIG");
      expect(result.findings.map((finding) => finding.id)).toContain(
        "FAIL_OPEN_CONFIG",
      );
    } finally {
      fs.rmSync(dataDir, { recursive: true, force: true });
    }
  });

  it("unknown snapshot version is INCOMPLETE and untrusted", () => {
    const input = baseInput("o01-optout");
    const dir = path.join(OMB_FIXTURES, "o01-optout");
    const result = resolveOpenMausBotFixture(
      {
        ...input,
        snapshot: { ...input.snapshot, version: "openmausbot-snapshot/v99" },
      },
      dir,
    );
    expect(result.status).toBe("INCOMPLETE");
    expect(result.instances).toEqual([]);
    expect(result.coverage.unknownScopes).toContain("SNAPSHOT");
    expect(result.findings.map((finding) => finding.id)).toContain(
      "SOURCE_NOT_ENUMERATED",
    );
  });

  it("disabledPluginIds switches the plugin skill off", () => {
    const input = baseInput("o08-plugin-no-switch");
    const dir = path.join(OMB_FIXTURES, "o08-plugin-no-switch");
    const result = resolveOpenMausBotFixture(
      {
        ...input,
        snapshot: {
          ...input.snapshot,
          disabledPluginIds: ["openai-curated-remote"],
        },
        policy: undefined,
      },
      dir,
    );
    const plugin = result.instances.find(
      (inst) => inst.logicalName === "openai-curated-remote:sites",
    );
    expect(plugin?.status).toBe("DISABLED");
    expect(result.status).toBe("PASS");
    expect(result.findings).toEqual([]);
  });

  it("snapshot skill pointing at a missing directory is unenumerated", () => {
    const input = baseInput("o01-optout");
    const dir = path.join(OMB_FIXTURES, "o01-optout");
    const result = resolveOpenMausBotFixture(
      {
        ...input,
        snapshot: {
          ...input.snapshot,
          skills: [
            {
              name: "ghost",
              kind: "assigned",
              path: "./assigned/does-not-exist",
            },
          ],
        },
      },
      dir,
    );
    expect(result.status).toBe("INCOMPLETE");
    expect(result.coverage.unknownScopes).toContain("BOT_ASSIGNED");
    expect(result.findings.map((finding) => finding.id)).toContain(
      "SOURCE_NOT_ENUMERATED",
    );
  });

  it("opt-out file missing while library is on means no opt-outs", () => {
    // o05 has library on and a corrupt opt-out; remove the file in a
    // scratch copy of the data dir and re-resolve.
    const dir = path.join(OMB_FIXTURES, "o05-optout-corrupt");
    const scratch = path.join(dir, "data-no-optout");
    fs.mkdirSync(path.join(scratch, "skill-state/bot-1"), { recursive: true });
    fs.writeFileSync(
      path.join(scratch, "config.json"),
      // FIX-R1: flags live under "features" (docs/feature-flags.md).
      JSON.stringify({
        features: { claudeUserSkills: false, skillsLibrary: true },
      }),
    );
    try {
      const input = baseInput("o05-optout-corrupt");
      const result = resolveOpenMausBotFixture(
        { ...input, dataDir: "./data-no-optout" },
        dir,
      );
      expect(result.status).toBe("PASS");
      const library = result.instances.find(
        (inst) => inst.logicalName === "every-docs",
      );
      expect(library?.status).toBe("ELIGIBLE");
    } finally {
      fs.rmSync(scratch, { recursive: true, force: true });
    }
  });
});
