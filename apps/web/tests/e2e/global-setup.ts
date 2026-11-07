import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
import { type FullConfig, chromium } from '@playwright/test';

const MAIL_LOG = join(HERE, '../../../../data/dev-mail.log');

/** Signs in as a seeded member through the real magic-link flow (dev mail sink) and saves storage state. */
export async function signInAs(email: string, baseURL: string, statePath: string) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ baseURL });
  await page.goto('/login');
  await page.fill('input[name=email]', email);
  await page.click('button[type=submit]');
  await page.getByRole('heading', { name: 'Check your email' }).waitFor();
  const lines = readFileSync(MAIL_LOG, 'utf8').trim().split('\n');
  const last = [...lines]
    .reverse()
    .map((l) => JSON.parse(l))
    .find((l) => l.to === email);
  await page.goto(last.url);
  await page.waitForURL(`${baseURL}/`);
  await page.context().storageState({ path: statePath });
  await browser.close();
}

export default async function globalSetup(config: FullConfig) {
  const baseURL = (config.projects[0]?.use.baseURL as string) ?? 'http://localhost:3000';
  const dir = join(HERE, '.auth');
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  // Retry once: the dev server may be recompiling when the run starts.
  const withRetry = async (email: string, file: string) => {
    try {
      await signInAs(email, baseURL, join(dir, file));
    } catch {
      await signInAs(email, baseURL, join(dir, file));
    }
  };
  await withRetry('jane@acme.so', 'jane.json');
  await withRetry('rhea@brightloop.io', 'rhea.json');
}
