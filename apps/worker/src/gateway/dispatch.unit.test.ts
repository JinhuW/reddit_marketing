/**
 * Unit: the dispatcher with a fake hub and injected deps (no database, no Redis, no node). Covers plan 0003:
 * `profile.signIn` and browsers with no account.
 */
import { EventEmitter } from 'node:events';
import type { browsers } from '@threadline/db';
import type { BrowserJob, Cmd, Result } from '@threadline/shared';
import type { Job } from 'bullmq';
import { describe, expect, it, vi } from 'vitest';
import { log } from '../log';
import { type DispatchDeps, Dispatcher } from './dispatch';
import type { Hub, NodeInfo } from './hub';
import type { OutcomeDeps } from './outcomes';

const NODE = 'browser-1';
const PASSWORD = 'hunter2-very-secret';
const TOTP = 'JBSWY3DPEHPK3PXP';
const COOKIE_VALUE = 'cookie-value-secret';
const COOKIES_ENC = 'v1:encrypted-cookie-json';

const nodeInfo = (running: string[] = ['p1']): NodeInfo => ({
  name: NODE,
  nodeId: 'n1',
  workspaceId: 'w1',
  agentVersion: 'test',
  imageDigest: null,
  maxProfiles: 4,
  seats: {} as never,
  running: running.map((profileId) => ({ profileId, startedAt: Date.now() })) as never,
  connectedAt: new Date(),
  lastSeenAt: new Date(),
});

class FakeHub extends EventEmitter {
  sent: { cmd: Cmd; cmdId: string }[] = [];
  replies: Partial<Record<Cmd['kind'], Result>> = {};
  constructor(private readonly info: NodeInfo) {
    super();
  }
  nodes() {
    return [this.info];
  }
  async send(_node: string, cmd: Cmd, opts: { cmdId: string }): Promise<Result> {
    this.sent.push({ cmd, cmdId: opts.cmdId });
    return this.replies[cmd.kind] ?? ({ outcome: 'ok' } as Result);
  }
}

type Account = NonNullable<browsers.DispatchProfile['account']>;
const browserAccount = (over: Partial<Account> = {}): Account => ({
  id: 'a1',
  username: 'founder_jane',
  ownerMemberId: 'm1',
  pausedReason: null,
  authMode: 'browser',
  identifiedAt: null,
  ...over,
});

const profile = (account: Account | null): browsers.DispatchProfile => ({
  id: 'p1',
  workspaceId: 'w1',
  name: 'Jane · Chrome',
  accountId: account?.id ?? null,
  account,
  node: { id: 'n1', name: NODE, status: 'online' },
  cloak: { seed: 1, persona: 'windows', gpu: 'intel' } as never,
  tz: 'UTC',
  locale: 'en-US',
  screen: '1920x1080',
  proxy: null,
});

const cookie = {
  name: 'reddit_session',
  value: COOKIE_VALUE,
  domain: '.reddit.com',
  path: '/',
  expires: -1,
  httpOnly: true,
  secure: true,
  sameSite: 'Lax' as const,
};

const signIn = (account: Account | null, withCookies = true): browsers.SignInDispatch => ({
  profileId: 'p1',
  startUrl: 'https://www.reddit.com/r/startups/',
  cookiesEnc: withCookies ? COOKIES_ENC : null,
  cookies: withCookies ? [cookie] : null,
  account: account
    ? {
        id: account.id,
        username: account.username,
        authMode: account.authMode,
        identifiedAt: account.identifiedAt,
      }
    : null,
  credentials:
    account?.authMode === 'browser'
      ? { username: account.username, password: PASSWORD, totpSecret: TOTP }
      : null,
});

/** Captures everything the dispatcher (and outcomes.ts) logs. */
function capture() {
  const lines: string[] = [];
  const l = log.child({}) as typeof log;
  for (const level of ['info', 'warn', 'error', 'debug'] as const)
    vi.spyOn(l, level).mockImplementation(((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    }) as never);
  vi.spyOn(l, 'child').mockReturnValue(l as never);
  return { l, lines };
}

function setup(opts: {
  account: Account | null;
  withCookies?: boolean;
  running?: string[];
  deps?: Partial<DispatchDeps>;
}) {
  const hub = new FakeHub(nodeInfo(opts.running));
  const { l, lines } = capture();
  const outcomeDeps = {
    markPosted: vi.fn(),
    markFailed: vi.fn(),
    draftStatus: vi.fn(async () => 'approved'),
    pauseAccount: vi.fn(async () => ({ changed: true, reason: 'needs_human' as const })),
    writeAudit: vi.fn(async () => undefined),
    notifyNeedsHuman: vi.fn(async () => undefined),
    completeIdentity: vi.fn(async (_w: string, _a: string, who: { name: string }) => ({
      changed: true,
      username: who.name,
    })),
    markCookiesImported: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    recordProxyTest: vi.fn(async () => undefined),
    now: () => new Date('2026-11-12T00:00:00Z'),
  } satisfies OutcomeDeps;
  const deps: Partial<DispatchDeps> = {
    getProfile: vi.fn(async () => profile(opts.account)),
    getSignIn: vi.fn(async () => signIn(opts.account, opts.withCookies ?? true)),
    getDraft: vi.fn(async () => {
      throw new Error('draft must not be loaded');
    }),
    markFailed: vi.fn(),
    syncRunning: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    ...opts.deps,
  };
  const d = new Dispatcher({
    hub: hub as unknown as Hub,
    connection: {} as never,
    log: l,
    deps,
    outcomeDeps,
  });
  const run = (data: BrowserJob, id = `bj-${data.kind}-x`) =>
    d.process(NODE, { id, data, attemptsMade: 0, opts: { attempts: 5 } } as unknown as Job);
  return { hub, d, run, lines, outcomeDeps, deps };
}

const signInJob: BrowserJob = { kind: 'profile.signIn', workspaceId: 'w1', profileId: 'p1' };
const signedIn = { loggedIn: true, name: 'founder_jane', id: 'abc123', totalKarma: 10 };

describe('profile.signIn dispatch (plan 0003)', () => {
  it('sends decrypted credentials, cookies and the start tab, and never logs them', async () => {
    const t = setup({ account: browserAccount() });
    t.hub.replies['profile.signIn'] = { outcome: 'ok', data: signedIn } as Result;
    const out = await t.run(signInJob);

    const cmd = t.hub.sent.find((s) => s.cmd.kind === 'profile.signIn')?.cmd;
    expect(cmd).toEqual({
      kind: 'profile.signIn',
      profileId: 'p1',
      startUrl: 'https://www.reddit.com/r/startups/',
      cookies: [cookie],
      credentials: { username: 'founder_jane', password: PASSWORD, totpSecret: TOTP },
    });
    expect(out).toEqual({
      outcome: 'ok',
      kind: 'profile.signIn',
      data: { loggedIn: true, changed: true, username: 'founder_jane' },
    });
    const all = t.lines.join('\n') + JSON.stringify(out);
    for (const secret of [PASSWORD, TOTP, COOKIE_VALUE, COOKIES_ENC]) expect(all).not.toContain(secret);
  });

  it('marks exactly the sent cookies imported and completes the identity', async () => {
    const t = setup({ account: browserAccount() });
    t.hub.replies['profile.signIn'] = { outcome: 'ok', data: signedIn } as Result;
    await t.run(signInJob);
    expect(t.outcomeDeps.markCookiesImported).toHaveBeenCalledWith('w1', 'p1', COOKIES_ENC);
    expect(t.outcomeDeps.completeIdentity).toHaveBeenCalledWith('w1', 'a1', {
      name: 'founder_jane',
      id: 'abc123',
      totalKarma: 10,
    });
  });

  it('starts a cold profile first', async () => {
    const t = setup({ account: browserAccount(), running: [] });
    t.hub.replies['profile.signIn'] = { outcome: 'ok', data: { loggedIn: false } } as Result;
    await t.run(signInJob, 'bj-si-1');
    expect(t.hub.sent.map((s) => [s.cmd.kind, s.cmdId])).toEqual([
      ['profile.start', 'bj-si-1-start'],
      ['profile.signIn', 'bj-si-1'],
    ]);
  });

  it('no cookies pending: none sent, nothing marked imported', async () => {
    const t = setup({ account: browserAccount(), withCookies: false });
    t.hub.replies['profile.signIn'] = { outcome: 'ok', data: { loggedIn: false } } as Result;
    await t.run(signInJob);
    const cmd = t.hub.sent.find((s) => s.cmd.kind === 'profile.signIn')?.cmd;
    expect(cmd && 'cookies' in cmd).toBe(false);
    expect(t.outcomeDeps.markCookiesImported).not.toHaveBeenCalled();
  });

  it('a browser with no account: cookies imported, signed-in identity only logged', async () => {
    const t = setup({ account: null });
    t.hub.replies['profile.signIn'] = { outcome: 'ok', data: signedIn } as Result;
    const out = await t.run(signInJob);
    const cmd = t.hub.sent.find((s) => s.cmd.kind === 'profile.signIn')?.cmd;
    expect(cmd && 'credentials' in cmd).toBe(false);
    expect(t.outcomeDeps.markCookiesImported).toHaveBeenCalledWith('w1', 'p1', COOKIES_ENC);
    expect(t.outcomeDeps.completeIdentity).not.toHaveBeenCalled();
    expect(out).toEqual({ outcome: 'ok', kind: 'profile.signIn', data: { loggedIn: true, changed: false } });
    expect(t.lines.join()).toContain('no_account');
    expect(t.lines.join()).not.toContain('founder_jane');
  });

  it('needs_human pauses the account and notifies the owner, cookies stay pending', async () => {
    const t = setup({ account: browserAccount() });
    t.hub.replies['profile.signIn'] = {
      outcome: 'needs_human',
      error: { code: 'captcha', message: '' },
    } as Result;
    const out = await t.run(signInJob);
    expect(out).toEqual({ outcome: 'needs_human', paused: true, accountId: 'a1' });
    expect(t.outcomeDeps.pauseAccount).toHaveBeenCalledWith(
      expect.objectContaining({ accountId: 'a1', reason: 'needs_human' }),
    );
    expect(t.outcomeDeps.notifyNeedsHuman).toHaveBeenCalledWith(
      expect.objectContaining({ memberId: 'm1', draftId: null, profileId: 'p1' }),
    );
    expect(t.outcomeDeps.markCookiesImported).not.toHaveBeenCalled();
  });

  it('needs_human on a browser with no account pauses nothing', async () => {
    const t = setup({ account: null });
    t.hub.replies['profile.signIn'] = { outcome: 'needs_human' } as Result;
    const out = await t.run(signInJob);
    expect(out).toEqual({ outcome: 'needs_human', paused: false, accountId: null });
    expect(t.outcomeDeps.pauseAccount).not.toHaveBeenCalled();
    expect(t.outcomeDeps.notifyNeedsHuman).not.toHaveBeenCalled();
  });

  it('an account (un)assigned between the two loads is retried, nothing sent', async () => {
    const t = setup({
      account: browserAccount(),
      deps: { getSignIn: vi.fn(async () => signIn(browserAccount({ id: 'a2' }))) },
    });
    const err = await t.run(signInJob).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).name).not.toBe('UnrecoverableError');
    expect(t.hub.sent.some((s) => s.cmd.kind === 'profile.signIn')).toBe(false);
  });
});

describe('browsers with no account (plan 0003)', () => {
  it('an action for a browser with no account is refused before anything reaches the node', async () => {
    const draft = {
      id: 'd1',
      status: 'approved',
      approverMemberId: 'm1',
      accountId: 'a1',
      postedRedditId: null,
    };
    const t = setup({ account: null, running: [], deps: { getDraft: vi.fn(async () => draft as never) } });
    const err = await t
      .run({ kind: 'action.submitComment', workspaceId: 'w1', profileId: 'p1', draftId: 'd1' })
      .catch((e) => e);
    expect((err as Error).message).toMatch(/no account assigned to this browser; not sent/);
    expect(t.hub.sent).toEqual([]);
    expect(t.deps.markFailed).not.toHaveBeenCalled();
  });

  it('node offline/online only pauses and resumes profiles that have an account', async () => {
    const hub = new FakeHub(nodeInfo());
    const pauseAccount = vi.fn(async () => ({ changed: true, reason: 'node_offline' as const }));
    const resumeAccount = vi.fn(async () => ({ changed: true, was: 'node_offline' as const }));
    const d = new Dispatcher({
      hub: hub as unknown as Hub,
      connection: {} as never,
      log: capture().l,
      deps: {
        listProfiles: vi.fn(async () => [
          { id: 'p1', accountId: 'a1', nodeId: 'n1' },
          { id: 'p2', accountId: null, nodeId: 'n1' },
        ]),
        pauseAccount,
        resumeAccount,
      },
    });
    // Queue access is Redis-backed: stub the queued jobs for this node.
    const queued: BrowserJob[] = [
      { kind: 'profile.signIn', workspaceId: 'w1', profileId: 'p1' },
      { kind: 'profile.signIn', workspaceId: 'w1', profileId: 'p2' },
    ];
    const internals = d as unknown as {
      queuedJobs: () => Promise<BrowserJob[]>;
      running: boolean;
      nodeOffline: (i: unknown) => Promise<void>;
      accountsOf: (ws: string, pick: (p: { id: string }) => boolean) => Promise<string[]>;
    };
    internals.queuedJobs = async () => queued;
    internals.running = true;
    await internals.nodeOffline({ name: NODE, nodeId: 'n1', workspaceId: 'w1', reason: 'disconnected' });
    expect(pauseAccount).toHaveBeenCalledTimes(1);
    expect(pauseAccount).toHaveBeenCalledWith(expect.objectContaining({ accountId: 'a1' }));
    // The same selection drives the resume when the node returns.
    expect(await internals.accountsOf('w1', () => true)).toEqual(['a1']);
  });
});

describe('proxy credentials after an agent restart', () => {
  const withProxy = (over: Partial<browsers.DispatchProfile> = {}): browsers.DispatchProfile => ({
    ...profile(null),
    proxy: { protocol: 'http', host: 'isp.example', port: 10001, username: 'user', password: PASSWORD },
    ...over,
  });
  const resync = (d: Dispatcher, running: string[]) => {
    const internals = d as unknown as { running: boolean; resyncRunning: (i: NodeInfo) => Promise<void> };
    internals.running = true;
    return internals.resyncRunning(nodeInfo(running));
  };

  it('re-sends profile.start with the proxy for a running profile', async () => {
    const t = setup({ account: null, deps: { getProfile: vi.fn(async () => withProxy()) } });
    await resync(t.d, ['p1']);
    expect(t.hub.sent).toHaveLength(1);
    expect(t.hub.sent[0]?.cmd).toMatchObject({
      kind: 'profile.start',
      profileId: 'p1',
      proxy: { username: 'user', password: PASSWORD },
    });
    expect(t.lines.join('\n')).not.toContain(PASSWORD);
  });

  it('skips profiles with no proxy login, on another node, or unknown', async () => {
    const byId: Record<string, browsers.DispatchProfile | null> = {
      plain: withProxy({ id: 'plain', proxy: null }),
      anon: withProxy({ id: 'anon', proxy: { protocol: 'http', host: 'h', port: 1 } }),
      moved: withProxy({ id: 'moved', node: { id: 'n2', name: 'browser-2', status: 'online' } }),
      gone: null,
    };
    const t = setup({ account: null, deps: { getProfile: vi.fn(async (_w, id) => byId[id] ?? null) } });
    await resync(t.d, Object.keys(byId));
    expect(t.hub.sent).toHaveLength(0);
  });

  it('one failing profile does not stop the others', async () => {
    const getProfile = vi.fn(async (_w: string, id: string) => {
      if (id === 'bad') throw new Error('db down');
      return withProxy({ id });
    });
    const t = setup({ account: null, deps: { getProfile } });
    await resync(t.d, ['bad', 'p2']);
    expect(t.hub.sent.map((s) => s.cmd)).toEqual([expect.objectContaining({ profileId: 'p2' })]);
  });
});
