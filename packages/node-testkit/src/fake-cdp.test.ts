import { type Browser, type Page, chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type FakeCdpTarget, canLaunchChromium, startFakeCdpTarget } from './fake-cdp';
import { FIXTURE_IDS } from './fixtures';

// Needs Playwright's bundled Chromium (`pnpm --filter @threadline/web exec playwright install chromium-headless-shell`).
const available = await canLaunchChromium();
if (!available) console.warn('node-testkit: no launchable Chromium, skipping startFakeCdpTarget tests');

describe.skipIf(!available)('startFakeCdpTarget', { timeout: 30_000 }, () => {
  let target: FakeCdpTarget;
  let browser: Browser;
  let page: Page;
  const pageErrors: string[] = [];

  beforeAll(async () => {
    target = await startFakeCdpTarget();
    // Same call the node agent makes against tl-profile-<id>:9222.
    browser = await chromium.connectOverCDP(target.cdpUrl);
    const ctx = browser.contexts()[0]!;
    page = ctx.pages()[0] ?? (await ctx.newPage());
    page.setDefaultTimeout(5_000);
    page.on('pageerror', (e) => pageErrors.push(e.message));
  });

  afterEach(() => {
    target.setWall(null);
    // Fixture scripts must run cleanly, or actions would be tested against a broken page.
    expect(pageErrors.splice(0)).toEqual([]);
  });

  afterAll(async () => {
    await browser?.close();
    await target?.close();
  });

  it('exposes a CDP endpoint on 127.0.0.1', async () => {
    expect(target.cdpUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const version = (await (await fetch(`${target.cdpUrl}/json/version`)).json()) as Record<string, string>;
    expect(version.webSocketDebuggerUrl).toMatch(/^ws:\/\/127\.0\.0\.1/);
  });

  it('posts a top-level comment on the thread and shows its fullname', async () => {
    await page.goto(target.urls.thread);
    await expect(page.title()).resolves.toContain('Asana alternative');
    await page.getByRole('button', { name: 'Join the conversation' }).click();
    await page.getByRole('textbox', { name: 'Add a comment' }).fill('Try a simple kanban board first.');
    await page.locator('#top-level-composer [slot="submit-button"]').click();
    const sub = await target.submissions.waitFor((s) => s.kind === 'comment');
    expect(sub).toMatchObject({ parent: FIXTURE_IDS.postFullname, text: 'Try a simple kanban board first.' });
    const posted = page.locator(`shreddit-comment[thingid="${sub.fullname}"]`);
    await expect(posted.getAttribute('author')).resolves.toBe(FIXTURE_IDS.username);
    expect(sub.fullname).toMatch(/^t1_[a-z0-9]+$/);
  });

  it('replies to a comment from the thread', async () => {
    await page.goto(target.urls.thread);
    const parent = page.locator('shreddit-comment[thingid="t1_kx1aa01"]');
    await parent.getByRole('button', { name: 'Reply' }).click();
    await parent.getByRole('textbox', { name: 'Add a reply' }).fill('Same here.');
    await parent.locator('[slot="submit-button"]').click();
    const sub = await target.submissions.waitFor((s) => s.kind === 'comment' && s.parent === 't1_kx1aa01');
    await expect(parent.locator(`shreddit-comment[thingid="${sub.fullname}"]`).count()).resolves.toBe(1);
  });

  it('serves the comment permalink with the reply box open', async () => {
    await page.goto(target.urls.commentPermalink);
    const box = page.getByRole('textbox', { name: 'Add a reply' });
    await expect(box.isVisible()).resolves.toBe(true);
    await box.fill('Usually four or five.');
    await page.locator('shreddit-comment [slot="submit-button"]').click();
    await expect(
      target.submissions.waitFor((s) => s.kind === 'comment' && s.text === 'Usually four or five.'),
    ).resolves.toMatchObject({ parent: 't1_kx1aa02' });
  });

  it('shows an error when the submit fails', async () => {
    target.failNextSubmit(500);
    await page.goto(target.urls.thread);
    await page.getByRole('button', { name: 'Join the conversation' }).click();
    await page.getByRole('textbox', { name: 'Add a comment' }).fill('x');
    await page.locator('#top-level-composer [slot="submit-button"]').click();
    await expect(page.getByRole('alert').textContent()).resolves.toContain('Something went wrong');
  });

  it('sends a DM and shows the message fullname', async () => {
    await page.goto(`${target.urls.dmCompose}?to=testkit_user_a`);
    await expect(page.locator('#to').inputValue()).resolves.toBe('testkit_user_a');
    await page.fill('#subject', 'Hi');
    await page.fill('#text', 'Hello there');
    await page.click('#send');
    const status = page.getByRole('status');
    await page.waitForFunction(() => document.querySelector('.status')?.textContent?.includes('delivered'));
    const sub = await target.submissions.waitFor((s) => s.kind === 'dm');
    expect(sub).toMatchObject({ to: 'testkit_user_a', subject: 'Hi', text: 'Hello there' });
    await expect(status.getAttribute('data-message-id')).resolves.toBe(sub.fullname);
  });

  it('login wall: content pages redirect to /login/ with dest', async () => {
    target.setWall('login');
    await page.goto(target.urls.thread);
    expect(new URL(page.url()).pathname).toBe('/login/');
    expect(new URL(page.url()).searchParams.get('dest')).toContain('/comments/');
    await expect(page.title()).resolves.toBe('Log In | Reddit');
    await expect(page.locator('input[type="password"]').count()).resolves.toBe(1);
  });

  it('verification wall: content pages redirect to /account/verify/', async () => {
    target.setWall('verification');
    await page.goto(target.urls.dmCompose);
    expect(new URL(page.url()).pathname).toBe('/account/verify/');
    await expect(page.locator('input[autocomplete="one-time-code"]').count()).resolves.toBe(1);
  });

  it('captcha wall: served in place and submits are refused', async () => {
    target.setWall('captcha');
    await page.goto(target.urls.thread);
    expect(page.url()).toBe(target.urls.thread);
    await expect(page.locator('iframe[title="reCAPTCHA"]').count()).resolves.toBe(1);
    const status = await page.evaluate(
      async () => (await fetch('/svc/shreddit/comment', { method: 'POST' })).status,
    );
    expect(status).toBe(403);
  });

  it('reports the page exit IP to an in-page fetch', async () => {
    target.setPageIp('198.51.100.7');
    await page.goto(target.urls.thread);
    const ip = await page.evaluate(async () => ((await (await fetch('/ip')).json()) as { ip: string }).ip);
    expect(ip).toBe('198.51.100.7');
  });
});
