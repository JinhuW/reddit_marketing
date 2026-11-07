import { expect, test } from '@playwright/test';

test('accounts page shows the three accounts with meters', async ({ page }) => {
  await page.goto('/accounts');
  const cards = page.getByTestId('account-card');
  await expect(cards).toHaveCount(3);
  const jane = cards.filter({ hasText: 'u/jane_from_acme' });
  await expect(jane).toContainText('Discloses: “I work on Acme”');
  await expect(jane).toContainText('2,410');
  await expect(jane).toContainText(/\d+ of 5 today/);
  await expect(jane).toContainText(/\d+% of 10% max/);
  await expect(jane.getByRole('meter')).toHaveCount(2);
  await expect(cards.filter({ hasText: 'u/leo_acme_founder' })).toContainText('Watch ratio');
});

test('connect page shows the not-configured state', async ({ page }) => {
  test.skip(Boolean(process.env.REDDIT_CLIENT_ID), 'checks the unconfigured state');
  await page.goto('/accounts/connect');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connect a Reddit account');
  await expect(page.getByTestId('reddit-not-configured')).toHaveText(
    'Reddit app not configured — set REDDIT_CLIENT_ID/SECRET',
  );
  await expect(page.getByRole('button', { name: 'Sign in with Reddit' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Finish connecting' })).toBeDisabled();
});

test('a member who already owns an account is refused a second one', async ({ page }) => {
  await page.goto('/accounts/connect');
  await expect(page.getByTestId('one-account-refusal')).toHaveText(
    'You already own u/jane_from_acme. Each person can connect one Reddit account.',
  );
  // The OAuth start route refuses too, before any Reddit redirect.
  await page.goto('/api/auth/reddit/start');
  await expect(page).toHaveURL(/\/accounts\/connect\?error=already_owner/);
  await expect(page.getByRole('alert').first()).toContainText('You already own a connected Reddit account');
});
