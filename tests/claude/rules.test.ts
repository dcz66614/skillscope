/**
 * Claude Code rules-matrix agreement tests (P023 T008).
 *
 * The normative matrix lives in `src/adapters/claude/claude-rules.json`;
 * `src/adapters/claude/rules.ts` is the hand-written mirror the
 * adapter imports. These tests prove the two agree on the version, the
 * scope list, the settings precedence, the settings file names and the
 * disable mechanisms, so they cannot drift silently (same pattern as
 * T007's snapshot.ts vs schema file).
 */
import { describe, expect, it } from "vitest";
import {
  CLAUDE_RULES_VERSION,
  CLAUDE_SCOPES,
  DISABLE_MECHANISM_KEYS,
  loadClaudeRulesMatrix,
  SETTINGS_FILES,
  SETTINGS_PRECEDENCE,
} from "../../src/adapters/claude/rules.js";

describe("claude-rules.json agrees with rules.ts", () => {
  it("version matches", () => {
    const matrix = loadClaudeRulesMatrix();
    expect(matrix["version"]).toBe(CLAUDE_RULES_VERSION);
    expect(matrix["schema"]).toBe("skillscope.claude-rules/v1");
  });

  it("scope list matches the PoC scopes", () => {
    const matrix = loadClaudeRulesMatrix();
    expect(matrix["scopes"]).toEqual([...CLAUDE_SCOPES]);
    expect(CLAUDE_SCOPES).toEqual([
      "ENTERPRISE",
      "PERSONAL",
      "PROJECT",
      "NESTED",
      "ADD_DIR",
      "PLUGIN",
      "ACCOUNT_SYNC",
    ]);
  });

  it("settings precedence and file names match", () => {
    const matrix = loadClaudeRulesMatrix();
    expect(matrix["settings_precedence"]).toEqual([...SETTINGS_PRECEDENCE]);
    expect(SETTINGS_PRECEDENCE).toEqual(["managed", "user", "project", "local"]);
    const files = matrix["settings_files"] as Record<
      string,
      { file: string }
    >;
    for (const layer of SETTINGS_PRECEDENCE) {
      expect(files[layer]?.file).toBe(SETTINGS_FILES[layer]);
    }
    // Managed settings have no default path: the adapter must never
    // default to a machine path.
    expect(
      (files["managed"] as unknown as { default_path: string | null })
        .default_path,
    ).toBeNull();
  });

  it("disable mechanisms listed in the matrix are the ones the adapter reads", () => {
    const matrix = loadClaudeRulesMatrix();
    const mechanisms = matrix["disable_mechanisms"] as Array<{ key: string }>;
    expect(mechanisms.map((entry) => entry.key).sort()).toEqual([
      ...DISABLE_MECHANISM_KEYS,
    ].sort());
    // disabledPlugins is NOT a documented key: the adapter must not
    // invent it (ADR-010).
    expect(mechanisms.map((entry) => entry.key)).not.toContain(
      "disabledPlugins",
    );
  });

  it("the matrix records the namespace, trust and strict rules", () => {
    const matrix = loadClaudeRulesMatrix();
    expect(typeof matrix["namespace_rule"]).toBe("string");
    expect(typeof matrix["trust_rule"]).toBe("string");
    expect(typeof matrix["user_override_rule"]).toBe("string");
    expect(typeof matrix["extra_plugin_dir_conflict_rule"]).toBe("string");
    expect(Array.isArray(matrix["known_but_not_enforced"])).toBe(true);
    expect(
      (matrix["known_but_not_enforced"] as string[]).includes(
        "disableSideloadFlags (managed setting that can refuse --plugin-dir; the adapter does not enforce it yet)",
      ),
    ).toBe(true);
  });
});
