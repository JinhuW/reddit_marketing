import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { type FakeCdpTarget, canLaunchChromium, startFakeCdpTarget } from '@threadline/node-testkit/fake-cdp';
import { FakeGateway } from '@threadline/node-testkit/fake-gateway';
import { FIXTURE_IDS } from '@threadline/node-testkit/fixtures';
import type { CmdOf, Result } from '@threadline/shared';
import { PostedData } from '@threadline/shared';
import { chromium } from 'playwright-core';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { type Agent, startAgent } from '../agent';
import { actionsModule } from '../handlers/actions';
import { SecretSet, createLogger } from '../log';
import type { HandlerContext, HandlerResult } from '../registry';
import { StatusStore } from '../status';
import { testConfig } from '../testing/helpers';
import { type ActionOptions, ProfileProxies, createActionHandlers } from './index';
import { comment as commentSel, dm as dmSel } from './selectors';
import { recipientName, sendDm as runSendDm } from './send-dm';
import { ActionError, type Session, openSession } from './session';
import { permalink, submitComment as runSubmitComment } from './submit-comment';
import { parseIp } from './test-proxy';

const available = await canLaunchChromium();
if (!available) console.warn('node-agent actions: no launchable Chromium, skipping CDP action tests');

const log = createLogger({ level: 'silent' });

function ctx(deadlineMs = 20_000): HandlerContext {
  return {
    cmdId: `bj-test-${Math.random().toString(36).slice(2)}`,
    signal: new AbortController().signal,
    deadlineAt: Date.now() + deadlineMs,
    log,
    config: testConfig(),
    status: new StatusStore(8),
    secrets: new SecretSet(),
  };
}

const PROFILE = 'prof_1';

/**
 * Wraps a Playwright object so that `click()` on any locator whose chain used `selector` runs `onClick` (which
 * gets the real click) instead. Lets a test make the submit click itself fail at a chosen moment.
 */
function hookClick<T extends object>(
  obj: T,
  selector: string,
  onClick: (real: () => Promise<void>) => Promise<void>,
  hit = false,
): T {
  return new Proxy(obj, {
    get(t, prop) {
      const v: unknown = Reflect.get(t, prop, t);
      if (typeof v !== 'function') return v;
      return (...args: unknown[]) => {
        if (prop === 'click' && hit)
          return onClick(() => (v as (...a: unknown[]) => Promise<void>).apply(t, args));
        const out: unknown = (v as (...a: unknown[]) => unknown).apply(t, args);
        const isLocator =
          out !== null &&
          typeof out === 'object' &&
          typeof (out as { click?: unknown }).click === 'function' &&
          typeof (out as { locator?: unknown }).locator === 'function';
        return isLocator ? hookClick(out as object, selector, onClick, hit || args.includes(selector)) : out;
      };
    },
  });
}

function hookSession(
  session: Session,
  selector: string,
  onClick: (real: () => Promise<void>) => Promise<void>,
): Session {
  return { ...session, page: hookClick(session.page, selector, onClick) };
}

describe('pure helpers', () => {
  it('builds a comment permalink from the thread URL', () => {
    expect(permalink('https://www.reddit.com/r/x/comments/1abc/slug/?utm=1#c', 't1_kx1aa02')).toBe(
      'https://www.reddit.com/r/x/comments/1abc/slug/kx1aa02/',
    );
    expect(permalink('https://www.reddit.com/r/x/comments/1abc/slug', 't1_zz')).toBe(
      'https://www.reddit.com/r/x/comments/1abc/slug/zz/',
    );
  });

  it('normalises DM recipients', () => {
    expect(recipientName('u/testkit_user_b')).toBe('testkit_user_b');
    expect(recipientName('/u/testkit_user_b')).toBe('testkit_user_b');
    expect(recipientName('/user/testkit_user_b')).toBe('testkit_user_b');
    expect(recipientName(' testkit_user_b ')).toBe('testkit_user_b');
  });

  it('reads an IP from ipify JSON or plain text', () => {
    expect(parseIp('{"ip":"198.51.100.7"}')).toBe('198.51.100.7');
    expect(parseIp('2001:db8::1\n')).toBe('2001:db8::1');
    expect(parseIp('<html>nope</html>')).toBeNull();
  });

  it('records proxy passwords as secrets', () => {
    const store = new ProfileProxies();
    const secrets = new SecretSet();
    store.set('p', { protocol: 'http', host: 'h', port: 1, username: 'u', password: 'pa55word' }, secrets);
    expect(secrets.scrub('x pa55word y')).toBe('x [Redacted] y');
    expect(store.lookup('p')?.host).toBe('h');
    expect(store.lookup('other')).toBeUndefined();
    store.delete('p');
    expect(store.lookup('p')).toBeUndefined();
  });

  it('registers all five action kinds in the agent module', () => {
    expect(Object.keys(actionsModule.handlers).sort()).toEqual([
      'action.sendDm',
      'action.submitComment',
      'profile.signIn',
      'profile.testProxy',
      'profile.whoami',
    ]);
  });

  it('never uses context.request / APIRequestContext (it skips the credentialed proxy)', () => {
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const files = [
      ...readdirSync(dir).map((f) => join(dir, f)),
      fileURLToPath(new URL('../handlers/actions.ts', import.meta.url)),
    ].filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'));
    expect(files.length).toBeGreaterThan(5);
    for (const f of files) {
      const src = readFileSync(f, 'utf8').replace(/\/\*[\s\S]*?\*\/|\/\/.*$/gm, '');
      expect(src, f).not.toMatch(/\.request\s*\.\s*(get|post|put|fetch|delete|patch)\b|APIRequestContext/);
    }
  });
});

describe.skipIf(!available)('actions over CDP', { timeout: 60_000 }, () => {
  let target: FakeCdpTarget;
  let handlers: ReturnType<typeof createActionHandlers>;
  let opts: ActionOptions;

  beforeAll(async () => {
    target = await startFakeCdpTarget();
    opts = {
      cdpUrlFor: () => target.cdpUrl,
      proxyFor: () => null,
      redditOrigin: target.baseUrl,
      ipUrl: target.urls.ip,
      stepTimeoutMs: 8_000,
      confirmTimeoutMs: 5_000,
    };
    handlers = createActionHandlers(opts);
  });

  afterEach(() => {
    target.setWall(null);
  });

  afterAll(async () => {
    await target?.close();
  });

  const comment = (over: Partial<CmdOf<'action.submitComment'>> = {}): CmdOf<'action.submitComment'> => ({
    kind: 'action.submitComment',
    profileId: PROFILE,
    draftId: 'draft_1',
    threadUrl: target.urls.thread,
    parentFullname: FIXTURE_IDS.postFullname,
    body: 'We use a plain kanban board; it is plenty for six people.',
    ...over,
  });
  const dm = (over: Partial<CmdOf<'action.sendDm'>> = {}): CmdOf<'action.sendDm'> => ({
    kind: 'action.sendDm',
    profileId: PROFILE,
    draftId: 'draft_2',
    to: 'u/testkit_user_b',
    subject: 'Kanban tools',
    body: 'Happy to share the board template we use.',
    ...over,
  });
  const submitComment = (c: CmdOf<'action.submitComment'>) => handlers['action.submitComment']!(c, ctx());
  const sendDm = (c: CmdOf<'action.sendDm'>) => handlers['action.sendDm']!(c, ctx());

  async function openPages(): Promise<string[]> {
    const b = await chromium.connectOverCDP(target.cdpUrl);
    try {
      return b.contexts().flatMap((c) => c.pages().map((p) => p.url()));
    } finally {
      await b.close();
    }
  }

  function expectPosted(r: HandlerResult, prefix: 't1_' | 't4_'): string {
    expect(r.error).toBeUndefined();
    expect(r.outcome).toBe('posted');
    const { fullname } = PostedData.parse(r.data);
    expect(fullname.startsWith(prefix)).toBe(true);
    return fullname;
  }

  it('posts a top-level comment on the thread and returns its fullname', async () => {
    const from = target.submissions.items.length;
    const r = await submitComment(comment());
    const fullname = expectPosted(r, 't1_');
    const sub = target.submissions.items.slice(from);
    expect(sub).toEqual([
      { kind: 'comment', parent: FIXTURE_IDS.postFullname, text: comment().body, fullname },
    ]);
    // The action closed its tab and only disconnected: the profile's browser is still up.
    expect(await openPages()).not.toContain(target.urls.thread);
  });

  it('replies to a comment through its Reply button', async () => {
    const from = target.submissions.items.length;
    const parent = FIXTURE_IDS.commentFullnames[1];
    const r = await submitComment(comment({ parentFullname: parent, body: 'Usually 4 to 6 at once.' }));
    const fullname = expectPosted(r, 't1_');
    expect(target.submissions.items.slice(from)).toEqual([
      { kind: 'comment', parent, text: 'Usually 4 to 6 at once.', fullname },
    ]);
  });

  it('falls back to the comment permalink and reports a missing parent', async () => {
    const from = target.requests.items.length;
    const r = await submitComment(comment({ parentFullname: 't1_zzz999' }));
    expect(r.outcome).toBe('error');
    expect(r.error?.code).toBe('parent_not_found');
    expect(target.requests.items.slice(from)).toContain(`GET ${new URL(target.urls.thread).pathname}zzz999/`);
  });

  it.each(['verification', 'login', 'captcha'] as const)(
    'stops at a %s wall with needs_human and leaves the tab for the take-over',
    async (wall) => {
      target.setWall(wall);
      const from = target.submissions.items.length;
      const r = await submitComment(comment());
      expect(r.outcome).toBe('needs_human');
      expect(r.data).toEqual({ wall, submitted: false });
      expect(r.error?.code).toBe(`${wall}_wall`);
      expect(target.submissions.items.length).toBe(from);
      const pages = await openPages();
      if (wall === 'verification') expect(pages.some((u) => u.startsWith(target.urls.verify))).toBe(true);
      if (wall === 'login') expect(pages.some((u) => u.startsWith(target.urls.login))).toBe(true);
      if (wall === 'captcha') expect(pages).toContain(target.urls.thread);
    },
  );

  it('reports a rejected comment without claiming it was posted', async () => {
    target.failNextSubmit(500);
    const r = await submitComment(comment());
    expect(r.outcome).toBe('error');
    expect(r.error?.code).toBe('submit_rejected');
  });

  it('sends a DM and returns the message fullname', async () => {
    const from = target.submissions.items.length;
    const r = await sendDm(dm());
    const fullname = expectPosted(r, 't4_');
    expect(target.submissions.items.slice(from)).toEqual([
      {
        kind: 'dm',
        to: 'testkit_user_b',
        subject: 'Kanban tools',
        text: 'Happy to share the board template we use.',
        fullname,
      },
    ]);
  });

  it.each(['verification', 'login', 'captcha'] as const)('stops a DM at a %s wall', async (wall) => {
    target.setWall(wall);
    const from = target.submissions.items.length;
    const r = await sendDm(dm());
    expect(r.outcome).toBe('needs_human');
    expect(r.data).toEqual({ wall, submitted: false });
    expect(target.submissions.items.length).toBe(from);
  });

  it('reports a rejected DM', async () => {
    target.failNextSubmit(500);
    const r = await sendDm(dm());
    expect(r.outcome).toBe('error');
    expect(r.error?.code).toBe('submit_rejected');
  });

  describe('a submit click that rejects after the submit went out', () => {
    const sessionOpts = () => ({
      cdpUrlFor: opts.cdpUrlFor!,
      proxyFor: opts.proxyFor!,
      stepTimeoutMs: 8_000,
    });
    const confirm = { confirmTimeoutMs: 5_000 };

    async function codeOf(p: Promise<unknown>): Promise<string> {
      try {
        await p;
      } catch (err) {
        expect(err).toBeInstanceOf(ActionError);
        return (err as ActionError).code;
      }
      return 'resolved';
    }

    it('reports post_unconfirmed for a comment when the click throws after clicking', async () => {
      const s = await openSession(PROFILE, ctx(), sessionOpts());
      try {
        const from = target.submissions.items.length;
        const hooked = hookSession(s, commentSel.submit, async (real) => {
          await real();
          throw new Error(
            'page.click: Timeout 8000ms exceeded (waiting for scheduled navigations to finish)',
          );
        });
        expect(await codeOf(runSubmitComment(hooked, comment({ body: 'click then throw' }), confirm))).toBe(
          'post_unconfirmed',
        );
        await expect.poll(() => target.submissions.items.length).toBe(from + 1);
      } finally {
        await s.close();
      }
    });

    it('reports post_unconfirmed when the deadline abort lands as the comment submit is clicked', async () => {
      const ac = new AbortController();
      const s = await openSession(PROFILE, { ...ctx(), signal: ac.signal }, sessionOpts());
      try {
        const hooked = hookSession(s, commentSel.submit, async (real) => {
          // The abort closes the CDP connection while the click is in flight.
          const click = real();
          ac.abort();
          await click;
          // If the click won the race, the closed connection must still fail the action as unconfirmed.
        });
        expect(await codeOf(runSubmitComment(hooked, comment({ body: 'aborted mid-click' }), confirm))).toBe(
          'post_unconfirmed',
        );
      } finally {
        await s.close();
      }
    });

    it('reports post_unconfirmed for a DM when the send click throws after clicking', async () => {
      const s = await openSession(PROFILE, ctx(), sessionOpts());
      try {
        const hooked = hookSession(s, dmSel.send, async (real) => {
          await real();
          throw new Error('Target page, context or browser has been closed');
        });
        expect(
          await codeOf(
            runSendDm(hooked, dm({ body: 'dm click then throw' }), {
              ...confirm,
              redditOrigin: target.baseUrl,
            }),
          ),
        ).toBe('post_unconfirmed');
      } finally {
        await s.close();
      }
    });

    it('reports post_unconfirmed when the deadline abort lands as the DM send is clicked', async () => {
      const ac = new AbortController();
      const s = await openSession(PROFILE, { ...ctx(), signal: ac.signal }, sessionOpts());
      try {
        const hooked = hookSession(s, dmSel.send, async (real) => {
          const click = real();
          ac.abort();
          await click;
        });
        expect(
          await codeOf(
            runSendDm(hooked, dm({ body: 'dm aborted mid-click' }), {
              ...confirm,
              redditOrigin: target.baseUrl,
            }),
          ),
        ).toBe('post_unconfirmed');
      } finally {
        await s.close();
      }
    });
  });

  it('reads the exit IP from the page and from the agent (no proxy)', async () => {
    target.setPageIp('198.51.100.23');
    const r = await handlers['profile.testProxy']!({ kind: 'profile.testProxy', profileId: PROFILE }, ctx());
    expect(r).toEqual({ outcome: 'ok', data: { pageIp: '198.51.100.23', agentIp: '198.51.100.23' } });
    target.setPageIp('203.0.113.10');
  });

  it('refuses the proxy test when the agent has no proxy on record', async () => {
    const h = createActionHandlers({ ...opts, proxyFor: () => undefined });
    const r = await h['profile.testProxy']!({ kind: 'profile.testProxy', profileId: PROFILE }, ctx());
    expect(r.outcome).toBe('error');
    expect(r.error?.code).toBe('proxy_unknown');
  });

  it('reports cdp_unreachable when the profile browser is down', async () => {
    const h = createActionHandlers({ ...opts, cdpUrlFor: () => 'http://127.0.0.1:1', stepTimeoutMs: 2_000 });
    const r = await h['action.submitComment']!(comment(), ctx());
    expect(r).toMatchObject({ outcome: 'error', error: { code: 'cdp_unreachable' } });
  });

  it('runs actions on one profile one at a time', async () => {
    const from = target.submissions.items.length;
    const [a, b] = await Promise.all([
      submitComment(comment({ body: 'first in line' })),
      sendDm(dm({ body: 'second in line' })),
    ]);
    expectPosted(a, 't1_');
    expectPosted(b, 't4_');
    expect(target.submissions.items.slice(from).map((s) => s.text)).toEqual([
      'first in line',
      'second in line',
    ]);
  });

  describe('through the agent', () => {
    let gw: FakeGateway;
    let agent: Agent;

    beforeAll(async () => {
      gw = await FakeGateway.start({ deadlineMs: 30_000 });
      agent = await startAgent({
        config: testConfig(gw.agentUrl),
        modules: [{ name: 'actions', handlers: createActionHandlers(opts) }],
        log,
        backoff: { minMs: 10, maxMs: 40 },
      });
      await gw.waitForAgent('browser-1');
    });

    afterAll(async () => {
      await agent?.stop();
      await gw?.close();
    });

    it('posts once per cmdId: a retried job replays the stored result', async () => {
      const from = target.submissions.items.length;
      const cmd = comment({ body: 'Posted exactly once.' });
      const first: Result = await gw.send('browser-1', cmd, { cmdId: 'bj-action.submitComment-draft_x' });
      expect(first.outcome).toBe('posted');
      const again: Result = await gw.send('browser-1', cmd, { cmdId: 'bj-action.submitComment-draft_x' });
      expect(again).toEqual(first);
      expect(target.submissions.items.slice(from).map((s) => s.text)).toEqual(['Posted exactly once.']);
    });

    it('returns needs_human through the gateway protocol', async () => {
      target.setWall('verification');
      const r = await gw.send('browser-1', dm(), { cmdId: 'bj-action.sendDm-draft_y' });
      expect(r).toMatchObject({ outcome: 'needs_human', data: { wall: 'verification', submitted: false } });
    });
  });
});
