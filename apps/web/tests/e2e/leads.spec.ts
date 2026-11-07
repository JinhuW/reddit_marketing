import { readFileSync } from 'node:fs';
import { type Locator, type Page, expect, test } from '@playwright/test';

process.env.DATABASE_URL ??= 'postgresql://threadline:threadline@localhost:5432/threadline';
const { prisma } = await import('@threadline/db');

const leadByUser = (username: string) =>
  prisma.lead.findFirstOrThrow({ where: { redditUser: { username } }, select: { id: true, stage: true } });

async function drag(page: Page, cardUser: string, toStageLabel: string) {
  const card = page.locator(`[data-lead="${cardUser}"]`);
  const target = page.getByRole('region', { name: toStageLabel, exact: true });
  await card.hover();
  await page.mouse.down();
  const a = await card.boundingBox();
  if (a) await page.mouse.move(a.x + a.width / 2 + 12, a.y + a.height / 2 + 12, { steps: 5 });
  await target.hover({ position: { x: 60, y: 90 }, force: true });
  const b = await target.boundingBox();
  if (b) await page.mouse.move(b.x + 70, b.y + 100, { steps: 5 });
  await page.mouse.up();
}

/** Click a link and wait for the URL; retried because the shared dev server may recompile mid-click. */
async function go(page: Page, link: Locator, url: RegExp) {
  await expect(async () => {
    await link.click();
    await expect(page).toHaveURL(url, { timeout: 4000 });
  }).toPass({ timeout: 30_000 });
}

test.describe('leads', () => {
  test('drag a card to another stage persists after reload', async ({ page }) => {
    const before = await leadByUser('quiet_lists');
    expect(before.stage).toBe('new');
    try {
      await page.goto('/leads');
      await expect(
        page.getByRole('region', { name: 'New', exact: true }).locator('[data-lead="quiet_lists"]'),
      ).toBeVisible();
      await expect(async () => {
        await drag(page, 'quiet_lists', 'Engaged');
        await expect
          .poll(async () => (await leadByUser('quiet_lists')).stage, { timeout: 8000 })
          .toBe('engaged');
      }).toPass({ timeout: 45_000 });
      await page.reload();
      await expect(
        page.getByRole('region', { name: 'Engaged', exact: true }).locator('[data-lead="quiet_lists"]'),
      ).toBeVisible();
      // and back
      await expect(async () => {
        await drag(page, 'quiet_lists', 'New');
        await expect.poll(async () => (await leadByUser('quiet_lists')).stage, { timeout: 8000 }).toBe('new');
      }).toPass({ timeout: 45_000 });
    } finally {
      await prisma.lead.update({ where: { id: before.id }, data: { stage: 'new' } });
    }
  });

  test('stage changes write an audit event', async () => {
    const lead = await leadByUser('quiet_lists');
    const n = await prisma.auditEvent.count({ where: { action: 'lead.stage_changed', targetId: lead.id } });
    expect(n).toBeGreaterThanOrEqual(2);
  });

  test('table view, saved views, sorting and CSV export', async ({ page }) => {
    await page.goto('/leads');
    await go(page, page.getByRole('link', { name: 'Table' }), /view=table/);
    await expect(page.getByRole('table')).toContainText('u/fernhill_ops');

    await go(page, page.getByRole('link', { name: 'Customers' }), /v=customers/);
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(await prisma.lead.count({ where: { stage: 'customer' } }));

    await go(page, page.getByRole('link', { name: /^Intent/ }), /sort=intentScore/);

    const [download] = await Promise.all([
      page.waitForEvent('download'),
      page.getByRole('link', { name: 'Export CSV' }).click(),
    ]);
    expect(download.suggestedFilename()).toMatch(/^threadline-leads-customers-.*\.csv$/);
    const csv = readFileSync((await download.path())!, 'utf8');
    const lines = csv.trim().split(/\r\n/);
    expect(lines[0]).toBe(
      'username,first_seen_thread,subreddits,stage,intent,agent,owner,last_touch,clicks,signup_email,deal_value_usd,revenue_usd,tags',
    );
    expect(lines).toHaveLength(1 + (await prisma.lead.count({ where: { stage: 'customer' } })));
    expect(csv).toContain('u/fernhill_ops');
  });

  test('CSV export requires sign-in', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: { cookies: [], origins: [] } });
    const res = await ctx.request.get('/leads/export');
    expect(res.status()).toBe(401);
    await ctx.close();
  });

  test('lead detail: timeline, notes and tasks', async ({ page }) => {
    const lead = await leadByUser('ops_kat');
    const original = await prisma.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { notes: true } });
    const tag = `e2e note ${Date.now()}`;
    try {
      await page.goto(`/leads/${lead.id}`);
      await expect(page.getByRole('heading', { level: 1 })).toHaveText('u/ops_kat');
      await expect(
        page.getByRole('group', { name: 'Stage' }).getByRole('button', { name: 'Interested' }),
      ).toHaveAttribute('aria-pressed', 'true');
      await expect(page.locator('li[data-kind="msg"]').first()).toBeVisible();
      await expect(page.getByText('created the lead')).toBeVisible();

      await expect(async () => {
        await page.getByRole('textbox', { name: 'Add a note' }).fill(tag);
        await page.getByRole('button', { name: 'Save note' }).click();
        await expect(page.getByText(tag)).toBeVisible({ timeout: 10_000 });
      }).toPass({ timeout: 45_000 });

      await page.getByRole('button', { name: 'Add task' }).click();
      await page.getByRole('textbox', { name: 'Task title' }).fill(tag);
      await page.getByRole('button', { name: 'Add', exact: true }).click();
      const box = page.getByRole('checkbox', { name: tag });
      await expect(box).not.toBeChecked({ timeout: 20_000 });
      await box.check();
      await expect
        .poll(async () => (await prisma.leadTask.findFirst({ where: { title: tag } }))?.done)
        .toBe(true);
    } finally {
      await prisma.leadTask.deleteMany({ where: { title: tag } });
      await prisma.lead.update({ where: { id: lead.id }, data: { notes: original.notes ?? [] } });
    }
  });

  test('viewers cannot move stages', async ({ browser }) => {
    const ctx = await browser.newContext({ storageState: 'tests/e2e/.auth/rhea.json' });
    const page = await ctx.newPage();
    const lead = await leadByUser('ops_kat');
    await page.goto(`/leads/${lead.id}`);
    await expect(
      page.getByRole('group', { name: 'Stage' }).getByRole('button', { name: 'Lost' }),
    ).toBeDisabled();
    await ctx.close();
  });
});
