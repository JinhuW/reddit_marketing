/** Unit: the `profile.whoami` and `profile.signIn` outcomes with injected deps (no database, no node). */
import { accounts } from '@threadline/db';
import { describe, expect, it, vi } from 'vitest';
import { log } from '../log';
import { FinalOutcomeError, type OutcomeContext, type OutcomeDeps, applyOutcome } from './outcomes';

const ctx = (authMode: 'oauth' | 'browser' = 'browser'): OutcomeContext => ({
  job: { kind: 'profile.whoami', workspaceId: 'w1', profileId: 'p1' },
  cmdId: 'bj-profile.whoami-p1-x',
  node: 'browser-1',
  profile: {
    id: 'p1',
    name: 'Profile 1',
    accountId: 'a1',
    account: {
      id: 'a1',
      username: 'pending-abc',
      ownerMemberId: 'm1',
      pausedReason: null,
      authMode,
      identifiedAt: null,
    },
  },
});

function deps(
  complete: OutcomeDeps['completeIdentity'] = async (_w, _a, who) => ({ changed: true, username: who.name }),
) {
  const unused = () => {
    throw new Error('not expected');
  };
  return {
    markPosted: unused,
    markFailed: unused,
    draftStatus: unused,
    pauseAccount: unused,
    writeAudit: unused,
    notifyNeedsHuman: unused,
    completeIdentity: vi.fn(complete),
    markCookiesImported: vi.fn(async () => undefined),
    setStatus: vi.fn(async () => undefined),
    recordProxyTest: vi.fn(async () => undefined),
    purgeProfile: vi.fn(async () => undefined),
    encrypt: vi.fn((plain: string) => `enc(${plain.length})`),
    recordProxyCheck: vi.fn(async () => undefined),
    recordProxyRotated: vi.fn(async () => undefined),
    resetProfileData: vi.fn(async () => undefined),
    now: () => new Date('2026-11-12T10:00:00Z'),
  } as unknown as OutcomeDeps & {
    completeIdentity: ReturnType<typeof vi.fn>;
    markCookiesImported: ReturnType<typeof vi.fn>;
    setStatus: ReturnType<typeof vi.fn>;
    recordProxyTest: ReturnType<typeof vi.fn>;
  };
}

/** Captures what the outcome logs, to prove the username never appears. */
function capture() {
  const lines: string[] = [];
  const l = log.child({}) as typeof log;
  for (const level of ['info', 'warn', 'error'] as const)
    vi.spyOn(l, level).mockImplementation(((...args: unknown[]) => {
      lines.push(JSON.stringify(args));
    }) as never);
  vi.spyOn(l, 'child').mockReturnValue(l as never);
  return { l, lines };
}

const signedIn = {
  loggedIn: true,
  name: 'founder_jane',
  id: 'abc123',
  totalKarma: 1234,
  createdUtc: 1_600_000_000,
};

describe('profile.whoami outcome', () => {
  it('not signed in: ok, nothing recorded', async () => {
    const d = deps();
    const { l, lines } = capture();
    const out = await applyOutcome(ctx(), { outcome: 'ok', data: { loggedIn: false } } as never, d, l);
    expect(out).toEqual({ outcome: 'ok', kind: 'profile.whoami', data: { loggedIn: false } });
    expect(d.completeIdentity).not.toHaveBeenCalled();
    expect(lines.join()).toContain('not signed in');
  });

  it('signed in: records the identity on the browser-mode account', async () => {
    const d = deps();
    const { l, lines } = capture();
    const out = await applyOutcome(ctx(), { outcome: 'ok', data: signedIn } as never, d, l);
    expect(d.completeIdentity).toHaveBeenCalledWith('w1', 'a1', {
      name: 'founder_jane',
      id: 'abc123',
      totalKarma: 1234,
      createdUtc: 1_600_000_000,
    });
    expect(out).toEqual({
      outcome: 'ok',
      kind: 'profile.whoami',
      data: { loggedIn: true, changed: true, username: 'founder_jane' },
    });
    expect(lines.join()).not.toContain('founder_jane');
  });

  it('a duplicate identity is final and logged by code only', async () => {
    const d = deps(async () => {
      throw new accounts.AccountConflictError('u/founder_jane is already connected in this workspace.');
    });
    const { l, lines } = capture();
    const err = await applyOutcome(ctx(), { outcome: 'ok', data: signedIn } as never, d, l).catch((e) => e);
    expect(err).toBeInstanceOf(FinalOutcomeError);
    expect((err as FinalOutcomeError).code).toBe('identity_conflict');
    expect((err as Error).message).not.toContain('founder_jane');
    expect(lines.join()).toContain('identity_conflict');
    expect(lines.join()).not.toContain('founder_jane');
  });

  it('other failures (e.g. the database) are not final, so BullMQ retries', async () => {
    const d = deps(async () => {
      throw new Error('connection reset');
    });
    const { l } = capture();
    const err = await applyOutcome(ctx(), { outcome: 'ok', data: signedIn } as never, d, l).catch((e) => e);
    expect(err).not.toBeInstanceOf(FinalOutcomeError);
    expect((err as Error).message).toBe('connection reset');
  });

  it('an unreadable result is final and records nothing', async () => {
    const d = deps();
    const { l } = capture();
    const err = await applyOutcome(
      ctx(),
      { outcome: 'ok', data: { loggedIn: true, name: 'x y', id: 'ABC' } } as never,
      d,
      l,
    ).catch((e) => e);
    expect((err as FinalOutcomeError).code).toBe('bad_whoami_data');
    expect(d.completeIdentity).not.toHaveBeenCalled();
  });

  it('an OAuth account keeps the identity from its token', async () => {
    const d = deps();
    const { l } = capture();
    const out = await applyOutcome(ctx('oauth'), { outcome: 'ok', data: signedIn } as never, d, l);
    expect(out).toEqual({ outcome: 'ok', kind: 'profile.whoami', data: { loggedIn: true, changed: false } });
    expect(d.completeIdentity).not.toHaveBeenCalled();
  });

  it('an agent error is retryable (whoami is not an action)', async () => {
    const { l } = capture();
    const err = await applyOutcome(
      ctx(),
      { outcome: 'error', error: { code: 'cdp_timeout', message: '' } } as never,
      deps(),
      l,
    ).catch((e) => e);
    expect((err as Error).name).toBe('RetryableOutcomeError');
  });
});

describe('profile.signIn outcome (plan 0003)', () => {
  const signInCtx = (sentCookiesEnc: string | null, withAccount = true): OutcomeContext => {
    const base = ctx();
    return {
      ...base,
      job: { kind: 'profile.signIn', workspaceId: 'w1', profileId: 'p1' },
      cmdId: 'bj-profile.signIn-p1-x',
      profile: withAccount ? base.profile : { id: 'p1', name: 'Profile 1', accountId: null, account: null },
      sentCookiesEnc,
    };
  };

  it('ok: marks the sent cookies imported, then records the identity', async () => {
    const d = deps();
    const { l, lines } = capture();
    const out = await applyOutcome(
      signInCtx('enc-cookies'),
      { outcome: 'ok', data: signedIn } as never,
      d,
      l,
    );
    expect(d.markCookiesImported).toHaveBeenCalledWith('w1', 'p1', 'enc-cookies');
    expect(d.completeIdentity).toHaveBeenCalledWith(
      'w1',
      'a1',
      expect.objectContaining({ name: 'founder_jane' }),
    );
    expect(out).toEqual({
      outcome: 'ok',
      kind: 'profile.signIn',
      data: { loggedIn: true, changed: true, username: 'founder_jane' },
    });
    expect(lines.join()).not.toContain('enc-cookies');
    expect(lines.join()).not.toContain('founder_jane');
  });

  it('no cookies sent: nothing marked imported', async () => {
    const d = deps();
    const { l } = capture();
    await applyOutcome(signInCtx(null), { outcome: 'ok', data: { loggedIn: false } } as never, d, l);
    expect(d.markCookiesImported).not.toHaveBeenCalled();
  });

  it('a duplicate identity is final, but the cookies were already imported', async () => {
    const d = deps(async () => {
      throw new accounts.AccountConflictError('u/founder_jane is already connected in this workspace.');
    });
    const { l } = capture();
    const err = await applyOutcome(signInCtx('enc'), { outcome: 'ok', data: signedIn } as never, d, l).catch(
      (e) => e,
    );
    expect((err as FinalOutcomeError).code).toBe('identity_conflict');
    expect(d.markCookiesImported).toHaveBeenCalledTimes(1);
  });

  it('signed in on a browser with no account: logged only, nothing recorded', async () => {
    const d = deps();
    const { l, lines } = capture();
    const out = await applyOutcome(signInCtx(null, false), { outcome: 'ok', data: signedIn } as never, d, l);
    expect(out).toEqual({ outcome: 'ok', kind: 'profile.signIn', data: { loggedIn: true, changed: false } });
    expect(d.completeIdentity).not.toHaveBeenCalled();
    expect(lines.join()).toContain('no_account');
  });

  it.each(['signin_rejected', 'totp_secret_invalid', 'cookies_rejected'])(
    '%s is final (never re-submits a login) and pauses nothing',
    async (code) => {
      const d = deps();
      const { l, lines } = capture();
      const err = await applyOutcome(
        signInCtx('enc'),
        { outcome: 'error', error: { code, message: 'secret page text' } } as never,
        d,
        l,
      ).catch((e) => e);
      expect(err).toBeInstanceOf(FinalOutcomeError);
      expect((err as FinalOutcomeError).code).toBe(code);
      expect(d.markCookiesImported).not.toHaveBeenCalled();
      expect(lines.join()).not.toContain('secret page text');
      if (code === 'signin_rejected') expect(lines.join()).toContain('rejected the stored password');
    },
  );

  it.each(['login_form_not_found', 'aborted'])('%s is retryable', async (code) => {
    const { l } = capture();
    const err = await applyOutcome(
      signInCtx('enc'),
      { outcome: 'error', error: { code, message: '' } } as never,
      deps(),
      l,
    ).catch((e) => e);
    expect((err as Error).name).toBe('RetryableOutcomeError');
  });

  it('an agent error is retryable (signIn is not an action)', async () => {
    const { l } = capture();
    const err = await applyOutcome(
      signInCtx('enc'),
      { outcome: 'error', error: { code: 'login_form_missing', message: '' } } as never,
      deps(),
      l,
    ).catch((e) => e);
    expect((err as Error).name).toBe('RetryableOutcomeError');
  });
});

describe('profile status and connection test outcomes (plan 0004, phase 0)', () => {
  const jobCtx = (job: OutcomeContext['job']): OutcomeContext => ({ ...ctx(), job, cmdId: 'c1' });

  it('profile.start ok marks the profile running; profile.stop ok marks it idle', async () => {
    const d = deps();
    d.writeAudit = vi.fn(async () => undefined);
    const start = jobCtx({ kind: 'profile.start', workspaceId: 'w1', profileId: 'p1', reason: 'takeover' });
    await applyOutcome(start, { outcome: 'ok' } as never, d, capture().l);
    expect(d.setStatus).toHaveBeenLastCalledWith('w1', 'p1', 'running');
    const stop = jobCtx({ kind: 'profile.stop', workspaceId: 'w1', profileId: 'p1', reason: 'manual' });
    await applyOutcome(stop, { outcome: 'ok' } as never, d, capture().l);
    expect(d.setStatus).toHaveBeenLastCalledWith('w1', 'p1', 'idle');
  });

  const test = jobCtx({ kind: 'profile.testProxy', workspaceId: 'w1', profileId: 'p1' });

  it('stores exit IP, latency, place and Reddit reachability', async () => {
    const d = deps();
    const data = {
      pageIp: '203.0.113.9',
      agentIp: '203.0.113.9',
      latencyMs: 142,
      redditOk: true,
      geo: { city: 'Boston', country: 'US', timeZone: 'America/New_York', lat: 42.36, lon: -71.06 },
    };
    const out = await applyOutcome(test, { outcome: 'ok', data } as never, d, capture().l);
    expect(out).toEqual({ outcome: 'ok', kind: 'profile.testProxy', data: { ok: true } });
    expect(d.recordProxyTest).toHaveBeenCalledWith('w1', 'p1', {
      ok: true,
      ip: '203.0.113.9',
      latencyMs: 142,
      redditOk: true,
      city: 'Boston, US',
      country: 'US',
      timeZone: 'America/New_York',
      lat: 42.36,
      lon: -71.06,
      testedAt: '2026-11-12T10:00:00.000Z',
    });
  });

  it('a page that leaves through another address than the proxy is a failed test', async () => {
    const d = deps();
    const data = { pageIp: '198.51.100.1', agentIp: '203.0.113.9' };
    await applyOutcome(test, { outcome: 'ok', data } as never, d, capture().l);
    expect(d.recordProxyTest.mock.calls[0]?.[2]).toMatchObject({ ok: false, error: 'ip_mismatch' });
  });

  it('proxy_failed records the failure before the pause handling', async () => {
    const d = deps();
    d.pauseAccount = vi.fn(async () => ({ changed: true, reason: 'proxy_failed' as const })) as never;
    const r = { outcome: 'proxy_failed', error: { code: 'proxy_auth_failed', message: 'secret text' } };
    await applyOutcome(test, r as never, d, capture().l);
    expect(d.recordProxyTest).toHaveBeenCalledWith('w1', 'p1', {
      ok: false,
      error: 'proxy_auth_failed',
      testedAt: '2026-11-12T10:00:00.000Z',
    });
  });

  it('an unreadable result is final and stores nothing', async () => {
    const d = deps();
    await expect(
      applyOutcome(test, { outcome: 'ok', data: { pageIp: '' } } as never, d, capture().l),
    ).rejects.toBeInstanceOf(FinalOutcomeError);
    expect(d.recordProxyTest).not.toHaveBeenCalled();
  });
});
