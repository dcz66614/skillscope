/**
 * Type declarations for scripts/perf-fixture.mjs (P023 T012, S4).
 *
 * The perf fixture generator is a plain .mjs script (repo convention
 * for scripts/); this sibling declaration file lets the TypeScript
 * test suite import it without `noImplicitAny` errors, and keeps
 * the exported shape type-checked.
 */

export interface PerfFixtureResult {
  count: number;
  files: string[];
}

export declare const DEFAULT_COUNT: number;

export declare function generatePerfFixture(
  rootDir: string,
  options?: { count?: number },
): PerfFixtureResult;
