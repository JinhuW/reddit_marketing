import { expect, test } from '@playwright/test';

process.env.DATABASE_URL ??= 'postgresql://threadline:threadline@localhost:5432/threadline';
const { prisma } = await import('@threadline/db');

type Page = import('@playwright/test').Page;
type Locator = import('@playwright/test').Locator;
const items = (page: Page) => page.locator('[data-conversation]');

/** Click a link and wait for the URL; retried because the shared dev server may recompile mid-click. */
async function go(page: Page, link: Locator, url: RegExp) {
  await expect(async () => {
    await link.click();
    await expect(page).toHaveURL(url, { timeout: 4000 });
  }).toPass({ timeout: 30_000 });
}

test.describe('conversations', () => {
  let unreadBefore: string[] = [];
  test.beforeAll(async () => {
    unreadBefore = (
      await prisma.conversation.findMany({ where: { unread: true }, select: { id: true } })
    ).map((c) => c.id);
  });
  // Opening a conversation marks it read; put the seed back.
  test.afterAll(async () => {
    await prisma.conversation.updateMany({ where: { id: { in: unreadBefore } }, data: { unread: true } });
  });

  test('tabs filter the list', async ({ page }) => {
    const jane = await prisma.workspaceMember.findFirstOrThrow({
      where: { user: { email: 'jane@acme.so' } },
    });
    const [all, needs, mine] = await Promise.all([
      prisma.conversation.count(),
      prisma.conversation.count({ where: { needsReply: true } }),
      prisma.conversation.count({ where: { lead: { ownerMemberId: jane.id } } }),
    ]);
    await page.goto('/conversations');
    await expect(items(page)).toHaveCount(all);

    await go(page, page.getByRole('link', { name: 'Needs reply' }), /tab=needs_reply/);
    await expect(items(page)).toHaveCount(needs);

    await go(page, page.getByRole('link', { name: 'Mine' }), /tab=mine/);
    await expect(items(page)).toHaveCount(mine);

    await go(
      page,
      page.getByRole('navigation', { name: 'Filter conversations' }).getByRole('link', { name: 'Unread' }),
      /tab=unread/,
    );
    await expect(items(page).first()).toBeVisible();
    for (const el of await items(page).all()) await expect(el.getByLabel('Unread')).toBeVisible();
  });

  test('thread marks our messages with account, agent and approver', async ({ page }) => {
    const conv = await prisma.conversation.findFirstOrThrow({
      where: { lead: { redditUser: { username: 'ops_kat' } } },
    });
    await page.goto(`/conversations?id=${conv.id}`);
    const ours = page.locator('[data-direction="out"]').first();
    await expect(ours).toContainText('u/jane_from_acme');
    await expect(ours).toContainText('Maya drafted');
    await expect(ours).toContainText('approved by Jane Park');
    await expect
      .poll(async () => (await prisma.conversation.findUniqueOrThrow({ where: { id: conv.id } })).unread)
      .toBe(false);
  });

  test('DM draft is refused without inbound engagement', async ({ page }) => {
    const ws = await prisma.workspace.findUniqueOrThrow({ where: { slug: 'acme' } });
    const sam = await prisma.agent.findFirstOrThrow({ where: { workspaceId: ws.id, name: 'Sam' } });
    const stamp = Date.now();
    const ru = await prisma.redditUser.create({
      data: { workspaceId: ws.id, username: `e2e_cold_${stamp}`, redditId: `t2_e2e${stamp}` },
    });
    const lead = await prisma.lead.create({
      data: { workspaceId: ws.id, redditUserId: ru.id, stage: 'new', agentId: sam.id },
    });
    const conv = await prisma.conversation.create({
      data: { workspaceId: ws.id, leadId: lead.id, kind: 'dm', originReason: 'e2e: no inbound message' },
    });
    try {
      await page.goto(`/conversations?id=${conv.id}`);
      const refusal = page
        .getByRole('alert')
        .filter({ hasText: 'DM follow-ups are only allowed after this person messaged or replied to us.' });
      await expect(async () => {
        await page.getByRole('button', { name: 'Ask Sam to draft' }).click();
        await expect(refusal).toBeVisible({ timeout: 8000 });
      }).toPass({ timeout: 40_000 });
    } finally {
      await prisma.conversation.delete({ where: { id: conv.id } });
      await prisma.lead.delete({ where: { id: lead.id } });
      await prisma.redditUser.delete({ where: { id: ru.id } });
    }
  });
});
