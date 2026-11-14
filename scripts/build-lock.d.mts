/**
 * Type declarations for scripts/build-lock.mjs (P023 T012, S4).
 *
 * The build lock is a plain .mjs script (repo convention for
 * scripts/); this sibling declaration file lets the TypeScript
 * test suite import it without `noImplicitAny` errors. (NodeNext:
 * a .mjs module pairs with a .d.mts declaration, not .d.ts.)
 */

export declare function withBuildLock<T>(fn: () => T): T;
