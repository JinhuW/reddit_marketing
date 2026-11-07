import { type Page, expect, test } from '@playwright/test';
import { PolicyError } from '@threadline/agents';
import { drafts, members, prisma } from '@threadline/db';

/**
 * Mutating tests work on copies of a seeded pending draft and delete them afterwards,
 * so the 7 seeded drafts stay intact. AuditEvent rows are append-only and stay.
 */
const created: string[] = [];

async function cloneSeedDraft(match: string, overrides: { body?: string } = {}) {
  const src = await prisma.draft.findFirstOrThrow({
    where: { status: 'pending', body: { contains: match }, id: { notIn: created } },
    orderBy: { createdAt: 'asc' },
  });
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src;
  const copy = await prisma.draft.create({
    data: {
      ...rest,
      body: overrides.body ?? src.body,
      bodyHistory: src.bodyHistory ?? [],
      ruleChecks: src.ruleChecks ?? [],
      // newest in the queue so it sorts last
      createdAt: new Date(),
    },
  });
  created.push(copy.id);
  return copy;
}

/** Navigates and waits until React has hydrated the review panel (clicks before that are lost). */
async function open(page: Page, path: string) {
  await page.goto(path);
  await page.locator('[aria-label="Draft review"][data-hydrated]').waitFor({ timeout: 30_000 });
}

async function member(email: string) {
  return prisma.workspaceMember.findFirstOrThrow({ where: { user: { email } }, include: { user: true } });
}

test.afterAll(async () => {
  if (created.length) await prisma.draft.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

test('approve moves the draft out of the queue and writes draft.approved', async ({ page }) => {
  const d = await cloneSeedDraft('We hit the same wall at 6 people');
  await open(page, `/approvals?id=${d.id}`);
  const approve = page.getByRole('button', { name: /Approve and post/ });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.locator(`[data-draft-row="${d.id}"]`)).toHaveCount(0);
  const after = await prisma.draft.findUniqueOrThrow({ where: { id: d.id } });
  expect(after.status).toBe('approved');
  expect(after.approverMemberId).toBe((await member('jane@acme.so')).id);
  const ev = await prisma.auditEvent.findFirst({ where: { targetId: d.id, action: 'draft.approved' } });
  expect(ev?.accountId).toBe(d.accountId);
  expect((ev?.meta as { disclosurePresent?: boolean }).disclosurePresent).toBe(true);
});

test('reject requires a reason and records it', async ({ page }) => {
  const d = await cloneSeedDraft('For 8 people');
  await open(page, `/approvals?id=${d.id}`);
  await page.getByRole('button', { name: 'Reject with reason' }).click();
  const reason = page.getByRole('textbox', { name: 'Reason for rejecting' });
  await expect(reason).toBeFocused();
  await reason.fill('Too salesy for a first touch');
  await page.getByRole('button', { name: 'Reject draft' }).click();
  await expect(page.locator(`[data-draft-row="${d.id}"]`)).toHaveCount(0);
  const after = await prisma.draft.findUniqueOrThrow({ where: { id: d.id } });
  expect(after.status).toBe('rejected');
  expect(after.rejectReason).toBe('Too salesy for a first touch');
  expect(await prisma.auditEvent.count({ where: { targetId: d.id, action: 'draft.rejected' } })).toBe(1);
});

test('a draft without the disclosure line cannot be approved (UI and server)', async ({ page }) => {
  const d = await cloneSeedDraft('We hit the same wall at 6 people');
  await open(page, `/approvals?id=${d.id}`);
  const box = page.getByRole('textbox', { name: 'Draft reply' });
  const text = 'Asana felt built for a 60-person org. Try one board per project.';
  // retry until hydrated: the live counter only updates once React owns the textarea
  await expect(async () => {
    await box.fill(text);
    await expect(page.getByText(`${text.length} characters`)).toBeVisible({ timeout: 500 });
  }).toPass();
  await expect(page.locator('[data-rule="disclosure"]')).toHaveAttribute('data-status', 'block');
  await expect(page.getByRole('button', { name: /Approve edit and post/ })).toBeDisabled();
  await expect(page.getByText(/Add the disclosure line .* to approve/)).toBeVisible();
  await expect(page.getByText('Missing disclosure')).toBeVisible();
  // the A shortcut does nothing either
  await box.blur();
  await page.keyboard.press('a');
  expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('pending');

  // server-side: the repository the server action calls refuses it
  const jane = await member('jane@acme.so');
  await expect(drafts.approve(d.id, jane, { body: 'No disclosure here at all.' })).rejects.toBeInstanceOf(
    PolicyError,
  );
  expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('pending');
});

test('J and K move through the queue', async ({ page }) => {
  await open(page, '/approvals');
  const rows = page.locator('[data-draft-row]');
  const first = await rows.nth(0).getAttribute('data-draft-row');
  const second = await rows.nth(1).getAttribute('data-draft-row');
  await page.locator('body').click({ position: { x: 5, y: 500 } });
  await page.keyboard.press('j');
  await expect(page).toHaveURL(new RegExp(`id=${second}`));
  await expect(rows.nth(1)).toHaveAttribute('aria-current', 'true');
  await page.keyboard.press('k');
  await expect(page).toHaveURL(new RegExp(`id=${first}`));
});

test.describe('as a viewer', () => {
  test.use({ storageState: 'tests/e2e/.auth/rhea.json' });

  test('cannot approve, reject or edit', async ({ page }) => {
    await open(page, '/approvals');
    await expect(page.getByRole('button', { name: /Approve and post/ })).toBeDisabled();
    await expect(page.getByText('Only approvers can approve drafts.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Reject with reason' })).toBeDisabled();
    await expect(page.getByRole('textbox', { name: 'Draft reply' })).toHaveAttribute('readonly', '');

    const rhea = await member('rhea@brightloop.io');
    expect(members.memberCanApprove(rhea)).toBe(false);
    const d = await cloneSeedDraft('Speed was the reason');
    await expect(drafts.approve(d.id, rhea)).rejects.toThrow(/not an approver/);
  });
});
