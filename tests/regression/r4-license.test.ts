/**
 * R3 FIX regression suite (P023 FIX-R3-LICENSE).
 *
 * One test per R3 final-review license finding:
 *
 * - P1-R3-01 (dist.zip ships no MIT LICENSE, README still claims
 *   the license is pending, package.json has no license field):
 *   the repo-root LICENSE is byte-identical to the canonical MIT
 *   text (sha256 50b8b302…, the same LICENSE P021 ships), the
 *   README License section states MIT with no "Pending Sam" claim,
 *   package.json claims "license": "MIT", and the release
 *   packaging itself (scripts/release-build.mjs collectDistEntries,
 *   the function that builds dist.zip) includes the LICENSE entry
 *   with the canonical hash. The release-build / release-verify
 *   gates that enforce this on every freeze are exercised by the
 *   full release:build + release:verify run, not here.
 * - P2-R3-01 (dist.zip README links docs/quickstart.md,
 *   docs/host-rules.md, docs/images/scope-matrix.png, but dist.zip
 *   has no docs/ directory): collectDistEntries now ships the
 *   docs/ directory, so every linked file is present in dist.zip.
 */
import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, expect, it } from "vitest";
import { collectDistEntries, EXPECTED_LICENSE_SHA256 } from "../../scripts/release-build.mjs";

const REPO_ROOT = path.resolve(__dirname, "../..");

function sha256Hex(buf: Buffer): string {
  return crypto.createHash("sha256").update(buf).digest("hex");
}

describe("FIX-R3-LICENSE: P1-R3-01 dist.zip carries the MIT LICENSE", () => {
  it("repo-root LICENSE is the canonical MIT text (sha256 50b8b302…)", () => {
    const license = fs.readFileSync(path.join(REPO_ROOT, "LICENSE"));
    expect(license.length).toBe(1065);
    expect(sha256Hex(license)).toBe(EXPECTED_LICENSE_SHA256);
    expect(sha256Hex(license)).toBe(
      "50b8b302ffcb53aec1866ad4b94721c200400e6aac8cee12db03b85f24e39ed2",
    );
    expect(license.toString("utf8")).toContain("Copyright (c) 2026 dcz66614");
  });

  it('package.json claims "license": "MIT"', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"));
    expect(pkg.license).toBe("MIT");
  });

  it('README License section states MIT and carries no "Pending Sam" claim', () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    expect(readme).toMatch(/^## License\n\nMIT/m);
    expect(readme).not.toContain("Pending Sam");
    expect(readme).not.toContain("no LICENSE file is included yet");
    expect(readme).not.toContain("no license is claimed in `package.json`");
  });

  it("collectDistEntries includes LICENSE with the canonical content hash", () => {
    const entries: Array<{ path: string; data: Buffer }> = collectDistEntries();
    const license = entries.find((e) => e.path === "LICENSE");
    expect(license).toBeDefined();
    expect(sha256Hex(license!.data)).toBe(EXPECTED_LICENSE_SHA256);
    const pkg = JSON.parse(entries.find((e) => e.path === "package.json")!.data.toString("utf8"));
    expect(pkg.license).toBe("MIT");
    const readme = entries.find((e) => e.path === "README.md")!.data.toString("utf8");
    expect(readme).toMatch(/^## License\n\nMIT/m);
    expect(readme).not.toContain("Pending Sam");
  });
});

describe("FIX-R3-LICENSE: P2-R3-01 dist.zip ships the docs/ the README links", () => {
  it("collectDistEntries includes every docs/ file the README links", () => {
    const entries: Array<{ path: string; data: Buffer }> = collectDistEntries();
    const names = new Set(entries.map((e) => e.path));
    for (const f of ["docs/quickstart.md", "docs/host-rules.md", "docs/images/scope-matrix.png"]) {
      expect(names.has(f)).toBe(true);
    }
  });

  it("every relative docs/ link in the README resolves to a dist entry", () => {
    const readme = fs.readFileSync(path.join(REPO_ROOT, "README.md"), "utf8");
    const entries: Array<{ path: string; data: Buffer }> = collectDistEntries();
    const names = new Set(entries.map((e) => e.path));
    const links = [...readme.matchAll(/\]\((docs\/[^\s)]+)\)/g)].map((m) => m[1]!);
    expect(links.length).toBeGreaterThan(0);
    for (const link of links) {
      expect(names.has(link)).toBe(true);
    }
  });
});
