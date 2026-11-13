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

test('fingerprint: settings save and reach the start command; a new fingerprint needs a confirmation (plan 0004)', async ({
  page,
}) => {
  const s = Date.now().toString(36);
  const name = `e2e fp ${s}`;
  const jane = await prisma.workspaceMember.findFirstOrThrow({ where: { user: { email: 'jane@acme.so' } } });
  const { browsers } = await import('@threadline/db');
  const { profileId } = await browsers.createBrowser({
    workspaceId: jane.workspaceId,
    actorMemberId: jane.id,
    name,
    fingerprint: { os: 'Windows 11', screen: '1920x1080', tz: 'America/New_York', locale: 'en-US' },
  });
  // No node: a new fingerprint has no data to delete and is assigned at once.
  await prisma.browserProfile.update({ where: { id: profileId }, data: { nodeId: null } });
  try {
    await page.goto(`/browsers?id=${profileId}`);
    const fp = page.getByTestId('fingerprint');
    await expect(fp).toContainText('Windows · Intel graphics');
    await fp.getByLabel('Screen').fill('1600x900');
    await fp.getByLabel('CPU cores').selectOption('8');
    await fp.getByLabel('Memory').selectOption('4');
    await fp.getByLabel('Time zone', { exact: true }).selectOption('proxy');
    await expect(fp).toContainText('No proxy test yet');
    await fp.getByLabel('Canvas, WebGL and audio noise').uncheck();
    await fp.getByRole('button', { name: 'Save fingerprint' }).click();
    await expect(fp.getByRole('status')).toContainText('Saved');
    const sent = await browsers.getProfileForDispatch(jane.workspaceId, profileId);
    expect(sent).toMatchObject({
      screen: '1600x900',
      tz: 'America/New_York', // no proxy test yet: the stored zone
      device: { cpu: 8, memoryGb: 4, noise: false, webrtc: { mode: 'disable_udp' } },
    });
    // A bad value is refused with a reason and nothing is stored.
    await fp.getByLabel('Screen').fill('huge');
    await fp.getByRole('button', { name: 'Save fingerprint' }).click();
    await expect(fp.getByRole('status')).toContainText('Screen must look like');

    const before = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
    await fp.getByText('New fingerprint', { exact: true }).first().click();
    await fp.getByLabel('Graphics').selectOption('nvidia');
    await fp.getByRole('button', { name: 'New fingerprint' }).click();
    await expect(fp.getByRole('status').last()).toContainText('Tick the box first');
    expect((await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } })).cloakSeed).toBe(
      before.cloakSeed,
    );
    await fp.getByLabel('Delete this browser’s cookies and sign-in').check();
    await fp.getByRole('button', { name: 'New fingerprint' }).click();
    await expect(fp.getByRole('status').last()).toContainText('New fingerprint assigned');
    const after = await prisma.browserProfile.findUniqueOrThrow({ where: { id: profileId } });
    expect(after.cloakSeed).not.toBe(before.cloakSeed);
    expect(after.cloakGpu).toBe('nvidia');
    await expect(fp).toContainText('Windows · NVIDIA graphics');
  } finally {
    const scratch = await prisma.workspace.create({ data: { name: 'Test', slug: `t00-ws-e2e-fp-${s}` } });
    await prisma.browserProfile.update({
      where: { id: profileId },
      data: { workspaceId: scratch.id, createdByMemberId: null, nodeId: null },
    });
  }
});

test('proxy pool: bulk add, search, edit without re-typing the login, delete (plan 0004)', async ({
  page,
}) => {
  const s = Date.now().toString(36);
  const host = `gate-${s}.pool.test`;
  const jane = await prisma.workspaceMember.findFirstOrThrow({ where: { user: { email: 'jane@acme.so' } } });
  try {
    await page.goto('/browsers');
    await page.getByRole('link', { name: 'Proxy pool' }).click();
    await expect(page.getByRole('heading', { name: 'Proxy pool' })).toBeVisible();

    const add = page.getByTestId('add-proxies');
    const lines = add.getByLabel(/One proxy per line/);
    await lines.fill(
      [
        `${host}:7000:e2e-user-1:e2e-pool-pass-1{first one}`,
        `socks5://e2e-user-2:e2e-pool-pass-2@${host}:7001 [https://vendor.test/rotate?token=e2e-link-token]`,
        'this is not a proxy',
      ].join('\n'),
    );
    await add.getByRole('button', { name: 'Add proxies' }).click();
    const status = add.getByRole('status');
    await expect(status).toContainText('Added 2 proxies.');
    await expect(status).toContainText('line 3');
    // Nothing that was pasted is echoed back or left in the box.
    await expect(lines).toHaveValue('');
    expect(await page.content()).not.toMatch(/e2e-pool-pass|e2e-link-token/);

    const stored = await prisma.proxy.findMany({ where: { host }, orderBy: { port: 'asc' } });
    expect(stored.map((p) => [p.protocol, p.port, p.notes])).toEqual([
      ['http', 7000, 'first one'],
      ['socks5', 7001, null],
    ]);
    expect(stored[0]?.passwordEnc).toBeTruthy();
    expect(stored[0]?.passwordEnc).not.toContain('e2e-pool-pass-1');
    expect(stored[1]?.refreshUrlEnc).not.toContain('e2e-link-token');

    // Search, then edit the name and port: the login stays although its fields were left empty.
    await page.getByLabel('Search proxies').fill(host);
    await page.getByRole('button', { name: 'Search' }).click();
    await expect(page.getByTestId('pool-total')).toHaveText('2 proxies');
    const first = page.locator(`tr[data-proxy="${host}:7000"]`);
    await expect(first).toContainText('Not checked');
    await expect(first).toContainText('first one');
    await first.getByRole('link', { name: 'Edit' }).click();
    const edit = page.getByTestId('edit-proxy');
    await expect(edit.locator('form[data-ready="true"]')).toBeVisible(); // interactive before typing
    await expect(edit.getByLabel('Password')).toHaveValue('');
    await edit.getByLabel('Name', { exact: true }).fill(`e2e pool ${s}`);
    await edit.getByLabel('Port').fill('70000');
    await edit.getByRole('button', { name: 'Save proxy' }).click();
    await expect(edit.getByRole('status')).toContainText('Port must be 1 to 65535');
    await expect(edit.getByLabel('Name', { exact: true })).toHaveValue(`e2e pool ${s}`); // a refused save keeps what was typed
    await edit.getByLabel('Port').fill('7002');
    await edit.getByRole('button', { name: 'Save proxy' }).click();
    await expect(page).toHaveURL(/saved=1/);
    const edited = await prisma.proxy.findUniqueOrThrow({ where: { id: stored[0]!.id } });
    expect(edited).toMatchObject({ label: `e2e pool ${s}`, port: 7002 });
    expect(edited.passwordEnc).toBe(stored[0]?.passwordEnc);

    // Delete both with the bulk bar.
    await page.goto(`/browsers/proxies?q=${host}`);
    const bar = page.getByTestId('proxy-bulk-bar');
    await page.getByLabel('Select every proxy').check();
    await expect(bar.getByTestId('proxy-count')).toHaveText('2 selected');
    await bar.getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(bar.getByRole('status')).toContainText('Deleted 2 proxies.');
    expect(await prisma.proxy.count({ where: { host } })).toBe(0);
  } finally {
    await prisma.proxy.deleteMany({ where: { workspaceId: jane.workspaceId, host } });
  }
});

test('quick create, more start tabs, cookies.txt import, CSV export and import (plan 0004)', async ({
  page,
}) => {
  const s = Date.now().toString(36);
  const base = `e2e batch ${s}`;
  const jane = await prisma.workspaceMember.findFirstOrThrow({ where: { user: { email: 'jane@acme.so' } } });
  const groupName = `e2e imp ${s}`;
  try {
    // Three numbered browsers from one form.
    await page.goto('/browsers/new');
    await page.waitForLoadState('networkidle'); // the forms are controlled: type only once interactive
    const form = page.getByTestId('new-browser-form');
    await form.getByLabel('How many').fill('3');
    await form.getByRole('button', { name: 'Create 3 browsers' }).click();
    await expect(form.getByRole('status')).toContainText('Give the browsers a name');
    await form.getByLabel('Name').fill(base);
    await form
      .getByLabel('More start tabs')
      .fill('https://mail.example.com/\nhttps://www.reddit.com/message/inbox');
    await form.getByLabel('Notes').fill('made in one go');
    await form.getByRole('button', { name: 'Create 3 browsers' }).click();
    await page.waitForURL(/\/browsers\?q=/);
    await expect(page.getByTestId('list-total')).toHaveText('3 browsers');
    const made = await prisma.browserProfile.findMany({
      where: { workspaceId: jane.workspaceId, name: { startsWith: base } },
      orderBy: { serial: 'asc' },
    });
    expect(made.map((b) => b.name)).toEqual([`${base} 1`, `${base} 2`, `${base} 3`]);
    expect(new Set(made.map((b) => b.cloakSeed)).size).toBe(3); // three different devices
    expect(made[0]?.extraStartUrls).toEqual([
      'https://mail.example.com/',
      'https://www.reddit.com/message/inbox',
    ]);
    expect(made[0]?.notes).toBe('made in one go');

    // The drawer imports a cookies.txt file and edits the extra tabs.
    await page.goto(`/browsers?id=${made[0]!.id}`);
    const settings = page.getByTestId('browser-settings');
    await expect(settings.getByLabel('More start tabs')).toHaveValue(
      'https://mail.example.com/\nhttps://www.reddit.com/message/inbox',
    );
    // The field is controlled: typing before the page is interactive gets the saved text put back around it.
    await expect(async () => {
      await settings.getByLabel('More start tabs').fill('https://shop.example.com/');
      await page.waitForTimeout(300);
      await expect(settings.getByLabel('More start tabs')).toHaveValue('https://shop.example.com/', {
        timeout: 500,
      });
    }).toPass();
    await settings
      .getByLabel('Cookie', { exact: true })
      .fill(
        '# Netscape HTTP Cookie File\n.reddit.com\tTRUE\t/\tTRUE\t1798000000\treddit_session\te2e-txt-cookie-value',
      );
    await settings.getByRole('button', { name: 'Save start tab and cookies' }).click();
    await expect(settings.getByRole('status')).toContainText('1 cookie for reddit.com');
    const saved = await prisma.browserProfile.findUniqueOrThrow({ where: { id: made[0]!.id } });
    expect(saved.extraStartUrls).toEqual(['https://shop.example.com/']);
    expect(saved.cookiesEnc).toBeTruthy();
    expect(saved.cookiesEnc).not.toContain('e2e-txt-cookie-value');

    // No node holds this browser, so an export says why instead of spinning.
    await prisma.browserProfile.update({ where: { id: made[0]!.id }, data: { nodeId: null } });
    const tools = page.getByTestId('cookie-tools');
    await tools.getByRole('button', { name: 'Export cookies' }).click();
    await expect(tools.getByRole('alert')).toContainText('no browser node');
    await tools.getByRole('button', { name: 'Clear cookies' }).click();
    await expect(tools.getByRole('status')).toContainText('Tick the box first');

    // The CSV export of the filtered list has no secrets and is what the import reads.
    const res = await page.request.get(`/browsers/export?q=${encodeURIComponent(base)}`);
    expect(res.headers()['content-type']).toContain('text/csv');
    const csv = await res.text();
    expect(csv.split('\r\n')[0]).toBe('name,group,tags,notes,start_url,proxy,number,account,status,created');
    expect(csv).toContain(`${base} 1,`);
    expect(csv).toContain('made in one go');
    expect(csv).not.toMatch(/e2e-txt-cookie-value|cookiesEnc|passwordEnc/);

    // Import two rows; the missing group and tag are created.
    await page.goto('/browsers/new');
    await page.waitForLoadState('networkidle'); // the forms are controlled: type only once interactive
    const imp = page.getByTestId('import-browsers');
    await imp.getByLabel('CSV text').fill(`name,group,tags\n${base} imported\n,${groupName},x`);
    await imp.getByRole('button', { name: 'Import browsers' }).click();
    await expect(imp.getByRole('status')).toContainText('Line 3: a browser needs a name');
    expect(await prisma.browserProfile.count({ where: { name: `${base} imported` } })).toBe(0); // nothing half-done
    await imp
      .getByLabel('CSV text')
      .fill(`name,group,tags,notes\n${base} imported,${groupName},e2e-${s};warm-${s},"with, a comma"`);
    await imp.getByRole('button', { name: 'Import browsers' }).click();
    await expect(imp.getByRole('status')).toContainText('Imported 1 browser.');
    const imported = await prisma.browserProfile.findFirstOrThrow({
      where: { name: `${base} imported` },
      include: { group: true, tags: true },
    });
    expect(imported.group?.name).toBe(groupName);
    expect(imported.tags.map((t) => t.name).sort()).toEqual([`e2e-${s}`, `warm-${s}`]);
    expect(imported.notes).toBe('with, a comma');
  } finally {
    const scratch = await prisma.workspace.create({ data: { name: 'Test', slug: `t00-ws-e2e-batch-${s}` } });
    for (const b of await prisma.browserProfile.findMany({ where: { name: { startsWith: base } } }))
      await prisma.browserProfile.update({
        where: { id: b.id },
        data: {
          workspaceId: scratch.id,
          createdByMemberId: null,
          nodeId: null,
          groupId: null,
          tags: { set: [] },
        },
      });
    await prisma.browserGroup.deleteMany({ where: { name: groupName } });
    await prisma.browserTag.deleteMany({ where: { name: { in: [`e2e-${s}`, `warm-${s}`] } } });
  }
});

test('an admin gives a member access to a group; a viewer never sees the access editor (plan 0004)', async ({
  page,
  browser,
}) => {
  const s = Date.now().toString(36);
  const groupName = `e2e access ${s}`;
  const jane = await prisma.workspaceMember.findFirstOrThrow({ where: { user: { email: 'jane@acme.so' } } });
  const helper = await prisma.workspaceMember.findFirstOrThrow({
    where: { workspaceId: jane.workspaceId, role: { in: ['editor', 'approver'] } },
    include: { user: true },
  });
  const group = await prisma.browserGroup.create({
    data: { workspaceId: jane.workspaceId, name: groupName },
  });
  try {
    await page.goto('/browsers?manage=1');
    await page.waitForLoadState('networkidle');
    const row = page.locator(`li[data-group="${groupName}"]`);
    await row.getByText('Access: owners and admins only').click();
    await expect(row).toContainText('cannot take a browser over');
    await row.getByLabel(helper.user.name ?? helper.user.email).check();
    await row.getByRole('button', { name: 'Save access' }).click();
    await expect(row.getByTestId('group-access').locator('summary')).toContainText('Access: 1 member');
    expect(await prisma.browserGroupMember.findMany({ where: { groupId: group.id } })).toMatchObject([
      { memberId: helper.id },
    ]);

    const ctx = await browser.newContext({ storageState: RHEA });
    const viewer = await ctx.newPage();
    await viewer.goto('/browsers?manage=1');
    await expect(viewer.locator(`li[data-group="${groupName}"]`)).toBeVisible();
    await expect(viewer.getByTestId('group-access')).toHaveCount(0);
    await ctx.close();
  } finally {
    await prisma.browserGroup.deleteMany({ where: { id: group.id } });
  }
});

test('management API: a key lists and creates browsers, cannot do more, and stops when revoked (plan 0004)', async ({
  page,
  request,
}) => {
  const s = Date.now().toString(36);
  const keyName = `e2e key ${s}`;
  const browserName = `e2e api ${s}`;
  try {
    await page.goto('/browsers');
    await page.getByRole('link', { name: 'API', exact: true }).click();
    await page.waitForLoadState('networkidle');
    const box = page.getByTestId('new-api-key');
    await box.getByLabel('Key name').fill(keyName);
    await box.getByRole('button', { name: 'Create key' }).click();
    await expect(box.getByRole('status')).toContainText('Copy it now');
    const key = await box.getByTestId('api-key-value').inputValue();
    expect(key).toMatch(/^tl_/);
    // Stored as a hash only.
    const stored = await prisma.apiKey.findFirstOrThrow({ where: { name: keyName } });
    expect(JSON.stringify(stored)).not.toContain(key);

    const auth = { headers: { authorization: `Bearer ${key}` } };
    // No key, a wrong key and a session cookie alone are all refused.
    expect((await request.get('/api/v1/browsers', { headers: { cookie: '' } })).status()).toBe(401);
    expect(
      (await request.get('/api/v1/browsers', { headers: { authorization: 'Bearer tl_nope' } })).status(),
    ).toBe(401);

    const list = await request.get('/api/v1/browsers', auth);
    expect(list.status()).toBe(200);
    const body = await list.json();
    expect(body.total).toBeGreaterThanOrEqual(3);
    const text = JSON.stringify(body);
    expect(text).not.toMatch(/cookiesEnc|passwordEnc|usernameEnc|cloakSeed|fingerprint/);

    const made = await request.post('/api/v1/browsers', {
      ...auth,
      data: { name: browserName, notes: 'from the API' },
    });
    expect(made.status()).toBe(201);
    const id = (await made.json()).browser.id as string;
    expect((await request.get(`/api/v1/browsers/${id}`, auth)).status()).toBe(200);
    expect((await request.post('/api/v1/browsers', { ...auth, data: {} })).status()).toBe(400);
    // Start on a browser whose node is not online: refused with a reason, nothing queued.
    await prisma.browserProfile.update({ where: { id }, data: { nodeId: null } });
    const start = await request.post(`/api/v1/browsers/${id}/start`, auth);
    expect(start.status()).toBe(409);
    expect((await start.json()).error.code).toBe('not_queued');
    // There is no automation, cookie or take-over endpoint.
    for (const path of [
      `/api/v1/browsers/${id}/cookies`,
      `/api/v1/browsers/${id}/cdp`,
      `/api/v1/browsers/${id}/post`,
    ])
      expect([404, 405]).toContain((await request.post(path, auth)).status());
    expect((await request.get('/api/v1/groups', auth)).status()).toBe(200);
    const proxies = await request.get('/api/v1/proxies', auth);
    expect(JSON.stringify(await proxies.json())).not.toMatch(/password|usernameEnc|refreshUrl/);

    await page.reload();
    await page
      .locator(`tr[data-key="${keyName}"]`)
      .getByRole('button', { name: `Revoke ${keyName}` })
      .click();
    await expect(page.locator(`tr[data-key="${keyName}"]`)).toContainText('Revoked');
    expect((await request.get('/api/v1/browsers', auth)).status()).toBe(401);
  } finally {
    const scratch = await prisma.workspace.create({ data: { name: 'Test', slug: `t00-ws-e2e-api-${s}` } });
    await prisma.browserProfile.updateMany({
      where: { name: browserName },
      data: { workspaceId: scratch.id, createdByMemberId: null, nodeId: null },
    });
    await prisma.apiKey.deleteMany({ where: { name: keyName } });
  }
});
