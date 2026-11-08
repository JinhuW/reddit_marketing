import { BrowserJobSchema } from '@threadline/shared';
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));
vi.mock('@threadline/db', () => ({ browsers: {}, nodes: {} }));

const {
  BROWSER_JOB_OPTIONS,
  enqueueProfileJob,
  nodeProblem,
  readWhoamiResult,
  redisConnection,
  whoamiStatus,
} = await import('./browser-jobs');
type Deps = Parameters<typeof enqueueProfileJob>[3] & object;

function fakeQueue(jobs: Record<string, { state: string; returnvalue?: unknown }> = {}) {
  const added: { queue: string; name: string; data: unknown; opts: Record<string, unknown> }[] = [];
  return {
    added,
    queue: (node: string) => ({
      add: async (name: string, data: unknown, opts: Record<string, unknown>) => {
        added.push({ queue: node, name, data, opts });
        return {};
      },
      getJob: async (id: string) => {
        const j = jobs[id];
        return j ? { getState: async () => j.state, returnvalue: j.returnvalue } : undefined;
      },
    }),
  };
}

const deps = (node: { name: string; status: string } | null, q = fakeQueue(), found = true): Deps => ({
  profileNode: async () => ({ found, node }),
  queue: q.queue as Deps['queue'],
  now: () => 1_700_000_000_000,
});

describe('enqueueProfileJob', () => {
  it('refuses without a node or with an offline node, and queues nothing', async () => {
    const q = fakeQueue();
    expect(await enqueueProfileJob('ws', 'p1', 'profile.start', deps(null, q))).toEqual({
      queued: false,
      reason: nodeProblem(null),
    });
    const off = await enqueueProfileJob(
      'ws',
      'p1',
      'profile.whoami',
      deps({ name: 'browser-1', status: 'offline' }, q),
    );
    expect(off).toEqual({ queued: false, reason: expect.stringContaining('browser-1 is offline') });
    expect(await enqueueProfileJob('ws', 'p1', 'profile.stop', deps(null, q, false))).toEqual({
      queued: false,
      reason: 'Profile not found.',
    });
    expect(q.added).toHaveLength(0);
  });

  it('queues on browser.<node> with a browserJobId and the gateway options; payload has no extra keys', async () => {
    const q = fakeQueue();
    const d = deps({ name: 'browser-1', status: 'online' }, q);
    const r = await enqueueProfileJob('ws', 'p1', 'profile.whoami', d);
    const suffix = (1_700_000_000_000).toString(36);
    expect(r).toEqual({ queued: true, jobId: `bj-profile.whoami-p1-${suffix}`, node: 'browser-1' });
    expect(q.added[0]).toMatchObject({ queue: 'browser-1', name: 'browser-1' });
    expect(q.added[0]!.opts).toEqual({
      ...BROWSER_JOB_OPTIONS,
      attempts: 2,
      jobId: `bj-profile.whoami-p1-${suffix}`,
    });
    for (const kind of ['profile.start', 'profile.stop'] as const)
      await enqueueProfileJob('ws', 'p1', kind, d);
    expect(q.added.map((a) => a.data)).toEqual([
      { kind: 'profile.whoami', workspaceId: 'ws', profileId: 'p1' },
      { kind: 'profile.start', workspaceId: 'ws', profileId: 'p1', reason: 'takeover' },
      { kind: 'profile.stop', workspaceId: 'ws', profileId: 'p1', reason: 'manual' },
    ]);
    // the gateway parses with .strict(): every payload must pass
    for (const a of q.added) expect(BrowserJobSchema.safeParse(a.data).success).toBe(true);
  });

  it('queues profile.signIn with ids only (no secrets) and two attempts', async () => {
    const q = fakeQueue();
    const r = await enqueueProfileJob(
      'ws',
      'p1',
      'profile.signIn',
      deps({ name: 'browser-1', status: 'online' }, q),
    );
    expect(r).toMatchObject({ queued: true, jobId: expect.stringMatching(/^bj-profile\.signIn-p1-/) });
    expect(q.added[0]!.data).toEqual({ kind: 'profile.signIn', workspaceId: 'ws', profileId: 'p1' });
    expect(q.added[0]!.opts.attempts).toBe(2);
    expect(BrowserJobSchema.safeParse(q.added[0]!.data).success).toBe(true);
  });

  it('returns queued:false when Redis fails', async () => {
    const d = deps({ name: 'browser-1', status: 'online' });
    d.queue = () => ({
      add: async () => {
        throw new Error('ECONNREFUSED');
      },
      getJob: async () => undefined,
    });
    expect(await enqueueProfileJob('ws', 'p1', 'profile.start', d)).toEqual({
      queued: false,
      reason: expect.stringContaining('job queue'),
    });
  });
});

describe('whoamiStatus', () => {
  const online = { name: 'browser-1', status: 'online' };
  const id = 'bj-profile.whoami-p1-abc';

  it('reads only whoami jobs of this profile', async () => {
    const q = fakeQueue({ 'bj-profile.whoami-p2-abc': { state: 'completed' } });
    expect(await whoamiStatus('ws', 'p1', 'bj-profile.whoami-p2-abc', deps(online, q))).toEqual({
      state: 'gone',
    });
    expect(await whoamiStatus('ws', 'p1', 'bj-profile.start-p1-abc', deps(online, q))).toEqual({
      state: 'gone',
    });
    expect(await whoamiStatus('ws', 'p1', id, deps(online, q))).toEqual({ state: 'gone' });
    expect(await whoamiStatus('ws', 'p1', id, deps(null, q))).toEqual({ state: 'gone' });
  });

  it('also reads a profile.signIn job of this profile', async () => {
    const sid = 'bj-profile.signIn-p1-abc';
    const q = fakeQueue({
      [sid]: { state: 'completed', returnvalue: { outcome: 'ok', data: { loggedIn: false } } },
    });
    expect(await whoamiStatus('ws', 'p1', sid, deps(online, q))).toEqual({
      state: 'done',
      whoami: { loggedIn: false },
    });
    expect(await whoamiStatus('ws', 'p2', sid, deps(online, q))).toEqual({ state: 'gone' });
  });

  it('maps job states and the gateway result', async () => {
    const run = (state: string, returnvalue?: unknown) =>
      whoamiStatus('ws', 'p1', id, deps(online, fakeQueue({ [id]: { state, returnvalue } })));
    expect(await run('waiting')).toEqual({ state: 'pending' });
    expect(await run('active')).toEqual({ state: 'pending' });
    expect(await run('failed')).toMatchObject({ state: 'failed' });
    expect(
      await run('completed', { outcome: 'ok', kind: 'profile.whoami', data: { loggedIn: false } }),
    ).toEqual({
      state: 'done',
      whoami: { loggedIn: false },
    });
  });
});

describe('readWhoamiResult', () => {
  it('accepts a signed-in identity and rejects malformed data', () => {
    expect(
      readWhoamiResult({ outcome: 'ok', data: { loggedIn: true, name: 'mira_cs', id: 'abc12' } }),
    ).toEqual({
      state: 'done',
      whoami: { loggedIn: true, name: 'mira_cs', id: 'abc12' },
    });
    expect(readWhoamiResult({ outcome: 'ok', data: { loggedIn: true, name: 'x y', id: 'abc' } }).state).toBe(
      'failed',
    );
    expect(readWhoamiResult({ outcome: 'skipped', reason: 'paused' })).toEqual({
      state: 'failed',
      reason: 'paused',
    });
    expect(readWhoamiResult({ outcome: 'proxy_failed' }).state).toBe('failed');
    expect(readWhoamiResult({ outcome: 'needs_human', paused: true, accountId: 'a1' })).toEqual({
      state: 'failed',
      reason: expect.stringContaining('Take control'),
    });
    expect(readWhoamiResult(null).state).toBe('failed');
  });
});

describe('redisConnection', () => {
  it('keeps the db index, credentials and TLS from REDIS_URL', () => {
    expect(redisConnection('redis://localhost:6379/14')).toMatchObject({
      host: 'localhost',
      port: 6379,
      db: 14,
    });
    const c = redisConnection('rediss://default:p%40ss@redis.internal:6380');
    expect(c).toMatchObject({
      host: 'redis.internal',
      port: 6380,
      db: 0,
      username: 'default',
      password: 'p@ss',
    });
    expect(c.tls).toEqual({});
  });
});
