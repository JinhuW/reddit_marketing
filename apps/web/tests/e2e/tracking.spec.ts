import { execFileSync } from 'node:child_process';
import { expect, test } from '@playwright/test';

const DB = process.env.DATABASE_URL ?? 'postgresql://threadline:threadline@localhost:5432/threadline';
const sql = (q: string) => execFileSync('psql', [DB, '-Atc', q], { encoding: 'utf8' }).trim();
const NAME = 'E2E keyword group';

test.afterAll(() => {
  sql(`DELETE FROM "KeywordGroup" WHERE name LIKE '${NAME}%'`);
});

test('tracking shows the seeded keyword groups and subreddits', async ({ page }) => {
  await page.goto('/tracking');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Tracking');
  for (const g of ['Asana alternative', 'ClickUp complaints', 'Small-team PM tools', 'Guest access']) {
    await expect(
      page.getByTestId('keyword-group').filter({ has: page.getByRole('heading', { name: g }) }),
    ).toHaveCount(1);
  }
  const rows = page.getByTestId('subreddit-row');
  await expect(rows).toHaveCount(5);
  for (const s of ['projectmanagement', 'SaaS', 'startups', 'productivity', 'Entrepreneur'])
    await expect(page.getByTestId('subreddits')).toContainText(`r/${s}`);
  await expect(page.getByText('Share of voice')).toBeVisible();
});

test('create, edit and delete a keyword group', async ({ page }) => {
  await page.goto('/tracking');
  await page.getByRole('link', { name: 'New keyword group' }).click();
  const form = page.getByRole('form', { name: 'New keyword group' });
  await form.getByLabel('Name').fill(NAME);
  await form.getByLabel('Intent').selectOption('competitor_complaint');
  await form.getByLabel(/Include terms/).fill('e2e term one, e2e term two');
  await form.getByLabel('Competitor terms').fill('trello');
  await form.getByLabel('Exclude terms').fill('trello jobs');
  await form.getByRole('button', { name: 'Create group' }).click();

  const card = page.getByTestId('keyword-group').filter({ has: page.getByRole('heading', { name: NAME }) });
  await expect(card).toBeVisible();
  await expect(card).toContainText('Competitor complaint');
  await expect(card).toContainText('e2e term two');
  await expect(card).toContainText('trello jobs');

  await card.getByRole('button', { name: `Edit ${NAME}` }).click();
  const edit = page.getByRole('form', { name: `Edit ${NAME}` });
  await edit.getByLabel('Alert channel').selectOption('none');
  await edit.getByRole('button', { name: 'Save group' }).click();
  await expect(card).toContainText('Alerts: Off');

  await card.getByRole('button', { name: `Edit ${NAME}` }).click();
  page.once('dialog', (d) => d.accept());
  await page
    .getByRole('form', { name: `Edit ${NAME}` })
    .getByRole('button', { name: 'Delete' })
    .click();
  await expect(card).toHaveCount(0);
});

test('validation errors are shown', async ({ page }) => {
  await page.goto('/tracking?new=group');
  const form = page.getByRole('form', { name: 'New keyword group' });
  await form.getByLabel('Name').fill(`${NAME} invalid`);
  await form.getByLabel(/Include terms/).fill(' , ');
  await form.getByRole('button', { name: 'Create group' }).click();
  await expect(form.getByRole('alert')).toHaveText('Add at least one include term');
});

test('edit a subreddit link rule', async ({ page }) => {
  const before = sql(`SELECT "linkRule" FROM "Subreddit" WHERE name = 'productivity'`);
  try {
    await page.goto('/tracking');
    await page.getByRole('button', { name: 'Edit r/productivity' }).click();
    const form = page.getByRole('form', { name: 'Edit r/productivity' });
    await form.getByLabel('Link rule').selectOption('none');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByTestId('subreddit-row').filter({ hasText: 'r/productivity' })).toContainText(
      'None in comments',
    );
  } finally {
    sql(`UPDATE "Subreddit" SET "linkRule" = '${before}' WHERE name = 'productivity'`);
  }
});

test.describe('as a viewer', () => {
  test.use({ storageState: 'tests/e2e/.auth/rhea.json' });
  test('sees no editing controls', async ({ page }) => {
    await page.goto('/tracking');
    await expect(page.getByTestId('keyword-group').first()).toBeVisible();
    await expect(page.getByRole('link', { name: 'New keyword group' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Edit / })).toHaveCount(0);
  });
});
