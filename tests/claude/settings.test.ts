/**
 * Claude Code settings-layer unit tests (P023 T008).
 *
 * Covers shape validation and the precedence merge (managed > user >
 * project > local) without touching the filesystem fixtures.
 */
import { describe, expect, it } from "vitest";
import {
  mergeAdditionalDirectories,
  mergeEffectiveDisables,
  mergeMarketplaces,
  validateSettingsShape,
  type ClaudeSettingsLayer,
} from "../../src/adapters/claude/settings.js";

function layer(
  name: ClaudeSettingsLayer["name"],
  settings: ClaudeSettingsLayer["settings"],
): ClaudeSettingsLayer {
  return {
    name,
    path: `/fake/${name}.json`,
    status: settings === null ? "missing" : "present",
    settings,
    errors: [],
  };
}

describe("validateSettingsShape", () => {
  it("accepts an empty document and unknown keys", () => {
    expect(validateSettingsShape({})).toEqual([]);
    expect(
      validateSettingsShape({ theme: "dark", model: "opus", env: {} }),
    ).toEqual([]);
  });

  it("accepts every adapter-relevant key in its documented shape", () => {
    expect(
      validateSettingsShape({
        enabledPlugins: { "acme@team-market": false, notes: true },
        skillOverrides: { deploy: "off", "acme:lint": "off" },
        extraKnownMarketplaces: [
          { name: "team-market", path: "./marketplace" },
          { name: "remote", source: { type: "git", url: "https://example.invalid/x.git" } },
          { name: "local", source: { type: "directory", path: "./local-market" } },
        ],
        additionalDirectories: ["./docs"],
        strictKnownMarketplaces: true,
      }),
    ).toEqual([]);
  });

  it("rejects wrong types for known keys", () => {
    expect(validateSettingsShape({ enabledPlugins: "yes" })).toEqual([
      "enabledPlugins must be an object",
    ]);
    expect(validateSettingsShape({ enabledPlugins: { acme: "off" } })).toEqual([
      'enabledPlugins["acme"] must be a boolean',
    ]);
    expect(validateSettingsShape({ skillOverrides: { deploy: "on" } })).toEqual([
      'skillOverrides["deploy"] must be "off"',
    ]);
    expect(
      validateSettingsShape({ extraKnownMarketplaces: [{ name: "" }] }),
    ).toEqual([
      "extraKnownMarketplaces entries must be objects with a non-empty name",
    ]);
    expect(
      validateSettingsShape({
        extraKnownMarketplaces: [{ name: "x", source: { type: "git" } }],
      }),
    ).toEqual([
      'extraKnownMarketplaces["x"] git source must have a non-empty url',
    ]);
    expect(
      validateSettingsShape({ additionalDirectories: ["./docs", 3] }),
    ).toEqual(["additionalDirectories must be an array of non-empty strings"]);
    expect(validateSettingsShape({ strictKnownMarketplaces: "yes" })).toEqual([
      "strictKnownMarketplaces must be a boolean",
    ]);
    expect(validateSettingsShape("nope")).toEqual([
      "settings document must be a JSON object",
    ]);
  });
});

describe("mergeEffectiveDisables (precedence managed > user > project > local)", () => {
  it("a higher layer's value wins per key; true re-enables a lower false", () => {
    const merged = mergeEffectiveDisables([
      layer("managed", { enabledPlugins: { "acme@m": true } }),
      layer("user", { enabledPlugins: { "acme@m": false, "notes@m": false } }),
      layer("project", { skillOverrides: { deploy: "off" } }),
      layer("local", { skillOverrides: { deploy: "off", lint: "off" } }),
    ]);
    expect(merged.disabledPlugins).toEqual(["notes@m"]);
    expect(merged.skillOverrides).toEqual(["deploy", "lint"]);
    // The user layer disabled notes@m and no lower layer did.
    expect(merged.overriddenByUser).toEqual(["notes@m"]);
  });

  it("a user disable that a lower layer already had is not an override", () => {
    const merged = mergeEffectiveDisables([
      layer("managed", null),
      layer("user", { skillOverrides: { deploy: "off" } }),
      layer("project", { skillOverrides: { deploy: "off" } }),
      layer("local", null),
    ]);
    expect(merged.skillOverrides).toEqual(["deploy"]);
    expect(merged.overriddenByUser).toEqual([]);
  });

  it("missing or unreadable layers contribute nothing to the merge", () => {
    const merged = mergeEffectiveDisables([
      layer("managed", null),
      {
        name: "user",
        path: "/fake/user.json",
        status: "invalid-json",
        settings: null,
        errors: ["not json"],
      },
      layer("project", { skillOverrides: { deploy: "off" } }),
      layer("local", null),
    ]);
    expect(merged.skillOverrides).toEqual(["deploy"]);
    expect(merged.overriddenByUser).toEqual([]);
  });
});

describe("mergeMarketplaces / mergeAdditionalDirectories", () => {
  it("the highest-precedence declaration wins per marketplace name", () => {
    const merged = mergeMarketplaces([
      layer("managed", {
        extraKnownMarketplaces: [{ name: "team", path: "./managed-market" }],
      }),
      layer("user", {
        extraKnownMarketplaces: [{ name: "team", path: "./user-market" }],
      }),
      layer("project", {
        extraKnownMarketplaces: [{ name: "other", path: "./other-market" }],
      }),
      layer("local", null),
    ]);
    expect(merged).toEqual([
      { name: "other", path: "./other-market" },
      { name: "team", path: "./managed-market" },
    ]);
  });

  it("additionalDirectories union across layers, sorted", () => {
    const merged = mergeAdditionalDirectories([
      layer("managed", null),
      layer("user", { additionalDirectories: ["./docs", "./shared"] }),
      layer("project", { additionalDirectories: ["./docs"] }),
      layer("local", { additionalDirectories: ["./local-docs"] }),
    ]);
    expect(merged).toEqual(["./docs", "./local-docs", "./shared"]);
  });
});
