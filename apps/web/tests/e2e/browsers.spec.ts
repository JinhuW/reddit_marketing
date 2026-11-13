import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

const HERE = dirname(fileURLToPath(import.meta.url));
if (!process.env.DATABASE_URL) {
  for (const line of (existsSync(join(HERE, '../../../../.env'))
    ? readFileSync(join(HERE, '../../../../.env'), 'utf8')
    : ''
  ).split('\n')) {
    const m = line.match(/^([A-Z_]+)=(\S*)/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2];
  }
}
const { prisma } = await import('@threadline/db');

const profileId = async (name: string) =>
  (await prisma.browserProfile.findFirstOrThrow({ where: { name, workspace: { slug: 'acme' } } })).id;
const RHEA = join(HERE, '.auth/rhea.json');

test('profile table lists 3 profiles and flags Sam’s region mismatch', async ({ page }) => {
  await page.goto('/browsers');
  const rows = page.getByTestId('profile-table').locator('tbody tr');
  await expect(rows).toHaveCount(3);
  const sam = page.locator('tr[data-profile="Sam · Chrome"]');
  await expect(sam.locator('.chip-warn').first()).toContainText('New York');
  await expect(sam.getByRole('link', { name: 'Fix' })).toBeVisible();
  await sam.getByTestId('node-cell').click(); // any cell of the row opens the drawer, not just the links
  await expect(page).toHaveURL(/[?&]id=/);
  await expect(page.getByTestId('connection-test')).toContainText('owner is in Austin, US');
  await expect(page.getByRole('note')).toContainText('Region mismatch');
});

test('saving a proxy port persists and never echoes credentials', async ({ page }) => {
  const id = await profileId('Leo · Chrome');
  const before = await prisma.browserProfile.findUniqueOrThrow({ where: { id }, include: { proxy: true } });
  try {
    await page.goto(`/browsers?id=${id}`);
    await expect(page.getByLabel('Port')).toBeHidden(); // custom proxy form starts folded
    await page.getByText('enter a proxy for this profile').click();
    const proxyPassword = page.getByTestId('custom-proxy').getByLabel('Password');
    await expect(proxyPassword).toHaveValue('');
    await expect(proxyPassword).toHaveAttribute('placeholder', '•••• saved');
    await page.getByLabel('Port').fill('22226');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.getByRole('status').filter({ hasText: 'Proxy saved' })).toBeVisible();
    await page.reload();
    await page.getByText('enter a proxy for this profile').click();
    await expect(page.getByLabel('Port')).toHaveValue('22226');
    const after = await prisma.proxy.findUniqueOrThrow({ where: { id: before.proxyId! } });
    expect(after.passwordEnc).toBe(before.proxy!.passwordEnc); // blank field kept the saved secret
    expect(await page.content()).not.toContain('tl-acme-leo');
  } finally {
    await prisma.proxy.update({ where: { id: before.proxyId! }, data: { port: before.proxy!.port } });
  }
});

test('session page shows the viewer area and the session log', async ({ page }) => {
  const id = await profileId('Jane · Chrome');
  await page.goto(`/browsers/${id}/session`);
  await expect(page.getByTestId('vnc-viewer')).toContainText('Live view is off');
  await expect(page.getByTestId('vnc-viewer')).toHaveAttribute('data-vnc-state', 'idle');
  await expect(page.getByRole('button', { name: 'Full screen' })).toBeVisible();
  await expect(page.getByTestId('session-log').locator('li')).not.toHaveCount(0);
  await expect(page.getByTestId('session-log')).toContainText('verification');
});

test('take over then hand back writes the session log', async ({ page }) => {
  const id = await profileId('Leo · Chrome');
  await page.goto(`/browsers/${id}/session`);
  // a previous run may have left a session open
  const handBack = page.getByRole('button', { name: /Hand back/ });
  if (await handBack.isVisible()) await handBack.click();
  await page.getByLabel('Why are you taking over?').fill('e2e: checking the comment box');
  await page.getByRole('button', { name: /Take control/ }).click();
  await expect(page.getByTestId('control-chip')).toContainText('You have control');
  await expect(page.getByTestId('session-log')).toContainText('took control');
  await page.getByRole('button', { name: /Hand back/ }).click();
  await expect(page.getByTestId('session-log')).toContainText('handed back');
  await expect(page.getByRole('button', { name: /Take control/ })).toBeVisible();
});

test('VNC proxy: admin gets 503 (not running), viewer gets 403 and cannot take over', async ({
  page,
  browser,
}) => {
  const id = await profileId('Jane · Chrome');
  expect((await page.request.get(`/api/vnc/${id}`)).status()).toBe(503);

  const ctx = await browser.newContext({ storageState: RHEA });
  const viewer = await ctx.newPage();
  expect((await viewer.request.get(`/api/vnc/${id}`)).status()).toBe(403);
  const leo = await profileId('Leo · Chrome');
  await viewer.goto(`/browsers/${leo}/session`);
  await expect(
    viewer.getByText('Only an admin or the account owner can take over this browser.'),
  ).toBeVisible();
  await expect(viewer.getByRole('button', { name: /Take control/ })).toHaveCount(0);
  await ctx.close();
});

test('table shows the node and pause reason; an admin resumes the account', async ({ page }) => {
  const id = await profileId('Sam · Chrome');
  const p = await prisma.browserProfile.findUniqueOrThrow({ where: { id } });
  await prisma.redditAccount.update({
    where: { id: p.accountId },
    data: { pausedReason: 'needs_human', pausedAt: new Date() },
  });
  try {
    await page.goto(`/browsers?id=${id}`);
    const sam = page.locator('tr[data-profile="Sam · Chrome"]');
    await expect(sam.getByTestId('node-cell')).toContainText('browser-1');
    await expect(sam.getByTestId('node-cell')).toContainText('Offline');
    await expect(sam.getByTestId('pause-reason')).toHaveText('Paused · Needs a human');
    const controls = page.getByTestId('browser-controls');
    await expect(controls.getByTestId('pause-chip')).toHaveText('Paused · Needs a human');
    await controls.getByRole('button', { name: 'Resume' }).click();
    await expect(controls.getByRole('status').filter({ hasText: 'Account resumed.' })).toBeVisible();
    const after = await prisma.redditAccount.findUniqueOrThrow({ where: { id: p.accountId } });
    expect(after.pausedReason).toBeNull();
    await expect(sam.getByTestId('pause-reason')).toHaveCount(0);
  } finally {
    await prisma.redditAccount.update({
      where: { id: p.accountId },
      data: { pausedReason: null, pausedAt: null },
    });
  }
});

test('Start on an offline node queues nothing; admin assigns a node', async ({ page }) => {
  const id = await profileId('Jane · Chrome');
  const before = await prisma.browserProfile.findUniqueOrThrow({ where: { id } });
  try {
    await page.goto(`/browsers?id=${id}`);
    const controls = page.getByTestId('browser-controls');
    await expect(controls.getByTestId('node-chip')).toHaveText('Offline');
    await controls.getByRole('button', { name: 'Start' }).click();
    await expect(controls.getByRole('status').filter({ hasText: 'browser-1 is offline' })).toBeVisible();
    await expect(controls.getByRole('link', { name: 'Open browser' })).toHaveAttribute(
      'href',
      `/browsers/${id}/session`,
    );
    // Only Unassigned and the (offline) current node: no online node in the seed.
    const select = controls.getByRole('combobox', { name: 'Assign node' });
    await expect(select.locator('option')).toHaveText(['Unassigned', 'browser-1 (offline)']);
    await select.selectOption('');
    await controls.getByRole('button', { name: 'Assign' }).click();
    await expect(controls.getByRole('status').filter({ hasText: 'Profile unassigned.' })).toBeVisible();
    expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id } })).nodeId).toBeNull();
    await expect(page.locator('tr[data-profile="Jane · Chrome"]').getByTestId('node-cell')).toContainText(
      'Unassigned',
    );
  } finally {
    await prisma.browserProfile.update({ where: { id }, data: { nodeId: before.nodeId } });
  }
});

test('a saved workspace proxy can be attached to a profile', async ({ page }) => {
  const id = await profileId('Sam · Chrome');
  const before = await prisma.browserProfile.findUniqueOrThrow({ where: { id } });
  const jane = await prisma.browserProfile.findFirstOrThrow({
    where: { name: 'Jane · Chrome', workspace: { slug: 'acme' } },
  });
  try {
    await page.goto(`/browsers?id=${id}`);
    const editor = page.getByTestId('profile-editor');
    const picker = editor.getByLabel('Use a saved proxy');
    await picker.selectOption(jane.proxyId!);
    await editor.getByRole('button', { name: 'Use', exact: true }).click();
    await expect(editor.getByRole('status').filter({ hasText: 'Proxy attached.' })).toBeVisible();
    expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id } })).proxyId).toBe(jane.proxyId);
    // the picker keeps showing the proxy now in use, and the manual fields re-seed from it (a later Save
    // must not write Sam's old Oxylabs values onto Jane's proxy)
    await expect(picker).toHaveValue(jane.proxyId!);
    await expect(picker.locator('option:checked')).toContainText('in use');
    await expect(editor.getByLabel('Host')).toHaveValue('brd.superproxy.io');
    expect(await page.content()).not.toContain('tl-acme-');
  } finally {
    await prisma.browserProfile.update({ where: { id }, data: { proxyId: before.proxyId } });
  }
});

test('a viewer sees node and status but no Start, Stop, Assign or Resume', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: RHEA });
  const viewer = await ctx.newPage();
  await viewer.goto(`/browsers?id=${await profileId('Leo · Chrome')}`);
  const controls = viewer.getByTestId('browser-controls');
  await expect(controls).toContainText('browser-1');
  for (const name of ['Start', 'Stop', 'Assign', 'Resume'])
    await expect(controls.getByRole('button', { name, exact: true })).toHaveCount(0);
  await ctx.close();
});

test('a new browser with cookies, an added account with password + 2FA, then unassigned', async ({
  page,
}) => {
  const name = `e2e browser ${Date.now().toString(36)}`;
  const username = `e2e_sa_${Date.now().toString(36)}`.slice(0, 20);
  try {
    await page.goto('/browsers');
    await page.getByRole('link', { name: 'New browser' }).click();
    const form = page.getByTestId('new-browser-form');
    await form.getByLabel('Name').fill(name);
    await form.getByLabel('Cookie', { exact: true }).fill('not json');
    await form.getByRole('button', { name: 'Create browser' }).click();
    await expect(form.getByRole('status')).toContainText('Cookie must be JSON');
    await expect(form.getByLabel('Name')).toHaveValue(name); // a refused submit keeps the fields
    await form.getByLabel('Cookie', { exact: true }).fill(
      JSON.stringify([
        {
          domain: '.reddit.com',
          name: 'reddit_session',
          value: 'e2e-cookie-value',
          path: '/',
          secure: true,
        },
      ]),
    );
    await form.getByRole('button', { name: 'Create browser' }).click();
    await page.waitForURL(/\/browsers\?id=/);
    const id = new URL(page.url()).searchParams.get('id')!;
    const created = await prisma.browserProfile.findUniqueOrThrow({ where: { id } });
    expect(created.accountId).toBeNull();
    expect(created.cookiesEnc).toBeTruthy();
    expect(created.cookiesEnc).not.toContain('e2e-cookie-value');

    await expect(page.locator(`tr[data-profile="${name}"]`)).toContainText('No account');
    await expect(page.getByTestId('cookie-status')).toContainText('Pending');
    await expect(page.getByTestId('browser-settings').getByLabel('Cookie', { exact: true })).toHaveValue('');

    const section = page.getByTestId('account-section');
    const add = section.getByTestId('add-account');
    await add.getByLabel('Username').fill(username);
    await add.getByLabel('Password').fill('e2e-hunter2');
    await add.getByLabel('2FA secret').fill('GDKI AX2L WCTA C3JC');
    await add.getByRole('button', { name: 'Add account' }).click();
    await expect(section.getByTestId('account-username')).toHaveText(`u/${username}`);
    await expect(section).toContainText('Saved');
    expect(await page.content()).not.toContain('e2e-hunter2');
    const acc = await prisma.redditAccount.findFirstOrThrow({ where: { username } });
    expect(acc.loginPasswordEnc).toBeTruthy();
    expect(acc.loginPasswordEnc).not.toContain('e2e-hunter2');
    expect(acc.identifiedAt).toBeNull();

    await section.getByRole('button', { name: 'Unassign account' }).click();
    await expect(section.getByRole('status').filter({ hasText: 'Account unassigned' })).toBeVisible();
    expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id } })).accountId).toBeNull();
    // the account stays and can be assigned again from the picker
    await expect(section.getByLabel('Assign an account').locator('option')).toContainText([`u/${username}`]);
  } finally {
    // AuditEvent is append-only, so the rows cannot be deleted: move them out of the seeded workspace.
    const scratch = await prisma.workspace.create({
      data: { name: 'Test', slug: `t00-ws-e2e-${Date.now().toString(36)}` },
    });
    await prisma.browserProfile.updateMany({
      where: { name },
      data: { workspaceId: scratch.id, nodeId: null, accountId: null, createdByMemberId: null },
    });
    await prisma.redditAccount.updateMany({ where: { username }, data: { workspaceId: scratch.id } });
  }
});

test.afterAll(async () => {
  await prisma.$disconnect();
});

test('list: search, group and bulk move, quick notes, trash and restore (plan 0004)', async ({ page }) => {
  const s = Date.now().toString(36);
  const names = [`e2e list alpha ${s}`, `e2e list bravo ${s}`];
  const groupName = `e2e group ${s}`;
  const jane = await prisma.workspaceMember.findFirstOrThrow({ where: { user: { email: 'jane@acme.so' } } });
  const top = await prisma.browserProfile.aggregate({
    where: { workspaceId: jane.workspaceId },
    _max: { serial: true },
  });
  const ids: string[] = [];
  for (const [i, name] of names.entries()) {
    const p = await prisma.browserProfile.create({
      data: {
        workspaceId: jane.workspaceId,
        createdByMemberId: jane.id,
        name,
        serial: (top._max.serial ?? 0) + 1 + i,
      },
    });
    ids.push(p.id);
  }
  const alpha = page.locator(`tr[data-profile="${names[0]}"]`);
  const bravo = page.locator(`tr[data-profile="${names[1]}"]`);
  try {
    // Search narrows the list and the view stays in the URL.
    await page.goto('/browsers');
    await page.getByLabel('Search browsers').fill(`list alpha ${s}`);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page).toHaveURL(/[?&]q=/);
    await expect(alpha).toBeVisible();
    await expect(bravo).toHaveCount(0);
    await expect(page.getByTestId('list-total')).toHaveText('1 browser');

    // A new group, then both browsers moved into it with the bulk bar.
    await page.goto(`/browsers?q=${s}&manage=1`);
    const panel = page.getByTestId('groups-tags');
    await panel.getByLabel('New group name').fill(groupName);
    await panel.getByRole('button', { name: 'Add group' }).click();
    await expect(panel.getByRole('status')).toContainText('created');
    const bar = page.getByTestId('bulk-bar');
    await expect(bar.getByRole('button', { name: 'Move' })).toBeDisabled(); // nothing ticked yet
    await page.getByLabel('Select every browser on this page').check();
    await expect(bar.getByTestId('bulk-count')).toHaveText('2 selected');
    await bar.getByLabel('Group to move to').selectOption({ label: groupName });
    await bar.getByRole('button', { name: 'Move' }).click();
    await expect(bar.getByRole('status')).toContainText('Moved 2 browsers.');
    await expect(alpha).toContainText(groupName);
    await expect(bar.getByTestId('bulk-count')).toHaveText('0 selected');
    await page
      .getByTestId('list-toolbar')
      .getByLabel('Group', { exact: true })
      .selectOption({ label: `${groupName} (2)` });
    await expect(page).toHaveURL(/[?&]group=/);
    await expect(page.getByTestId('profile-table').locator('tbody tr')).toHaveCount(2);

    // Notes, edited in the row.
    const notes = alpha.getByLabel('Notes', { exact: true });
    await expect(async () => {
      // the filter just navigated: click again if the row was not interactive yet
      if (!(await notes.isVisible())) await alpha.getByRole('button', { name: 'Edit notes' }).click();
      await expect(notes).toBeVisible({ timeout: 1000 });
    }).toPass();
    await notes.fill('warmed up in March');
    await alpha.getByRole('button', { name: 'Save' }).click();
    await expect(alpha).toContainText('warmed up in March');
    expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id: ids[0] } })).notes).toBe(
      'warmed up in March',
    );

    // Delete goes to the trash; the trash restores it.
    await alpha.getByLabel(`Select ${names[0]}`).check();
    await bar.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(bar.getByRole('status')).toContainText('Moved 1 browser to the trash');
    await expect(alpha).toHaveCount(0);
    expect(
      (await prisma.browserProfile.findUniqueOrThrow({ where: { id: ids[0] } })).deletedAt,
    ).not.toBeNull();
    await page.getByTestId('trash-link').click();
    await expect(page.getByRole('heading', { name: 'Trash' })).toBeVisible();
    await expect(alpha).toContainText('30 days left');
    await alpha.getByLabel(`Select ${names[0]}`).check();
    await page.getByTestId('bulk-bar').getByRole('button', { name: 'Restore' }).click();
    await expect(page.getByTestId('bulk-bar').getByRole('status')).toContainText('Restored 1 browser.');
    const restored = await prisma.browserProfile.findUniqueOrThrow({
      where: { id: ids[0] },
      include: { group: true },
    });
    expect(restored.deletedAt).toBeNull();
    expect(restored.group?.name).toBe(groupName); // back as it was
  } finally {
    // AuditEvent is append-only, so the rows cannot be deleted: move them out of the seeded workspace.
    const scratch = await prisma.workspace.create({
      data: { name: 'Test', slug: `t00-ws-e2e-list-${s}` },
    });
    for (const id of ids)
      await prisma.browserProfile.update({
        where: { id },
        data: { workspaceId: scratch.id, createdByMemberId: null, groupId: null, tags: { set: [] } },
      });
    await prisma.browserGroup.deleteMany({ where: { name: groupName } });
  }
});

test('a viewer can search the list but has no checkboxes to tick and no bulk bar', async ({ browser }) => {
  const ctx = await browser.newContext({ storageState: RHEA });
  const page = await ctx.newPage();
  await page.goto('/browsers');
  await expect(page.getByTestId('list-toolbar')).toBeVisible();
  await expect(page.getByTestId('bulk-bar')).toHaveCount(0);
  await expect(page.getByTestId('profile-table').locator('tbody input[name="ids"]:enabled')).toHaveCount(0);
  await ctx.close();
});
