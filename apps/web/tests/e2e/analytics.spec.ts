import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const DB = process.env.DATABASE_URL ?? 'postgresql://threadline:threadline@localhost:5432/threadline';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
const LABEL = 'e2e-utm-link';

test.afterAll(() => {
  sql(`DELETE FROM "TrackedLink" WHERE utm->>'label' = '${LABEL}'`);
});

test('analytics shows non-zero KPIs from the seed', async ({ page }) => {
  await page.goto('/analytics?range=30d');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Analytics');
  for (const k of ['clicks', 'visitors', 'signups', 'revenue']) {
    const value = page.locator(`[data-kpi="${k}"] .num`);
    await expect(value).not.toHaveText(/^\$?0(\.00)?$/);
  }
  await expect(page.getByRole('img', { name: /Daily clicks over/ })).toBeVisible();
});

test('breakdown tabs change the rows', async ({ page }) => {
  await page.goto('/analytics?range=30d');
  const table = page.getByTestId('breakdown');
  await expect(table.locator('tbody tr').first()).toContainText('r/');
  await page.getByRole('navigation', { name: 'Break down by' }).getByRole('link', { name: 'Agent' }).click();
  await expect(page).toHaveURL(/by=agent/);
  await expect(table.locator('thead th').first()).toHaveText('Agent');
  await expect(table).toContainText('Maya');
  await expect(table).not.toContainText('r/projectmanagement');
});

test('range switch updates the URL', async ({ page }) => {
  await page.goto('/analytics');
  await page.getByRole('button', { name: /Last 7 days/ }).click();
  await page.getByRole('button', { name: 'Last 30 days' }).click();
  await expect(page).toHaveURL(/range=30d/);
  await expect(page.getByText('Traffic and revenue attributed to Reddit · last 30 days')).toBeVisible();
});

test('UTM builder previews and creates a tracked link', async ({ page }) => {
  await page.goto('/analytics');
  await page.getByRole('button', { name: 'UTM builder' }).click();
  const form = page.getByRole('form', { name: 'UTM builder' });
  await form.getByLabel('Destination URL').fill('https://acme.so/e2e-page');
  await form.getByLabel('Medium').selectOption('post');
  const preview = page.getByTestId('utm-preview');
  await expect(preview).toContainText('https://acme.so/e2e-page?utm_source=reddit&utm_medium=post');
  await expect(preview).toContainText('utm_campaign=');
  await form.getByLabel(/Display label/).fill(LABEL);
  await form.getByRole('button', { name: 'Create link' }).click();
  await expect(form.getByText(/^Created \/r\//)).toBeVisible({ timeout: 20_000 });
  await expect(page.getByTestId('tracked-links')).toContainText(`/r/${LABEL}`);
  expect(sql(`SELECT medium FROM "TrackedLink" WHERE utm->>'label' = '${LABEL}'`)).toBe('post');
});

test.describe('as a viewer', () => {
  test.use({ storageState: 'tests/e2e/.auth/rhea.json' });
  test('cannot create links', async ({ page }) => {
    await page.goto('/analytics');
    await page.getByRole('button', { name: 'UTM builder' }).click();
    await expect(page.getByRole('button', { name: 'Create link' })).toHaveCount(0);
    await expect(page.getByText('Editors can create links.')).toBeVisible();
  });
});

test('CSV export downloads the breakdown', async ({ request }) => {
  const res = await request.get('/analytics/export?range=30d&by=subreddit');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/csv');
  const body = await res.text();
  expect(body.split('\n')[0]).toBe('"subreddit","replies","clicks","signups","customers","revenue_usd"');
  expect(body).toContain('r/projectmanagement');
});
