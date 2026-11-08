import { defineConfig } from 'vitest/config';

// Playwright specs under tests/e2e run with `pnpm test:e2e`, not Vitest.
export default defineConfig({
  test: { exclude: ['**/node_modules/**', '**/.next/**', 'tests/e2e/**'] },
});
