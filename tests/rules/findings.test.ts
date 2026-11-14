/**
 * Finding taxonomy tests (P023 T006, S1).
 *
 * Covers src/findings: the frozen PROJECT_BOOK §5.2 catalog (11 ids,
 * severities), normalisation (severity from the catalog, status default,
 * instance-id sorting/dedup), dedup/sort determinism, and the
 * INCOMPLETE > FAIL > PASS status derivation.
 */
import { describe, expect, it } from "vitest";
import {
  FINDING_CATALOG,
  FINDING_IDS,
  dedupeFindings,
  deriveAuditStatus,
  isBlockingFinding,
  normalizeFinding,
  sortFindings,
  type FindingV1,
} from "../../src/findings/index.js";

describe("finding catalog (PROJECT_BOOK §5.2)", () => {
  it("contains exactly the 11 frozen finding ids", () => {
    expect([...FINDING_IDS].sort()).toEqual(
      [
        "DISABLE_MISMATCH",
        "DUPLICATE_CONTENT",
        "FAIL_OPEN_CONFIG",
        "IMPORT_ORIGINAL_PATH_STILL_ACTIVE",
        "INVALID_MANIFEST",
        "NAME_SELECTOR_BLAST_RADIUS",
        "SAME_NAME_COLLISION",
        "SCOPE_LEAK",
        "SOURCE_NOT_ENUMERATED",
        "SYMLINK_ALIAS",
        "SYMLINK_OUTSIDE_ROOT",
      ].sort(),
    );
  });

  it("severities match the §5.2 table", () => {
    expect(FINDING_CATALOG["SCOPE_LEAK"].severity).toBe("P1");
    expect(FINDING_CATALOG["DISABLE_MISMATCH"].severity).toBe("P1");
    expect(FINDING_CATALOG["NAME_SELECTOR_BLAST_RADIUS"].severity).toBe("P1");
    expect(FINDING_CATALOG["FAIL_OPEN_CONFIG"].severity).toBe("P1");
    expect(FINDING_CATALOG["SOURCE_NOT_ENUMERATED"].severity).toBe("P1");
    expect(FINDING_CATALOG["IMPORT_ORIGINAL_PATH_STILL_ACTIVE"].severity).toBe("P1");
    expect(FINDING_CATALOG["SYMLINK_OUTSIDE_ROOT"].severity).toBe("P1");
    expect(FINDING_CATALOG["SAME_NAME_COLLISION"].severity).toBe("P2");
    expect(FINDING_CATALOG["SYMLINK_ALIAS"].severity).toBe("P2");
    expect(FINDING_CATALOG["INVALID_MANIFEST"].severity).toBe("P2");
    expect(FINDING_CATALOG["DUPLICATE_CONTENT"].severity).toBe("P2");
  });
});

describe("normalizeFinding", () => {
  it("takes severity from the catalog, never from the caller", () => {
    const finding = normalizeFinding({
      id: "SAME_NAME_COLLISION",
      severity: "P1", // wrong on purpose: the catalog says P2
      sourceScope: "PROJECT",
      detail: "two instances share the name 'deploy'",
      instanceIds: ["project:deploy/SKILL.md"],
    });
    expect(finding.severity).toBe("P2");
  });

  it("defaults status to CONFIRMED, except SOURCE_NOT_ENUMERATED → UNKNOWN", () => {
    expect(
      normalizeFinding({
        id: "SCOPE_LEAK",
        sourceScope: "NESTED",
        detail: "leak",
      }).status,
    ).toBe("CONFIRMED");
    expect(
      normalizeFinding({
        id: "SOURCE_NOT_ENUMERATED",
        sourceScope: "USER",
        detail: "user source not enumerated",
      }).status,
    ).toBe("UNKNOWN");
  });

  it("keeps an explicit status (Codex PoC findings carry one)", () => {
    expect(
      normalizeFinding({
        id: "FAIL_OPEN_CONFIG",
        sourceScope: "SYSTEM",
        status: "CONFIRMED",
        detail: "config unreadable",
      }).status,
    ).toBe("CONFIRMED");
    expect(
      normalizeFinding({
        id: "SOURCE_NOT_ENUMERATED",
        sourceScope: "PLUGIN",
        status: "UNKNOWN",
        detail: "plugin inventory missing",
      }).status,
    ).toBe("UNKNOWN");
  });

  it("sorts and deduplicates instanceIds", () => {
    const finding = normalizeFinding({
      id: "SAME_NAME_COLLISION",
      sourceScope: "PROJECT",
      detail: "collision",
      instanceIds: ["b:x/SKILL.md", "a:y/SKILL.md", "b:x/SKILL.md"],
    });
    expect(finding.instanceIds).toEqual(["a:y/SKILL.md", "b:x/SKILL.md"]);
  });

  it("preserves affectedCount when present, omits it otherwise", () => {
    const withCount = normalizeFinding({
      id: "NAME_SELECTOR_BLAST_RADIUS",
      sourceScope: "USER",
      detail: "blast",
      affectedCount: 3,
    });
    expect(withCount.affectedCount).toBe(3);
    const withoutCount = normalizeFinding({
      id: "NAME_SELECTOR_BLAST_RADIUS",
      sourceScope: "USER",
      detail: "blast",
    });
    expect(withoutCount.affectedCount).toBeUndefined();
  });

  it("throws on an unknown finding id", () => {
    expect(() =>
      normalizeFinding({
        id: "SOMETHING_NEW",
        sourceScope: "PROJECT",
        detail: "not in the taxonomy",
      }),
    ).toThrow(/unknown finding id/);
  });

  it("throws on an empty detail", () => {
    expect(() =>
      normalizeFinding({
        id: "SCOPE_LEAK",
        sourceScope: "PROJECT",
        detail: "",
      }),
    ).toThrow(/non-empty detail/);
  });
});

describe("dedupeFindings / sortFindings", () => {
  const mk = (over: Partial<FindingV1>): FindingV1 => ({
    id: "SCOPE_LEAK",
    severity: "P1",
    sourceScope: "NESTED",
    status: "CONFIRMED",
    detail: "leak",
    instanceIds: [],
    ...over,
  });

  it("collapses byte-identical findings and keeps distinct ones", () => {
    const a = mk({ detail: "leak one" });
    const b = mk({ detail: "leak one" });
    const c = mk({ detail: "leak two" });
    expect(dedupeFindings([a, b, c])).toHaveLength(2);
  });

  it("does not collapse findings that differ only in instanceIds", () => {
    const a = mk({ detail: "leak", instanceIds: ["p:a/SKILL.md"] });
    const b = mk({ detail: "leak", instanceIds: ["p:b/SKILL.md"] });
    expect(dedupeFindings([a, b])).toHaveLength(2);
  });

  it("sorts deterministically by (id, sourceScope, detail)", () => {
    const findings = [
      mk({ id: "SCOPE_LEAK", detail: "z" }),
      mk({ id: "FAIL_OPEN_CONFIG", detail: "a" }),
      mk({ id: "SCOPE_LEAK", detail: "a" }),
    ];
    expect(sortFindings(findings).map((f) => `${f.id}:${f.detail}`)).toEqual([
      "FAIL_OPEN_CONFIG:a",
      "SCOPE_LEAK:a",
      "SCOPE_LEAK:z",
    ]);
  });
});

describe("deriveAuditStatus (INCOMPLETE > FAIL > PASS)", () => {
  const p1 = (id: "SCOPE_LEAK" | "FAIL_OPEN_CONFIG" = "SCOPE_LEAK"): FindingV1 => ({
    id,
    severity: "P1",
    sourceScope: "PROJECT",
    status: "CONFIRMED",
    detail: "blocking",
    instanceIds: [],
  });
  const p2: FindingV1 = {
    id: "SAME_NAME_COLLISION",
    severity: "P2",
    sourceScope: "PROJECT",
    status: "CONFIRMED",
    detail: "collision only",
    instanceIds: [],
  };
  const unknownFinding: FindingV1 = {
    id: "SOURCE_NOT_ENUMERATED",
    severity: "P1",
    sourceScope: "USER",
    status: "UNKNOWN",
    detail: "user source unknown",
    instanceIds: [],
  };

  it("PASS when there are no findings and nothing unknown", () => {
    expect(deriveAuditStatus([], [])).toBe("PASS");
  });

  it("PASS when only P2 findings stand", () => {
    expect(deriveAuditStatus([p2], [])).toBe("PASS");
  });

  it("FAIL when a CONFIRMED P1 finding stands", () => {
    expect(deriveAuditStatus([p1(), p2], [])).toBe("FAIL");
  });

  it("INCOMPLETE when a scope is unenumerated, even with a P1 present", () => {
    expect(deriveAuditStatus([p1()], ["USER"])).toBe("INCOMPLETE");
  });

  it("INCOMPLETE when any finding has status UNKNOWN", () => {
    expect(deriveAuditStatus([unknownFinding], [])).toBe("INCOMPLETE");
  });

  it("INCOMPLETE beats FAIL: unknown finding plus P1 still INCOMPLETE", () => {
    expect(deriveAuditStatus([unknownFinding, p1()], [])).toBe("INCOMPLETE");
  });

  it("isBlockingFinding is true only for CONFIRMED P1", () => {
    expect(isBlockingFinding(p1())).toBe(true);
    expect(isBlockingFinding(p2)).toBe(false);
    expect(isBlockingFinding(unknownFinding)).toBe(false);
  });
});
