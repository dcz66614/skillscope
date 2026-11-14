/**
 * Type declarations for scripts/release-build.mjs (P023 FIX-R3-LICENSE).
 *
 * The release build is a plain .mjs script (repo convention for
 * scripts/); this sibling declaration file lets the TypeScript
 * test suite import it without `noImplicitAny` errors. (NodeNext:
 * a .mjs module pairs with a .d.mts declaration, not .d.ts.)
 * Only the exports the regression suite uses are declared.
 */

export interface DistEntry {
  path: string;
  data: Buffer;
}

export declare const ROOT: string;
export declare const RELEASE_DIR: string;
export declare const MANIFEST_FILE: string;
export declare const EXPECTED_GATE_SHA256: string;
export declare const EXPECTED_LICENSE_SHA256: string;
export declare const DEMO_PROFILE: string;
export declare const KNOWN_PUBLIC_JWT_EXAMPLE: string;

export declare function sha256Hex(buf: Buffer): string;
export declare function sha256File(file: string): string;
export declare function collectDistEntries(): DistEntry[];
export declare function emptyDirsMissingGitkeep(): string[];
export declare function licenseSha256FromCommit(commit: string): string | null;
