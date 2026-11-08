import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
const MAIL_LOG = join(HERE, '../../../../data/dev-mail.log');
if (!process.env.DATABASE_URL) {
  for (const line of (existsSync(join(HERE, '../../../../.env'))
    ? readFileSync(join(HERE, '../../../../.env'), 'utf8')
    : ''
  ).split('\n')) {
    const m = line.match(/^([A-Z_]+)=(\S*)/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}
const { prisma, accounts } = await import('@threadline/db');

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

test('without a Reddit app the connect page offers the browser', async ({ page }) => {
  test.skip(Boolean(process.env.REDDIT_CLIENT_ID), 'checks the unconfigured state');
  await page.goto('/accounts/connect');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Connect a Reddit account');
  await expect(page.getByTestId('connect-browser')).toContainText('Connect through the browser');
  await expect(page.getByTestId('reddit-not-configured')).toContainText('No Reddit app is configured');
  await expect(page.getByRole('link', { name: 'Sign in with Reddit' })).toHaveCount(0);
  await expect(page.getByRole('combobox', { name: 'Proxy' })).toBeVisible();
  // Jane already owns an account and may connect another one
  await expect(page.getByRole('button', { name: 'Open the browser to sign in' })).toBeEnabled();
});

test('a member who already owns an account can connect another one', async ({ page }) => {
  await page.goto('/accounts/connect');
  await expect(page.getByText('This adds another account for you (you own u/jane_from_acme).')).toBeVisible();
  await expect(page.getByTestId('plan-full')).toHaveCount(0);
});

/**
 * AuditEvent is append-only, so a test account cannot be deleted. After the run the test member, its account,
 * profile and sessions move to an `e2e-archive` workspace: Acme keeps its three seeded accounts.
 */
async function archive(memberId: string) {
  const ws = await prisma.workspace.upsert({
    where: { slug: 'e2e-archive' },
    create: { name: 'e2e archive', slug: 'e2e-archive' },
    update: {},
  });
  const to = { workspaceId: ws.id };
  for (const acc of await prisma.redditAccount.findMany({ where: { ownerMemberId: memberId } })) {
    await prisma.browserSession.updateMany({ where: { profile: { accountId: acc.id } }, data: to });
    await prisma.browserProfile.updateMany({ where: { accountId: acc.id }, data: to });
    await prisma.redditAccount.update({ where: { id: acc.id }, data: to });
  }
  await prisma.workspaceMember.update({ where: { id: memberId }, data: to });
}

test('connect through the browser: pending account, sign-in session, identity, hand back', async ({
  browser,
  baseURL,
}) => {
  test.skip(Boolean(process.env.REDDIT_CLIENT_ID), 'browser mode is the default only without a Reddit app');
  test.setTimeout(120_000);
  // A fresh editor with no account, signed in through the dev magic link.
  const run = Date.now().toString(36);
  const email = `e2e-browser-${run}@acme.so`;
  const handle = `e2e_cs_${run}`;
  const acme = await prisma.workspace.findUniqueOrThrow({ where: { slug: 'acme' } });
  const user = await prisma.user.create({ data: { email, name: 'Eve Tester', emailVerified: new Date() } });
  const member = await prisma.workspaceMember.create({
    data: { workspaceId: acme.id, userId: user.id, role: 'editor' },
  });
  const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
  const page = await ctx.newPage();
  try {
    await page.goto('/login');
    await page.fill('input[name=email]', email);
    await page.click('button[type=submit]');
    await page.getByRole('heading', { name: 'Check your email' }).waitFor();
    const link = readFileSync(MAIL_LOG, 'utf8')
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as { to: string; url: string })
      .reverse()
      .find((l) => l.to === email);
    await page.goto(link!.url);
    await page.waitForURL(`${baseURL}/`);

    await page.goto('/accounts/connect');
    await page.getByRole('radiogroup', { name: 'Role' }).getByText('Support', { exact: true }).click();
    await page.getByRole('textbox', { name: 'Disclosure line' }).fill('I work on support at Acme.');
    await page.getByRole('button', { name: 'Open the browser to sign in' }).click();

    await expect(page).toHaveURL(/\/browsers\/[^/]+\/session\?login=1$/);
    const panel = page.getByTestId('sign-in-panel');
    await expect(panel).toContainText('Sign in to Reddit in this window, then press I’m signed in');
    await expect(page.getByTestId('control-chip')).toContainText('You have control');
    await expect(page.getByTestId('session-log')).toContainText('took control');
    // The seeded node is offline, so the new profile got no node: the page says so, and
    // "I'm signed in" queues nothing.
    await expect(page.getByRole('note')).toContainText('no browser node yet');
    await panel.getByRole('button', { name: 'I’m signed in' }).click();
    await expect(panel.getByRole('alert')).toContainText('no browser node yet');

    const acc = await prisma.redditAccount.findFirstOrThrow({ where: { ownerMemberId: member.id } });
    expect(acc).toMatchObject({ authMode: 'browser', identifiedAt: null });
    expect(acc.username).toMatch(/^pending-/);

    // The accounts list shows the pending account with a link back to its sign-in.
    await page.goto('/accounts');
    const card = page.getByTestId('account-card').filter({ hasText: 'Waiting for sign-in' });
    await expect(card.getByTestId('connection-chip')).toHaveText('Waiting for sign-in');
    await card.getByRole('link', { name: 'Open sign-in' }).click();
    await expect(page).toHaveURL(/\/session\?login=1$/);

    // What the gateway does when profile.whoami reads a signed-in browser (no live node in e2e).
    await accounts.completeBrowserIdentity(acc.workspaceId, acc.id, { name: handle, id: run });
    await page.reload();
    await expect(page.getByTestId('sign-in-panel')).toContainText(`Signed in as u/${handle}`);
    await page.getByRole('button', { name: 'Hand back and finish' }).click();
    await expect(page).toHaveURL(/\/accounts$/);
    const done = page.getByTestId('account-card').filter({ hasText: `u/${handle}` });
    await expect(done.getByTestId('connection-chip')).toHaveText('Browser sign-in');
    expect(
      await prisma.browserSession.count({ where: { profile: { accountId: acc.id }, endedAt: null } }),
    ).toBe(0);
  } finally {
    await ctx.close();
    await archive(member.id);
  }
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
