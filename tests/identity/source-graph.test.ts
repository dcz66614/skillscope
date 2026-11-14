/**
 * Source graph tests (P023 T005).
 * Verifies node/edge construction, determinism, and the absence of
 * absolute paths from the exported graph (PROJECT_BOOK §4.2 rule 5).
 */
import { describe, expect, it } from "vitest";
import { IdentityRegistry } from "../../src/identity/identity.js";
import { buildSourceGraph } from "../../src/identity/source-graph.js";

function registryWithTwo(): IdentityRegistry {
  const reg = new IdentityRegistry();
  reg.register({
    engine: "codex",
    sourceRootId: "repo",
    sourceScope: "REPO",
    relativePath: "a/SKILL.md",
    canonicalPath: "/r/a/SKILL.md",
    logicalName: "dup",
    folderName: "a",
    contentSha256: "c".repeat(64),
    status: "ELIGIBLE",
    evidenceLevel: "STATIC_RULE",
  });
  reg.register({
    engine: "codex",
    sourceRootId: "repo",
    sourceScope: "REPO",
    relativePath: "b/SKILL.md",
    canonicalPath: "/r/b/SKILL.md",
    logicalName: "dup",
    folderName: "b",
    contentSha256: "c".repeat(64),
    status: "ELIGIBLE",
    evidenceLevel: "STATIC_RULE",
  });
  // Same physical file reached via a second access path.
  reg.register({
    engine: "codex",
    sourceRootId: "repo",
    sourceScope: "REPO",
    relativePath: "alias/SKILL.md",
    canonicalPath: "/r/a/SKILL.md",
    logicalName: "dup",
    folderName: "alias",
    contentSha256: "c".repeat(64),
    status: "ELIGIBLE",
    evidenceLevel: "STATIC_RULE",
  });
  return reg;
}

describe("buildSourceGraph", () => {
  it("builds roots, instances, CONTAINS/ALIAS/SAME_NAME/DUPLICATE_CONTENT edges", () => {
    const reg = registryWithTwo();
    const graph = buildSourceGraph(
      [{ sourceRootId: "repo", engine: "codex", sourceScope: "REPO" }],
      reg,
    );
    expect(graph.schema).toBe("skillscope.source-graph/v1");
    expect(graph.roots).toEqual([
      { sourceRootId: "repo", engine: "codex", sourceScope: "REPO" },
    ]);
    expect(graph.nodes.filter((n) => n.kind === "instance")).toHaveLength(2);
    expect(graph.nodes.filter((n) => n.kind === "root")).toHaveLength(1);
    const kinds = graph.edges.map((e) => e.kind).sort();
    expect(kinds).toEqual([
      "ALIAS",
      "CONTAINS",
      "CONTAINS",
      "DUPLICATE_CONTENT",
      "SAME_NAME",
    ]);
    const alias = graph.edges.find((e) => e.kind === "ALIAS");
    expect(alias?.path).toBe("alias/SKILL.md");
  });

  it("is deterministic and contains no absolute paths", () => {
    const reg = registryWithTwo();
    const roots = [{ sourceRootId: "repo", engine: "codex", sourceScope: "REPO" }];
    const first = JSON.stringify(buildSourceGraph(roots, reg));
    const second = JSON.stringify(buildSourceGraph(roots, reg));
    expect(second).toBe(first);
    expect(first).not.toContain("/r/");
    expect(first).not.toContain("/home");
  });

  it("is empty (roots only) for an empty registry", () => {
    const graph = buildSourceGraph([], new IdentityRegistry());
    expect(graph.nodes).toEqual([]);
    expect(graph.edges).toEqual([]);
  });
});
