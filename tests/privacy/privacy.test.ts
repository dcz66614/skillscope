/**
 * Privacy redaction + secret scanning tests (P023 T008b, S2).
 *
 * Covers src/privacy: sensitive-key redaction (camelCase, snake_case,
 * kebab-case, case-insensitive; "author" is NOT sensitive), secret
 * value patterns under innocent keys, absolute-path redaction (known
 * bases, unknown roots, Windows paths; URLs and relative paths kept),
 * username redaction, the PII sample fixture (every pattern found),
 * and end-to-end `redactReport` (no absolute path, no secret value,
 * input untouched).
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ABS_PATH_PLACEHOLDER,
  CWD_PLACEHOLDER,
  HOME_PLACEHOLDER,
  REDACTED,
  ROOT_PLACEHOLDER,
  USER_PLACEHOLDER,
  isSensitiveKey,
  looksLikeSecret,
  redactPathsInText,
  redactReport,
  redactValue,
  scanForSecrets,
} from "../../src/privacy/index.js";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "..", "..");
const PII_SAMPLE = JSON.parse(
  fs.readFileSync(
    path.join(REPO, "tests", "fixtures", "t008b", "pii-sample.json"),
    "utf8",
  ),
) as { samples: Array<{ field: string; value: string }> };

describe("isSensitiveKey", () => {
  it.each([
    "token",
    "accessToken",
    "access_token",
    "refreshToken",
    "apiKey",
    "api_key",
    "x-api-key",
    "clientSecret",
    "client_secret",
    "password",
    "passwd",
    "secret",
    "authorization",
    "cookie",
    "sessionId",
    "privateKey",
    "private_key",
    "Bearer",
    "credentials",
    "TOKEN",
    "ApiKey",
    "accessKey",
    "authKey",
  ])("flags %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(true);
  });

  it.each([
    "author",
    "name",
    "logicalName",
    "description",
    "status",
    "engine",
    "path",
    "relativePath",
    "monkey",
    "keyboard",
  ])("does NOT flag %s as sensitive", (key) => {
    expect(isSensitiveKey(key)).toBe(false);
  });
});

describe("redactValue: keys", () => {
  it("replaces credential values, keeps the rest", () => {
    const input = {
      apiKey: "sk-TESTTESTTESTTESTTESTTEST",
      name: "deploy",
      nested: { password: "hunter2", count: 3 },
    };
    expect(redactValue(input)).toEqual({
      apiKey: REDACTED,
      name: "deploy",
      nested: { password: REDACTED, count: 3 },
    });
    // Input untouched.
    expect(input.apiKey).toBe("sk-TESTTESTTESTTESTTESTTEST");
  });

  it("redacts inside arrays", () => {
    expect(redactValue([{ token: "abc" }, { ok: true }])).toEqual([
      { token: REDACTED },
      { ok: true },
    ]);
  });
});

describe("redactValue: secret-looking values under innocent keys", () => {
  it.each([
    ["sk-TESTTESTTESTTESTTESTTEST", "openai-key"],
    ["ghp_TESTTESTTESTTESTTESTTEST", "github-pat"],
    ["AKIAIOSFODNN7EXAMPLE", "aws-access-key"],
    ["AIzaSyTESTTESTTESTTESTTESTTESTTESTTEST1", "google-api-key"],
    ["xoxb-TESTTESTTESTTEST", "slack-token"],
    ["-----BEGIN RSA PRIVATE KEY-----", "private-key"],
  ])("redacts %s value", (value) => {
    expect(looksLikeSecret(value)).toBe(true);
    expect(redactValue({ note: value })).toEqual({ note: REDACTED });
  });

  it("redacts a JWT pasted into a free-text field", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    expect(looksLikeSecret(jwt)).toBe(true);
    expect(redactValue({ detail: `saw ${jwt} in the log` })).toEqual({
      detail: REDACTED,
    });
  });

  it("does not redact ordinary text", () => {
    expect(looksLikeSecret("deploy the release skill")).toBe(false);
    expect(redactValue({ note: "deploy the release skill" })).toEqual({
      note: "deploy the release skill",
    });
  });
});

describe("redactPathsInText", () => {
  const opts = {
    home: "/home/sam",
    cwd: "/home/sam/work/skillscope",
    roots: ["/home/sam/work/fixtures"],
  };

  it("replaces known bases with placeholders, longest first", () => {
    expect(
      redactPathsInText("/home/sam/work/skillscope/src/index.ts", opts),
    ).toBe("<CWD>/src/index.ts");
    expect(redactPathsInText("/home/sam/.agents/skills", opts)).toBe(
      "<HOME>/.agents/skills",
    );
    expect(redactPathsInText("/home/sam/work/fixtures/codex", opts)).toBe(
      "<ROOT>/codex",
    );
  });

  it("redacts unknown absolute paths under known roots", () => {
    expect(redactPathsInText("failed to read /tmp/secret.txt", opts)).toBe(
      `failed to read ${ABS_PATH_PLACEHOLDER}`,
    );
    expect(redactPathsInText("see /etc/hosts for details", opts)).toBe(
      `see ${ABS_PATH_PLACEHOLDER} for details`,
    );
  });

  it("does not mistake /home2 for the /home root", () => {
    expect(redactPathsInText("under /home2/other/x", opts)).toBe(
      "under /home2/other/x",
    );
  });

  it("redacts Windows drive and UNC paths", () => {
    expect(redactPathsInText("open C:\\Users\\sam\\skills\\x.md", opts)).toBe(
      `open ${ABS_PATH_PLACEHOLDER}`,
    );
    expect(redactPathsInText("share \\\\server\\share\\file.txt", opts)).toBe(
      `share ${ABS_PATH_PLACEHOLDER}`,
    );
  });

  it("leaves relative paths and URLs alone", () => {
    expect(redactPathsInText("see skills/deploy/SKILL.md", opts)).toBe(
      "see skills/deploy/SKILL.md",
    );
    expect(redactPathsInText("https://example.com/a/b", opts)).toBe(
      "https://example.com/a/b",
    );
    expect(redactPathsInText("ratio 5/10 passed", opts)).toBe("ratio 5/10 passed");
  });

  it("redacts supplied usernames", () => {
    expect(
      redactPathsInText("user sam ran the audit", { usernames: ["sam"] }),
    ).toBe(`user ${USER_PLACEHOLDER} ran the audit`);
  });
});

describe("scanForSecrets", () => {
  it("finds every pattern in the PII sample fixture", () => {
    for (const sample of PII_SAMPLE.samples) {
      const findings = scanForSecrets({ [sample.field]: sample.value });
      expect(findings.length).toBeGreaterThan(0);
      // Findings never carry the secret value.
      for (const finding of findings) {
        expect(JSON.stringify(finding)).not.toContain(sample.value);
        expect(finding.path).toBe(`$.${sample.field}`);
        expect(finding.length).toBeGreaterThan(0);
      }
    }
  });

  it("returns no findings for clean content", () => {
    expect(
      scanForSecrets({
        name: "deploy",
        detail: "skill loaded from REPO scope",
        count: 3,
      }),
    ).toEqual([]);
  });

  it("reports the JSON path of a nested secret (two patterns may overlap)", () => {
    const findings = scanForSecrets({
      findings: [{ detail: "token=sk-TESTTESTTESTTESTTESTTEST" }],
    });
    // "token=…" matches credential-assignment AND the sk-… value matches
    // openai-key: overlapping patterns both report, at the same path.
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.pattern).sort()).toEqual([
      "credential-assignment",
      "openai-key",
    ]);
    expect(findings.every((f) => f.path === "$.findings[0].detail")).toBe(true);
  });
});

describe("redactReport end to end", () => {
  it("a realistic report comes out shareable: no paths, no secrets", () => {
    const report = {
      schema: "skillscope.report/v1",
      profile_id: "codex-billing-repo",
      status: "INCOMPLETE",
      findings: [
        {
          id: "SOURCE_NOT_ENUMERATED",
          severity: "P1",
          source_scope: "PLUGIN",
          status: "UNKNOWN",
          detail: "could not read /home/sam/.config/xyz/config.json",
        },
      ],
      debug: { token: "sk-TESTTESTTESTTESTTESTTEST" },
    };
    const redacted = redactReport(report, {
      home: "/home/sam",
      cwd: "/home/sam/work",
      usernames: ["sam"],
    }) as Record<string, unknown>;
    const text = JSON.stringify(redacted);
    expect(text).not.toContain("/home/sam");
    expect(text).not.toContain("sk-TEST");
    expect(text).not.toContain("sam");
    expect(scanForSecrets(redacted)).toEqual([]);
    expect(text).toContain(HOME_PLACEHOLDER);
    expect(text).toContain(REDACTED);
    // Original untouched.
    expect(JSON.stringify(report)).toContain("/home/sam/.config/xyz/config.json");
  });
});
