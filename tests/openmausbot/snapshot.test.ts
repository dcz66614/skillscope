/**
 * Snapshot contract tests (P023 T007).
 *
 * The validator in src/adapters/openmausbot/snapshot.ts enforces the
 * same rules the normative schema file
 * (openmausbot-snapshot-v1.json) documents, without a JSON-Schema
 * dependency. These tests pin the validator's behaviour and assert
 * the two agree on required / optional / enum lists, so they cannot
 * drift silently.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  loadSnapshotFile,
  OPENMAUSBOT_SNAPSHOT_SCHEMA_ID,
  SNAPSHOT_SKILL_KINDS,
  toPocSnapshot,
  validateSnapshotShape,
  type OpenMausBotSnapshotV1,
} from "../../src/adapters/openmausbot/snapshot.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.resolve(
  HERE,
  "../../src/adapters/openmausbot/openmausbot-snapshot-v1.json",
);
const A14 = path.resolve(HERE, "../fixtures/t007/openmausbot/a14-snapshot-file");

function validSnapshot(): Record<string, unknown> {
  return {
    version: "openmausbot-snapshot/v1",
    loadableRoots: [],
    disabledPluginIds: ["openai-curated-remote"],
    emptyLists: ["native"],
    skills: [
      {
        kind: "assigned",
        name: "release",
        path: "./assigned/release",
      },
      {
        kind: "plugin",
        name: "sites",
        path: "./plugin/sites",
        pluginId: "openai-curated-remote",
      },
    ],
  };
}

describe("validateSnapshotShape", () => {
  it("accepts a well-formed v1 snapshot", () => {
    expect(validateSnapshotShape(validSnapshot())).toEqual([]);
  });

  it("does NOT treat an unknown version as a shape error (the PoC version gate owns it)", () => {
    const doc = validSnapshot();
    doc["version"] = "openmausbot-snapshot/v99";
    expect(validateSnapshotShape(doc)).toEqual([]);
  });

  it("rejects a non-object document", () => {
    expect(validateSnapshotShape("nope")).toEqual(["snapshot must be an object"]);
    expect(validateSnapshotShape(null)).toEqual(["snapshot must be an object"]);
  });

  it("rejects a missing skills array", () => {
    const doc = validSnapshot();
    delete doc["skills"];
    expect(validateSnapshotShape(doc)).toContain("skills must be an array");
  });

  it("rejects an unknown skill kind", () => {
    const doc = validSnapshot();
    (doc["skills"] as Array<Record<string, unknown>>)[0]!["kind"] = "sidecar";
    const errors = validateSnapshotShape(doc);
    expect(errors.some((error) => error.includes("kind must be one of"))).toBe(true);
  });

  it("rejects a skill without a path", () => {
    const doc = validSnapshot();
    delete (doc["skills"] as Array<Record<string, unknown>>)[0]!["path"];
    expect(validateSnapshotShape(doc)).toContain(
      "skills[0].path must be a non-empty string",
    );
  });

  it("rejects an invalid importState", () => {
    const doc = validSnapshot();
    (doc["skills"] as Array<Record<string, unknown>>)[0]!["importState"] = "half";
    expect(validateSnapshotShape(doc)).toContain(
      'skills[0].importState must be "active" or "closed"',
    );
  });

  it("rejects unknown top-level and skill fields (fail closed on extensions)", () => {
    const doc = validSnapshot();
    doc["futureField"] = true;
    expect(validateSnapshotShape(doc)).toContain(
      'unknown snapshot field: "futureField"',
    );
    const doc2 = validSnapshot();
    (doc2["skills"] as Array<Record<string, unknown>>)[0]!["surprise"] = 1;
    expect(validateSnapshotShape(doc2)).toContain(
      'unknown field in skills[0]: "surprise"',
    );
  });

  it("rejects a non-array disabledPluginIds and a bad emptyLists entry", () => {
    const doc = validSnapshot();
    doc["disabledPluginIds"] = "openai-curated-remote";
    expect(validateSnapshotShape(doc)).toContain(
      "disabledPluginIds must be an array of strings",
    );
    const doc2 = validSnapshot();
    doc2["emptyLists"] = ["plugin", "sidecar"];
    expect(
      validateSnapshotShape(doc2).some((error) =>
        error.includes("emptyLists entries must be one of"),
      ),
    ).toBe(true);
  });

  it("rejects a missing loadableRoots", () => {
    const doc = validSnapshot();
    delete doc["loadableRoots"];
    expect(validateSnapshotShape(doc)).toContain(
      "loadableRoots must be an array of strings",
    );
  });
});

describe("loadSnapshotFile", () => {
  it("loads a valid snapshot file", () => {
    const loaded = loadSnapshotFile(path.join(A14, "snapshot.json"));
    expect(loaded.ok).toBe(true);
    if (loaded.ok) {
      expect(loaded.snapshot.version).toBe("openmausbot-snapshot/v1");
      expect(loaded.snapshot.skills).toHaveLength(2);
    }
  });

  it("reports a missing file as missing", () => {
    const loaded = loadSnapshotFile(path.join(A14, "does-not-exist.json"));
    expect(loaded).toEqual({
      ok: false,
      reason: "missing",
      errors: ["snapshot file is missing or unreadable"],
    });
  });

  it("reports invalid JSON as invalid-json", () => {
    const loaded = loadSnapshotFile(path.join(A14, "snapshot-bad.json"));
    expect(loaded.ok).toBe(false);
    if (!loaded.ok) {
      expect(loaded.reason).toBe("invalid-json");
    }
  });

  it("reports a shape violation as invalid-shape", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "t007-snapshot-"));
    try {
      const file = path.join(dir, "snapshot.json");
      fs.writeFileSync(
        file,
        JSON.stringify({ version: "openmausbot-snapshot/v1", skills: "nope" }),
      );
      const loaded = loadSnapshotFile(file);
      expect(loaded.ok).toBe(false);
      if (!loaded.ok) {
        expect(loaded.reason).toBe("invalid-shape");
        expect(loaded.errors).toContain("skills must be an array");
      }
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("schema file agreement", () => {
  it("the normative schema requires version/skills/loadableRoots and pins the version", () => {
    const schema = JSON.parse(
      fs.readFileSync(SCHEMA_PATH, "utf8"),
    ) as Record<string, unknown>;
    expect(schema["$id"]).toBe(OPENMAUSBOT_SNAPSHOT_SCHEMA_ID);
    expect(schema["required"]).toEqual(["version", "skills", "loadableRoots"]);
    const props = schema["properties"] as Record<string, Record<string, unknown>>;
    expect(props["version"]?.["const"]).toBe("openmausbot-snapshot/v1");
    const skillProps = (
      props["skills"] as Record<string, Record<string, unknown>>
    )["items"] as Record<string, unknown>;
    const skillPropMap = skillProps["properties"] as Record<
      string,
      Record<string, unknown>
    >;
    const kindEnum = (skillPropMap["kind"] as Record<string, unknown>)[
      "enum"
    ] as string[];
    expect([...kindEnum].sort()).toEqual([...SNAPSHOT_SKILL_KINDS].sort());
  });

  it("the schema's example document passes shape validation", () => {
    const schema = JSON.parse(
      fs.readFileSync(SCHEMA_PATH, "utf8"),
    ) as Record<string, unknown>;
    const examples = schema["examples"] as unknown[];
    expect(examples.length).toBeGreaterThan(0);
    for (const example of examples) {
      expect(validateSnapshotShape(example)).toEqual([]);
    }
  });
});

describe("toPocSnapshot", () => {
  it("strips emptyLists and copies the rest", () => {
    const doc = validSnapshot() as unknown as OpenMausBotSnapshotV1;
    const poc = toPocSnapshot(doc);
    expect("emptyLists" in poc).toBe(false);
    expect(poc.version).toBe("openmausbot-snapshot/v1");
    expect(poc.skills).toHaveLength(2);
    expect(poc.disabledPluginIds).toEqual(["openai-curated-remote"]);
  });
});
