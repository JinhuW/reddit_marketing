import { defineConfig } from '@playwright/test';

/**
 * E2E against a running dev server with the seed loaded (pnpm db:seed).
 * CI: the workflow starts `pnpm dev` first. No live Reddit/LLM calls.
 */
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  fullyParallel: false,
  workers: 1,
  use: {
    baseURL: process.env.E2E_BASE_URL ?? 'http://localhost:3000',
    storageState: 'tests/e2e/.auth/jane.json',
    viewport: { width: 1440, height: 1000 },
  },
  globalSetup: './tests/e2e/global-setup.ts',
});
