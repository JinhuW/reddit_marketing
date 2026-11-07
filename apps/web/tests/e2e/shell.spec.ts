import { expect, test } from '@playwright/test';

const ROUTES: [string, RegExp][] = [
  ['/', /Good (morning|afternoon|evening)/],
  ['/opportunities', /Opportunities/],
  ['/approvals', /Approvals/],
  ['/conversations', /Conversations/],
  ['/leads', /Leads/],
  ['/agents', /Agent employees/],
  ['/analytics', /Analytics/],
  ['/tracking', /Tracking/],
  ['/accounts', /Reddit accounts/],
  ['/browsers', /Browsers/],
  ['/settings', /Settings/],
];

for (const [path, title] of ROUTES) {
  test(`shell renders ${path}`, async ({ page }) => {
    await page.goto(path);
    await expect(page.getByRole('navigation', { name: 'Main' })).toBeVisible();
    await expect(page.getByRole('heading', { level: 1 }).first()).toHaveText(title);
  });
}

test('signed-out visitors are sent to login', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  await page.goto('/approvals');
  await expect(page).toHaveURL(/\/login/);
  await ctx.close();
});
