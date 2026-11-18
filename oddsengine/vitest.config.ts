/**
 * Vitest configuration for the odds engine.
 *
 * This file exists for one specific reason: the parent repository has its own
 * `vite.config.ts` (a TanStack Start app). Without a config of its own, Vitest
 * walks up and tries to load that one, which fails because the engine is not a
 * web app. Pinning a root and an explicit include list keeps the engine's test
 * run completely independent of the website — which is the whole point of
 * `oddsengine/` being a standalone service.
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: import.meta.dirname,
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**'],
    environment: 'node',
    testTimeout: 30_000,
    hookTimeout: 30_000,
    // Integration tests talk to a real Supabase project; running them in
    // parallel would have them fight over the same rows.
    fileParallelism: false,
    reporters: ['default'],
  },
});
