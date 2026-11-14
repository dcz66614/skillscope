/**
 * Identity registry tests (P023 T005).
 * Covers PROJECT_BOOK §4.2 rules 1–4: name is never identity, same
 * name at different paths are two instances, symlink aliases merge,
 * same content at different paths stays two instances.
 */
import { describe, expect, it } from "vitest";
import {
  IdentityRegistry,
  canonicalPathHash,
  computeInstanceId,
  identityKey,
  toPosixPath,
  type RegistryInput,
} from "../../src/identity/identity.js";

function input(overrides: Partial<RegistryInput> & { canonicalPath: string }): RegistryInput {
  return {
    engine: "codex",
    sourceRootId: "repo",
    sourceScope: "REPO",
    relativePath: "release/SKILL.md",
    logicalName: "release",
    folderName: "release",
    contentSha256: "a".repeat(64),
    status: "ELIGIBLE",
    evidenceLevel: "STATIC_RULE",
    ...overrides,
  };
}

describe("identity primitives", () => {
  it("toPosixPath converts backslashes only", () => {
    expect(toPosixPath("a\\b/c")).toBe("a/b/c");
    expect(toPosixPath("a/b/c")).toBe("a/b/c");
  });

  it("canonicalPathHash is a stable lowercase SHA-256 hex", () => {
    const h = canonicalPathHash("/root/.agents/skills/release/SKILL.md");
    expect(h).toMatch(/^[0-9a-f]{64}$/);
    expect(canonicalPathHash("/root/.agents/skills/release/SKILL.md")).toBe(h);
    expect(canonicalPathHash("/other/path/SKILL.md")).not.toBe(h);
  });

  it("computeInstanceId is deterministic and ignores the logical name", () => {
    const a = computeInstanceId("codex", "repo", "/x/release/SKILL.md");
    const b = computeInstanceId("codex", "repo", "/x/release/SKILL.md");
    expect(a).toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
    // Different engine / root / path all change the id.
    expect(computeInstanceId("claude-code", "repo", "/x/release/SKILL.md")).not.toBe(a);
    expect(computeInstanceId("codex", "user", "/x/release/SKILL.md")).not.toBe(a);
    expect(computeInstanceId("codex", "repo", "/x/other/SKILL.md")).not.toBe(a);
  });

  it("identityKey distinguishes source roots for the same physical file", () => {
    expect(identityKey("repo", "/x/SKILL.md")).not.toBe(
      identityKey("user", "/x/SKILL.md"),
    );
    expect(identityKey("repo", "/x/SKILL.md")).toBe(
      identityKey("repo", "/x/SKILL.md"),
    );
  });

  it("identity does NOT normalise Unicode: decomposed vs precomposed names differ", () => {
    // Two on-disk directories that differ only by Unicode normal form
    // are two distinct physical files on Linux and must stay two
    // instances; NFC belongs to the canonical JSON text layer, not here.
    const decomposed = "/root/cafe\u0301/SKILL.md";
    const precomposed = "/root/caf\u00e9/SKILL.md";
    expect(decomposed.normalize("NFC")).toBe(precomposed.normalize("NFC"));
    expect(identityKey("repo", decomposed)).not.toBe(
      identityKey("repo", precomposed),
    );
    expect(computeInstanceId("codex", "repo", decomposed)).not.toBe(
      computeInstanceId("codex", "repo", precomposed),
    );
  });
});

describe("IdentityRegistry", () => {
  it("registers one instance per (sourceRootId, canonicalPath)", () => {
    const reg = new IdentityRegistry();
    const first = reg.register(input({ canonicalPath: "/r/release/SKILL.md" }));
    expect(reg.size).toBe(1);
    expect(first.instanceId).toBe(
      computeInstanceId("codex", "repo", "/r/release/SKILL.md"),
    );
    expect(first.canonicalPathHash).toBe(
      canonicalPathHash("/r/release/SKILL.md"),
    );
    expect(first.aliases).toEqual([]);
    expect(reg.get(first.instanceId)).toBe(first);
  });

  it("merges a second access path to the same file as an alias", () => {
    const reg = new IdentityRegistry();
    const first = reg.register(
      input({ canonicalPath: "/r/release/SKILL.md", relativePath: "release/SKILL.md" }),
    );
    const second = reg.register(
      input({
        canonicalPath: "/r/release/SKILL.md",
        relativePath: "link/SKILL.md",
        folderName: "link",
      }),
    );
    expect(second).toBe(first);
    expect(reg.size).toBe(1);
    expect(first.aliases).toEqual(["link/SKILL.md"]);
    // Primary path stays the first-registered one.
    expect(first.relativePath).toBe("release/SKILL.md");
    // Re-registering the same access path adds no duplicate alias.
    reg.register(
      input({ canonicalPath: "/r/release/SKILL.md", relativePath: "link/SKILL.md" }),
    );
    expect(first.aliases).toEqual(["link/SKILL.md"]);
  });

  it("same logical name at different paths are two instances (rule 2)", () => {
    const reg = new IdentityRegistry();
    const a = reg.register(
      input({
        canonicalPath: "/r/deploy/SKILL.md",
        relativePath: "deploy/SKILL.md",
        logicalName: "deploy",
        folderName: "deploy",
      }),
    );
    const b = reg.register(
      input({
        canonicalPath: "/u/deploy/SKILL.md",
        relativePath: "deploy/SKILL.md",
        sourceRootId: "user",
        sourceScope: "USER",
        logicalName: "deploy",
        folderName: "deploy",
        contentSha256: "b".repeat(64),
      }),
    );
    expect(reg.size).toBe(2);
    expect(a.instanceId).not.toBe(b.instanceId);
    const collisions = reg.sameNameCollisions();
    expect(collisions).toHaveLength(1);
    expect(collisions[0]?.logicalName).toBe("deploy");
    expect(collisions[0]?.instanceIds).toEqual(
      [a.instanceId, b.instanceId].sort(),
    );
  });

  it("same content at different paths stays two instances + DUPLICATE_CONTENT (rule 4)", () => {
    const reg = new IdentityRegistry();
    const a = reg.register(
      input({
        canonicalPath: "/r/copy-a/SKILL.md",
        relativePath: "copy-a/SKILL.md",
        logicalName: "copy-a",
        folderName: "copy-a",
        contentSha256: "c".repeat(64),
      }),
    );
    const b = reg.register(
      input({
        canonicalPath: "/r/copy-b/SKILL.md",
        relativePath: "copy-b/SKILL.md",
        logicalName: "copy-b",
        folderName: "copy-b",
        contentSha256: "c".repeat(64),
      }),
    );
    expect(reg.size).toBe(2);
    const groups = reg.duplicateContentGroups();
    expect(groups).toHaveLength(1);
    expect(groups[0]?.contentSha256).toBe("c".repeat(64));
    expect(groups[0]?.instanceIds).toEqual([a.instanceId, b.instanceId].sort());
    // And the content hash alone is not an identity: different names,
    // same bytes, still two instances.
    expect(a.instanceId).not.toBe(b.instanceId);
  });

  it("no collisions or duplicate groups on a clean registry", () => {
    const reg = new IdentityRegistry();
    reg.register(input({ canonicalPath: "/r/a/SKILL.md", relativePath: "a/SKILL.md", logicalName: "a", folderName: "a" }));
    reg.register(
      input({
        canonicalPath: "/r/b/SKILL.md",
        relativePath: "b/SKILL.md",
        logicalName: "b",
        folderName: "b",
        contentSha256: "d".repeat(64),
      }),
    );
    expect(reg.sameNameCollisions()).toEqual([]);
    expect(reg.duplicateContentGroups()).toEqual([]);
  });

  it("instances() is sorted by (sourceRootId, relativePath, logicalName)", () => {
    const reg = new IdentityRegistry();
    reg.register(input({ canonicalPath: "/r/z/SKILL.md", relativePath: "z/SKILL.md", logicalName: "z", folderName: "z" }));
    reg.register(input({ canonicalPath: "/r/a/SKILL.md", relativePath: "a/SKILL.md", logicalName: "a", folderName: "a", contentSha256: "e".repeat(64) }));
    reg.register(
      input({
        canonicalPath: "/u/m/SKILL.md",
        relativePath: "m/SKILL.md",
        logicalName: "m",
        folderName: "m",
        sourceRootId: "user",
        sourceScope: "USER",
        contentSha256: "f".repeat(64),
      }),
    );
    expect(reg.instances().map((i) => i.relativePath)).toEqual([
      "a/SKILL.md",
      "z/SKILL.md",
      "m/SKILL.md",
    ]);
    expect(reg.instances().map((i) => i.sourceRootId)).toEqual([
      "repo",
      "repo",
      "user",
    ]);
  });

  it("same file under two source roots is two instances (and a duplicate-content pair)", () => {
    const reg = new IdentityRegistry();
    reg.register(input({ canonicalPath: "/shared/SKILL.md", relativePath: "shared/SKILL.md" }));
    reg.register(
      input({
        canonicalPath: "/shared/SKILL.md",
        relativePath: "shared/SKILL.md",
        sourceRootId: "user",
        sourceScope: "USER",
      }),
    );
    expect(reg.size).toBe(2);
    expect(reg.duplicateContentGroups()).toHaveLength(1);
    expect(reg.sameNameCollisions()).toHaveLength(1);
  });
});
