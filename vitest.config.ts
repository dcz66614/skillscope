import { defineConfig } from "vitest/config";

/**
 * Vitest config (P023 T012, S4).
 *
 * Only globalSetup is configured: dist/ is built once before any
 * test file runs (tests/helpers/global-setup.ts). Per-file beforeAll
 * builds were removed — they raced on dist/ (see global-setup.ts).
 * Test discovery is vitest's default (all *.test.ts under tests/).
 */
export default defineConfig({
  test: {
    globalSetup: ["./tests/helpers/global-setup.ts"],
  },
});
