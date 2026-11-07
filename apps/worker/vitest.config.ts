import { readFileSync } from 'node:fs';
import { defineConfig } from 'vitest/config';

export default defineConfig({ test: { env: loadEnv(), fileParallelism: false, testTimeout: 30_000 } });

function loadEnv() {
  // Integration tests read DATABASE_URL etc. from the repo .env when not set by CI.
  const out: Record<string, string> = {};
  try {
    for (const line of readFileSync(new URL('../../.env', import.meta.url), 'utf8').split('\n')) {
      const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
      if (m && !process.env[m[1]!]) out[m[1]!] = m[2]!.replace(/\s+#.*$/, '');
    }
  } catch {}
  return out;
}
