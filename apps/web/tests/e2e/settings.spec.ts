import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  for (const line of (existsSync(join(HERE, '../../../../.env'))
    ? readFileSync(join(HERE, '../../../../.env'), 'utf8')
    : ''
  ).split('\n')) {
    const m = line.match(/^([A-Z_]+)=(\S*)/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}
const { prisma } = await import('@threadline/db');
const RHEA = join(HERE, '.auth/rhea.json');

test('team table shows the 5 seeded members with approval rights', async ({ page }) => {
  await page.goto('/settings');
  const rows = page.getByTestId('team-table').locator('tbody tr');
  await expect(rows).toHaveCount(5);
  await expect(rows.filter({ hasText: 'Jane Park' })).toContainText('u/jane_from_acme');
  await expect(rows.filter({ hasText: 'Sam Okafor' }).locator('.chip-mid')).toHaveText('No');
});

test('audit log shows posted and rejected items; CSV export works', async ({ page }) => {
  await page.goto('/settings/audit');
  const table = page.getByTestId('audit-table');
  await expect(table.locator('.chip', { hasText: /^Posted$/ }).first()).toBeVisible();
  await expect(table.locator('.chip', { hasText: 'Rejected' }).first()).toBeVisible();
  await expect(table).toContainText('u/jane_from_acme');
  const res = await page.request.get('/api/audit/export');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/csv');
  expect((await res.text()).split('\n')[0]).toBe(
    'when,action,label,item,agent,approved_by,posted_from,disclosure',
  );
});

test('an admin can invite a member', async ({ page }) => {
  const email = `e2e-${Date.now()}@example.com`;
  try {
    await page.goto('/settings/team');
    await page.getByRole('button', { name: 'Invite member' }).click();
    await page.getByLabel('Email').fill(email);
    await page.getByLabel('Role', { exact: true }).selectOption('viewer');
    await page.getByRole('button', { name: 'Send invite' }).click();
    await expect(page.getByRole('status')).toContainText(`Invited ${email}`);
    await expect(page.getByTestId('team-table')).toContainText(email);
  } finally {
    const user = await prisma.user.findUnique({ where: { email } });
    if (user) {
      await prisma.workspaceMember.deleteMany({ where: { userId: user.id } });
      await prisma.user.delete({ where: { id: user.id } });
    }
  }
});

test('a viewer sees settings read-only and CSV requires a session', async ({ browser, playwright }) => {
  const ctx = await browser.newContext({ storageState: RHEA });
  const page = await ctx.newPage();
  await page.goto('/settings/team');
  await expect(page.getByTestId('team-table')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite member' })).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.goto('/settings/reports');
  await expect(page.getByText('Only admins can change the report.')).toBeVisible();
  await ctx.close();
  const anon = await playwright.request.newContext({
    baseURL: 'http://localhost:3000',
    storageState: { cookies: [], origins: [] },
  });
  expect((await anon.get('/api/audit/export')).status()).toBe(401);
  await anon.dispose();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
