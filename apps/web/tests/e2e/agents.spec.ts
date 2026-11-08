import { expect, test } from '@playwright/test';

async function openMaya(page: import('@playwright/test').Page, tab: string) {
  await page.goto('/agents');
  await page.getByTestId('agent-card').filter({ hasText: 'Maya' }).click();
  await expect(page).toHaveURL(/\/agents\?id=/);
  const href = await page
    .getByRole('navigation', { name: 'Agent sections' })
    .getByRole('link', { name: tab })
    .getAttribute('href');
  expect(href).toMatch(new RegExp(`^/agents/[^/]+/${tab.toLowerCase()}$`));
  await page.goto(href!);
  await expect(page.getByRole('link', { name: tab, exact: true })).toHaveAttribute('aria-current', 'page');
}

test('agent list renders the seeded agents', async ({ page }) => {
  await page.goto('/agents');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Agent employees');
  const cards = page.getByTestId('agent-card');
  await expect(cards).toHaveCount(3);
  for (const name of ['Maya', 'Leo', 'Sam']) await expect(cards.filter({ hasText: name })).toHaveCount(1);
  await expect(cards.filter({ hasText: 'Sam' })).toContainText('Paused');
  await expect(cards.filter({ hasText: 'Maya' })).toContainText('u/jane_from_acme');
});

test('persona voice edits persist', async ({ page }) => {
  await openMaya(page, 'Persona');
  const slider = page.getByLabel('Casual to Formal');
  const original = await slider.inputValue();
  const next = original === '80' ? '20' : '80';
  await slider.fill(next);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Persona saved.' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Casual to Formal')).toHaveValue(next);
  // restore
  await page.getByLabel('Casual to Formal').fill(original);
  await page.getByRole('button', { name: 'Save changes' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Persona saved.' })).toBeVisible();
  await page.reload();
  await expect(page.getByLabel('Casual to Formal')).toHaveValue(original);
});

test('skill toggle persists', async ({ page }) => {
  await openMaya(page, 'Skills');
  const box = page.getByLabel('Enable Launch posts');
  const was = await box.isChecked();
  await box.click();
  await expect(page.getByTestId('skill-launch_post').getByRole('status')).toHaveText('Skill saved.');
  await page.reload();
  await expect(page.getByLabel('Enable Launch posts')).toBeChecked({ checked: !was });
  // restore
  await page.getByLabel('Enable Launch posts').click();
  await expect(page.getByTestId('skill-launch_post').getByRole('status')).toHaveText('Skill saved.');
  await page.reload();
  await expect(page.getByLabel('Enable Launch posts')).toBeChecked({ checked: was });
});

test('playground shows the assembled prompt without faking a model reply', async ({ page }) => {
  test.skip(Boolean(process.env.ANTHROPIC_API_KEY), 'checks the no-key state');
  await page.goto('/agents');
  await page.getByRole('button', { name: 'Draft as Maya' }).click();
  const result = page.getByTestId('playground-result');
  await expect(result).toContainText('Add ANTHROPIC_API_KEY to run the playground');
  await expect(result).toContainText('"I work on Acme"');
});

test('only admins can create agents', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: 'tests/e2e/.auth/rhea.json' });
  const page = await ctx.newPage();
  await page.goto('/agents?new=1');
  await expect(page.getByRole('alert').filter({ hasText: 'Only admins' })).toContainText(
    'Only admins can create agents.',
  );
  await expect(page.getByRole('button', { name: 'Create agent' })).toHaveCount(0);
  await ctx.close();
});
