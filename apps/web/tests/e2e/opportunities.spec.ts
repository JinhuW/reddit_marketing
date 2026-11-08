import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

// Load DATABASE_URL for direct DB checks/restores (Playwright does not read .env).
const HERE = dirname(fileURLToPath(import.meta.url));
for (const line of (existsSync(join(HERE, '../../../../.env'))
  ? readFileSync(join(HERE, '../../../../.env'), 'utf8')
  : ''
).split('\n')) {
  const m = line.match(/^([A-Z_]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/\s+#.*$/, '');
}
const { prisma } = await import('@threadline/db');

test('filters live in the URL and survive a reload', async ({ page }) => {
  await page.goto('/opportunities');
  await page.getByRole('button', { name: /^Subreddit/ }).click();
  await page.getByLabel('r/SaaS').check();
  await expect(page).toHaveURL(/sub=SaaS/);
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /^Score/ }).click();
  await page.getByLabel('≥ 90').check();
  await expect(page).toHaveURL(/score=90/);
  await page.reload();
  const cards = page.getByTestId('opp-card');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('ClickUp is getting too bloated');
  await expect(page.getByRole('button', { name: /^Subreddit/ })).toContainText('1 selected');
});

test('topbar search filters with ?q=', async ({ page }) => {
  await page.goto('/opportunities');
  await page.getByRole('searchbox', { name: 'Search' }).fill('Asana alternative');
  await page.keyboard.press('Enter');
  await expect(page).toHaveURL(/q=Asana/);
  await expect(page.getByTestId('opp-card').first()).toContainText('simple Asana alternative');
});

test('selecting a card shows it in the detail panel', async ({ page }) => {
  await page.goto('/opportunities');
  const second = page.getByTestId('opp-card').nth(1);
  const title = (await second.locator('a').first().textContent())!.trim();
  await second.locator('a').first().click();
  await expect(page).toHaveURL(/id=/);
  const aside = page.getByRole('complementary', { name: 'Selected post' });
  await expect(aside).toContainText(title);
  await expect(aside.getByRole('button', { name: 'Generate draft' })).toBeVisible();
  await expect(aside).toContainText(/Draft will post from u\//);
});

test('bulk skip writes the status and an audit event', async ({ page }) => {
  const opp = await prisma.opportunity.findFirstOrThrow({
    where: { status: 'new', post: { title: { startsWith: 'Kanban app' } } },
    include: { post: true },
  });
  try {
    await page.goto(`/opportunities?q=${encodeURIComponent(opp.post.title)}&score=0&days=all`);
    const card = page.locator(`[data-id="${opp.id}"]`);
    await card.getByRole('checkbox').check();
    await page.getByRole('button', { name: 'Skip', exact: true }).click();
    await expect(page.getByText('1 skipped')).toBeVisible();
    await expect
      .poll(async () => (await prisma.opportunity.findUnique({ where: { id: opp.id } }))?.status)
      .toBe('skipped');
    expect(
      await prisma.auditEvent.count({ where: { action: 'opportunity.skipped', targetId: opp.id } }),
    ).toBeGreaterThan(0);
  } finally {
    await prisma.opportunity.update({ where: { id: opp.id }, data: { status: 'new' } });
  }
});

test.afterAll(async () => {
  await prisma.$disconnect();
});
