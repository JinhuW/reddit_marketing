import { expect, test } from '@playwright/test';

test('home shows KPIs, hot opportunities, funnel, leaderboard and activity', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText(/Good (morning|afternoon|evening), Jane/);
  await expect(page.getByText(/drafts? (are|is) waiting for you/)).toBeVisible();
  for (const k of ['opps', 'pending', 'replies', 'leads', 'clicks', 'revenue'])
    await expect(page.getByTestId(`kpi-${k}`)).toBeVisible();
  await expect(
    page.getByRole('region', { name: 'Hot opportunities' }).getByRole('link', { name: 'Draft reply' }),
  ).toHaveCount(5);
  await expect(page.getByRole('region', { name: 'Funnel' })).toContainText('Customers');
  await expect(page.getByRole('region', { name: 'Agent leaderboard' })).toContainText('Maya');
  await expect(
    page.getByRole('region', { name: 'Activity' }).getByRole('link', { name: 'Audit log' }),
  ).toHaveAttribute('href', '/settings/audit');
});

test('range switch changes the KPI period', async ({ page }) => {
  await page.goto('/?range=30d');
  await expect(page.getByTestId('kpi-opps')).toContainText('Last 30 days');
});

test('Draft reply opens the opportunity', async ({ page }) => {
  await page.goto('/');
  await page
    .getByRole('region', { name: 'Hot opportunities' })
    .getByRole('link', { name: 'Draft reply' })
    .first()
    .click();
  await expect(page).toHaveURL(/\/opportunities\?id=/);
  await expect(page.getByRole('complementary', { name: 'Selected post' })).toBeVisible();
});
