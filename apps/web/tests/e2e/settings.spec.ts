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
  // Page 1 holds the newest rows; earlier specs (and the unit tests on the same DB in CI) add audit rows, so the
  // seeded posted/rejected items are checked in the full export rather than on the first page.
  await expect(table.locator('.chip').first()).toBeVisible();
  const res = await page.request.get('/api/audit/export');
  expect(res.status()).toBe(200);
  expect(res.headers()['content-type']).toContain('text/csv');
  const csv = await res.text();
  expect(csv.split('\n')[0]).toBe('when,action,label,item,agent,approved_by,posted_from,disclosure');
  expect(csv).toContain('"draft.posted","Posted"');
  expect(csv).toContain('"draft.rejected","Rejected"');
  expect(csv).toContain('u/jane_from_acme');
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

test('an admin adds a proxy provider; credentials are write-only', async ({ page }) => {
  const name = `E2E Decodo ${Date.now().toString(36)}`;
  try {
    await page.goto('/settings/proxies');
    await page.getByRole('button', { name: 'Add provider' }).click();
    const form = page.getByTestId('provider-form');
    await form.getByLabel('Name', { exact: true }).fill(name);
    await form.getByLabel('Host').fill('isp.decodo.e2e');
    await form.getByLabel('Ports from').fill('10001');
    await form.getByLabel('Ports to').fill('10100');
    await form.getByLabel('Username').fill('e2e-settings-user');
    await form.getByLabel('Password').fill('e2e-settings-pass');
    await form.getByRole('button', { name: 'Add provider' }).click();
    const row = page.getByTestId('provider-table').locator(`tr[data-provider="${name}"]`);
    await expect(row).toContainText('isp.decodo.e2e');
    await expect(row).toContainText('10001–10100');
    await expect(row.locator('.chip')).toHaveText('Saved');
    await expect(row.getByTestId('ports-in-use')).toHaveText('None');
    expect(await page.content()).not.toContain('e2e-settings-');

    // Editing keeps the saved credentials when the fields stay blank.
    const before = await prisma.proxyProvider.findFirstOrThrow({ where: { name } });
    await row.getByRole('button', { name: `Edit ${name}` }).click();
    await expect(form.getByLabel('Password')).toHaveValue('');
    await expect(form.getByLabel('Password')).toHaveAttribute('placeholder', '•••• saved');
    await form.getByLabel('Region').fill('US');
    await form.getByRole('button', { name: 'Save provider' }).click();
    await expect(row).toContainText('US');
    const after = await prisma.proxyProvider.findFirstOrThrow({ where: { name } });
    expect(after.passwordEnc).toBe(before.passwordEnc);
    expect(after.usernameEnc).toBe(before.usernameEnc);

    await row.getByRole('button', { name: `Delete ${name}` }).click();
    await expect(row).toHaveCount(0);
  } finally {
    await prisma.proxyProvider.deleteMany({ where: { name } });
  }
});

test('a viewer sees settings read-only and CSV requires a session', async ({
  browser,
  playwright,
  baseURL,
}) => {
  const ctx = await browser.newContext({ storageState: RHEA });
  const page = await ctx.newPage();
  await page.goto('/settings/team');
  await expect(page.getByTestId('team-table')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Invite member' })).toHaveCount(0);
  await expect(page.getByRole('combobox')).toHaveCount(0);
  await page.goto('/settings/reports');
  await expect(page.getByText('Only admins can change the report.')).toBeVisible();
  await expect(page.getByRole('link', { name: 'Proxies' })).toHaveCount(0);
  await page.goto('/settings/proxies');
  await expect(page.getByText('Only admins can manage proxies.')).toBeVisible();
  await ctx.close();
  const anon = await playwright.request.newContext({
    baseURL: baseURL ?? 'http://localhost:3000',
    storageState: { cookies: [], origins: [] },
  });
  expect((await anon.get('/api/audit/export')).status()).toBe(401);
  await anon.dispose();
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
