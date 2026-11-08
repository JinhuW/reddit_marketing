/**
 * Integration: gateway dispatch against the real (seeded) Postgres, real Redis (BullMQ) and T14's FakeAgent.
 * The test registers its own node, moves two seeded profiles onto it, and puts everything back afterwards.
 * It gives those profiles their own proxy, encrypted under whatever APP_ENCRYPTION_KEY is active (a fixed test
 * key when none is set, e.g. under turbo's strict env mode), so it never depends on the seed's ciphertext.
 */
import { randomBytes } from 'node:crypto';
import { browsers, drafts, nodes, prisma } from '@threadline/db';
import { type BrowserJob, browserJobId, browserQueue } from '@threadline/shared';
import { encrypt } from '@threadline/shared/crypto';
import { type Job, Queue, QueueEvents } from 'bullmq';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
// The worker package does not depend on the testkit (plan §5: package.json is not T20's); import it by path.
import { FakeAgent } from '../../../../packages/node-testkit/src/fake-agent';
import { redisConnection } from '../connection';
import { type Dispatcher, browserJobOptions, createDispatcher } from './dispatch';
import { type GatewayHandle, startGateway } from './index';

let gw: GatewayHandle;
let dispatcher: Dispatcher;
let queue: Queue;
let events: QueueEvents;
let agent: FakeAgent;
let workspaceId: string;
let nodeName: string;
let nodeId: string;
let token: string;
const created: string[] = [];
const restore: { id: string; nodeId: string | null; proxyId: string | null }[] = [];
const testProxies: string[] = [];
const TEST_KEY = Buffer.alloc(32, 7).toString('base64');
const prof: Record<'comment' | 'dm', { id: string; accountId: string; ownerMemberId: string }> = {} as never;

async function waitFor(cond: () => boolean | Promise<boolean>, ms = 5_000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 25));
  }
}

async function profileFor(type: 'comment' | 'dm') {
  const d = await prisma.draft.findFirstOrThrow({
    where: {
      status: 'pending',
      type,
      ...(type === 'dm'
        ? { conversation: { lead: { redditUser: { username: 'ops_kat' } } } }
        : { subreddit: { name: 'projectmanagement' } }),
    },
    select: {
      accountId: true,
      account: {
        select: {
          ownerMemberId: true,
          browserProfile: { select: { id: true, nodeId: true, proxyId: true } },
        },
      },
    },
  });
  const p = d.account.browserProfile!;
  return {
    id: p.id,
    nodeId: p.nodeId,
    proxyId: p.proxyId,
    accountId: d.accountId,
    ownerMemberId: d.account.ownerMemberId,
  };
}

beforeAll(async () => {
  process.env.APP_ENCRYPTION_KEY ||= TEST_KEY;
  workspaceId = (await prisma.workspace.findFirstOrThrow({ select: { id: true } })).id;
  nodeName = `t20-${randomBytes(4).toString('hex')}`;
  token = randomBytes(24).toString('hex');
  nodeId = (await nodes.register({ workspaceId, name: nodeName, token })).id;
  for (const type of ['comment', 'dm'] as const) {
    const p = await profileFor(type);
    restore.push({ id: p.id, nodeId: p.nodeId, proxyId: p.proxyId });
    await browsers.assignNode(workspaceId, p.id, nodeId);
    // Detach the seeded proxy and save a fresh one (saveProxy creates it) under the active key.
    await prisma.browserProfile.update({ where: { id: p.id }, data: { proxyId: null } });
    testProxies.push(
      await browsers.saveProxy(workspaceId, p.id, p.ownerMemberId, {
        provider: 't20 test',
        protocol: 'http',
        host: `${type}.proxy.test`,
        port: 8080,
        sticky: true,
        region: null,
        usernameEnc: encrypt(`${type}-user`),
        passwordEnc: encrypt(`${type}-pass`),
      }),
    );
    await browsers.ensureCloakFingerprint({ workspaceId, profileId: p.id });
    prof[type] = p;
  }

  gw = await startGateway({
    port: 0,
    host: '127.0.0.1',
    env: {},
    hub: { heartbeatSec: 1, offlineAfterMs: 5_000, ackTimeoutMs: 1_000, deadlineGraceMs: 0 },
  });
  dispatcher = createDispatcher({
    hub: gw.hub,
    deadlines: {
      'profile.start': 2_000,
      'profile.stop': 2_000,
      'action.submitComment': 2_000,
      'action.sendDm': 2_000,
      'profile.testProxy': 2_000,
      'profile.whoami': 2_000,
      'profile.signIn': 2_000,
      'health.check': 2_000,
    },
  });
  await dispatcher.start();
  queue = new Queue(browserQueue(nodeName), { connection: redisConnection() });
  events = new QueueEvents(browserQueue(nodeName), { connection: redisConnection() });
  await events.waitUntilReady();
  await queue.obliterate({ force: true });

  agent = new FakeAgent({ url: `ws://127.0.0.1:${gw.port}`, node: nodeName, token, maxProfiles: 4 });
  await agent.connect();
  await dispatcher.idle();
  expect(dispatcher.activeNodes()).toContain(nodeName);
});

afterEach(async () => {
  for (const p of Object.values(prof))
    await prisma.redditAccount.update({
      where: { id: p.accountId },
      data: { pausedReason: null, pausedAt: null },
    });
  await prisma.notification.deleteMany({
    where: { kind: 'needs_human', payload: { path: ['node'], equals: nodeName } },
  });
  await prisma.message.deleteMany({ where: { draftId: { in: created } } });
  const opps = await prisma.draft.findMany({
    where: { id: { in: created } },
    select: { opportunityId: true },
  });
  await prisma.draft.deleteMany({ where: { id: { in: created } } });
  for (const o of opps)
    if (o.opportunityId)
      await prisma.opportunity.update({ where: { id: o.opportunityId }, data: { status: 'new' } });
  created.length = 0;
});

afterAll(async () => {
  await agent?.close();
  await dispatcher?.stop();
  await gw?.stop();
  await events?.close();
  await queue?.obliterate({ force: true }).catch(() => {});
  await queue?.close();
  for (const r of restore)
    await prisma.browserProfile.update({
      where: { id: r.id },
      data: { nodeId: r.nodeId, proxyId: r.proxyId },
    });
  await prisma.proxy.deleteMany({ where: { id: { in: testProxies } } });
  await prisma.browserNode.deleteMany({ where: { id: nodeId } });
  await prisma.$disconnect();
});

async function jane() {
  const m = await prisma.workspaceMember.findFirstOrThrow({ where: { user: { email: 'jane@acme.so' } } });
  return { id: m.id, workspaceId: m.workspaceId, role: m.role, canApprove: m.canApprove };
}

/** A copy of a seeded pending draft (comment on r/projectmanagement, or DM to ops_kat). */
async function draftCopy(type: 'comment' | 'dm', approve = true) {
  const src = await prisma.draft.findFirstOrThrow({
    where: {
      status: 'pending',
      type,
      ...(type === 'dm'
        ? { conversation: { lead: { redditUser: { username: 'ops_kat' } } } }
        : { subreddit: { name: 'projectmanagement' } }),
    },
  });
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src;
  const d = await prisma.draft.create({
    data: { ...rest, bodyHistory: rest.bodyHistory ?? [], ruleChecks: rest.ruleChecks ?? [] } as never,
  });
  created.push(d.id);
  if (approve) await drafts.approve(d.id, await jane());
  return d;
}

async function enqueue(job: BrowserJob, suffix = randomBytes(3).toString('hex')): Promise<Job> {
  return queue.add(job.kind, job, {
    ...browserJobOptions,
    backoff: { type: 'fixed', delay: 100 },
    jobId: browserJobId(job, suffix),
  });
}

async function settle(job: Job): Promise<{ ok: true; value: unknown } | { ok: false; error: string }> {
  try {
    return { ok: true, value: await job.waitUntilFinished(events, 15_000) };
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
}

const commandsFor = (draftId: string) =>
  agent.commands.items.filter((c) => 'draftId' in c.cmd && c.cmd.draftId === draftId);
const account = (id: string) =>
  prisma.redditAccount.findUniqueOrThrow({ where: { id }, select: { pausedReason: true } });

describe('gateway dispatch', () => {
  it('profile.start sends the fingerprint and decrypted proxy, then writes profile.started', async () => {
    const p = prof.comment;
    const job = await enqueue({ kind: 'profile.start', workspaceId, profileId: p.id, reason: 'test' });
    const out = await settle(job);
    expect(out).toEqual({ ok: true, value: { outcome: 'ok', kind: 'profile.start' } });
    const cmd = agent.commands.items.find((c) => c.cmdId === job.id)!.cmd;
    const row = await prisma.browserProfile.findUniqueOrThrow({
      where: { id: p.id },
      include: { proxy: true },
    });
    expect(cmd).toMatchObject({ kind: 'profile.start', profileId: p.id, seed: row.cloakSeed });
    expect(row.proxy?.host).toBe('comment.proxy.test');
    expect(cmd.kind === 'profile.start' && cmd.proxy).toMatchObject({
      host: 'comment.proxy.test',
      port: 8080,
      username: 'comment-user',
      password: 'comment-pass',
    });
    const ev = await prisma.auditEvent.findFirst({
      where: { targetId: p.id, action: 'profile.started', meta: { path: ['node'], equals: nodeName } },
    });
    expect(ev?.meta).toMatchObject({ node: nodeName, reason: 'test' });
  });

  it('posts an approved comment through the node and records draft.posted once', async () => {
    const d = await draftCopy('comment');
    agent.next('action.submitComment', { outcome: 'posted', data: { fullname: 't1_dispatch1' } });
    const job = await enqueue({
      kind: 'action.submitComment',
      workspaceId,
      profileId: prof.comment.id,
      draftId: d.id,
    });
    const out = await settle(job);
    expect(out).toMatchObject({ ok: true, value: { outcome: 'posted', postedRedditId: 't1_dispatch1' } });
    const [cmd] = commandsFor(d.id);
    expect(cmd?.cmd).toMatchObject({
      kind: 'action.submitComment',
      parentFullname: expect.stringMatching(/^t3_/),
    });
    expect(cmd?.cmd.kind === 'action.submitComment' && cmd.cmd.threadUrl).toMatch(
      /^https:\/\/www\.reddit\.com\/r\//,
    );
    const after = await prisma.draft.findUniqueOrThrow({ where: { id: d.id } });
    expect(after).toMatchObject({ status: 'posted', postedRedditId: 't1_dispatch1' });
    const posted = await prisma.auditEvent.findMany({ where: { targetId: d.id, action: 'draft.posted' } });
    expect(posted).toHaveLength(1);
    expect(posted[0]!.meta).toMatchObject({ approverMemberId: (await jane()).id });
  });

  it('sends an approved DM with sendDm', async () => {
    const d = await draftCopy('dm');
    agent.next('action.sendDm', { outcome: 'posted', data: { fullname: 't4_dm1' } });
    const out = await settle(
      await enqueue({ kind: 'action.sendDm', workspaceId, profileId: prof.dm.id, draftId: d.id }),
    );
    expect(out).toMatchObject({ ok: true, value: { outcome: 'posted' } });
    expect(commandsFor(d.id)[0]?.cmd).toMatchObject({ kind: 'action.sendDm', to: 'ops_kat' });
    expect(await prisma.message.count({ where: { draftId: d.id, direction: 'out' } })).toBe(1);
  });

  it('never sends an unapproved draft to the agent', async () => {
    const d = await draftCopy('comment', false);
    const before = agent.commands.items.length;
    const out = await settle(
      await enqueue({ kind: 'action.submitComment', workspaceId, profileId: prof.comment.id, draftId: d.id }),
    );
    expect(out.ok).toBe(false);
    expect(!out.ok && out.error).toMatch(/pending/);
    expect(agent.commands.items.length).toBe(before); // not even a profile.start
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('pending');
  });

  it('refuses a draft that fails a block rule at post time and marks it failed', async () => {
    const d = await draftCopy('comment');
    await prisma.draft.update({ where: { id: d.id }, data: { body: 'Try Acme, it is great.' } });
    const out = await settle(
      await enqueue({ kind: 'action.submitComment', workspaceId, profileId: prof.comment.id, draftId: d.id }),
    );
    expect(out.ok).toBe(false);
    expect(commandsFor(d.id)).toEqual([]);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('failed');
  });

  it('refuses a draft sent with another account’s profile', async () => {
    const d = await draftCopy('comment');
    const out = await settle(
      await enqueue({ kind: 'action.submitComment', workspaceId, profileId: prof.dm.id, draftId: d.id }),
    );
    expect(out.ok).toBe(false);
    expect(commandsFor(d.id)).toEqual([]);
  });

  it('needs_human pauses the account, notifies the owner and leaves the draft approved', async () => {
    const d = await draftCopy('comment');
    agent.next('action.submitComment', {
      outcome: 'needs_human',
      error: { code: 'verification_wall', message: '' },
    });
    const out = await settle(
      await enqueue({ kind: 'action.submitComment', workspaceId, profileId: prof.comment.id, draftId: d.id }),
    );
    expect(out).toMatchObject({ ok: true, value: { outcome: 'needs_human', paused: true } });
    expect((await account(prof.comment.accountId)).pausedReason).toBe('needs_human');
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('approved');
    const n = await prisma.notification.findFirstOrThrow({
      where: {
        kind: 'needs_human',
        memberId: prof.comment.ownerMemberId,
        payload: { path: ['draftId'], equals: d.id },
      },
    });
    expect(n.payload).toMatchObject({ profileId: prof.comment.id, node: nodeName });
    const paused = await prisma.auditEvent.findFirst({
      where: { targetId: prof.comment.accountId, action: 'account.paused' },
      orderBy: { at: 'desc' },
    });
    expect(paused?.meta).toMatchObject({ reason: 'needs_human' });

    // While paused, a further action for the account is refused before reaching the agent.
    const d2 = await draftCopy('comment');
    const again = await settle(
      await enqueue({
        kind: 'action.submitComment',
        workspaceId,
        profileId: prof.comment.id,
        draftId: d2.id,
      }),
    );
    expect(again.ok).toBe(false);
    expect(commandsFor(d2.id)).toEqual([]);
  });

  it('license_denied pauses the account and writes profile.license_denied', async () => {
    agent.next('profile.start', { outcome: 'license_denied', error: { code: 'exit_78', message: '' } });
    const out = await settle(
      await enqueue({ kind: 'profile.start', workspaceId, profileId: prof.dm.id, reason: 'action' }),
    );
    expect(out).toMatchObject({ ok: true, value: { outcome: 'license_denied', paused: true } });
    expect((await account(prof.dm.accountId)).pausedReason).toBe('license_denied');
    const ev = await prisma.auditEvent.findFirst({
      where: { targetId: prof.dm.id, action: 'profile.license_denied' },
      orderBy: { at: 'desc' },
    });
    expect(ev?.meta).toMatchObject({ node: nodeName, code: 'exit_78' });
  });

  it('proxy_failed pauses the account', async () => {
    agent.setRunning([{ profileId: prof.dm.id, startedAt: Date.now() }]);
    agent.sendHeartbeat();
    await waitFor(() => gw.hub.nodes().some((n) => n.running.some((r) => r.profileId === prof.dm.id)));
    agent.next('profile.testProxy', { outcome: 'proxy_failed', error: { code: 'proxy_auth', message: '' } });
    const job = await enqueue({ kind: 'profile.testProxy', workspaceId, profileId: prof.dm.id });
    const out = await settle(job);
    expect(out).toMatchObject({ ok: true, value: { outcome: 'proxy_failed', paused: true } });
    expect((await account(prof.dm.accountId)).pausedReason).toBe('proxy_failed');
    // already running: no extra profile.start was sent
    expect(agent.commands.items.some((c) => c.cmdId === `${job.id}-start`)).toBe(false);
    agent.setRunning([]);
  });

  it('agent error marks the action draft failed and does not retry', async () => {
    const d = await draftCopy('dm');
    agent.next('action.sendDm', { outcome: 'error', error: { code: 'selector_missing', message: 'x' } });
    const job = await enqueue({ kind: 'action.sendDm', workspaceId, profileId: prof.dm.id, draftId: d.id });
    const out = await settle(job);
    expect(out.ok).toBe(false);
    expect(commandsFor(d.id)).toHaveLength(1);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('failed');
  });

  it('deadline_exceeded is retried, never marks the draft failed, and the replayed post is recorded once', async () => {
    const d = await draftCopy('comment');
    // First attempt: the agent reports its synthetic deadline result (uncached; the handler is still running).
    // Retry under the same cmdId: the agent returns the real result.
    // The real agent (apps/node-agent dispatch.ts) never caches that synthetic result; FakeAgent caches every
    // result and has no cue for this, so the step evicts its own entry right after FakeAgent stores it.
    agent.next('action.submitComment', (_cmd, command) => {
      setImmediate(() => (agent as unknown as { cache: Map<string, unknown> }).cache.delete(command.cmdId));
      return { outcome: 'error', error: { code: 'deadline_exceeded', message: '' } };
    });
    agent.next('action.submitComment', { outcome: 'posted', data: { fullname: 't1_slow' } });
    const job = await enqueue({
      kind: 'action.submitComment',
      workspaceId,
      profileId: prof.comment.id,
      draftId: d.id,
    });
    const out = await settle(job);
    expect(out).toMatchObject({ ok: true, value: { outcome: 'posted', postedRedditId: 't1_slow' } });
    expect(commandsFor(d.id).map((c) => c.cmdId)).toEqual([job.id, job.id]);
    expect(await prisma.auditEvent.count({ where: { targetId: d.id, action: 'draft.posted' } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { targetId: d.id, action: 'draft.failed' } })).toBe(0);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('posted');
  });

  it('disconnect after posting → node_offline pause → reconnect → retry replays and posts once', async () => {
    const d = await draftCopy('comment');
    const closes = agent.closes.items.length;
    agent.dropOn('action.submitComment', 'afterRun', { outcome: 'posted', data: { fullname: 't1_once' } });
    const job = await enqueue({
      kind: 'action.submitComment',
      workspaceId,
      profileId: prof.comment.id,
      draftId: d.id,
    });

    // The agent "posts", then the socket drops before the result is sent.
    await waitFor(() => commandsFor(d.id).length === 1);
    await waitFor(() => !gw.hub.isOnline(nodeName));
    // The hub emits `offline` after markOffline commits; the dispatcher drops the worker when it handles it.
    await waitFor(() => !dispatcher.activeNodes().includes(nodeName));
    await dispatcher.idle();
    // The job is still queued for the offline node: its account is paused with node_offline.
    expect((await account(prof.comment.accountId)).pausedReason).toBe('node_offline');
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('approved');

    await waitFor(() => agent.closes.items.length > closes);
    await agent.connect();
    await dispatcher.idle();
    expect((await account(prof.comment.accountId)).pausedReason).toBeNull();

    const out = await settle(job);
    expect(out).toMatchObject({ ok: true, value: { outcome: 'posted', postedRedditId: 't1_once' } });
    expect(agent.replays.items).toContain(job.id);
    expect(commandsFor(d.id)).toHaveLength(2); // the retry reached the agent, which replayed instead of posting
    expect(agent.results.items.filter((r) => r.cmdId === job.id)).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { targetId: d.id, action: 'draft.posted' } })).toBe(1);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).postedRedditId).toBe('t1_once');
  });

  /** Makes the dispatcher treat the profile as not running (the node reported its container gone). */
  async function coldProfile(profileId: string) {
    agent.setRunning([]);
    agent.sendEvent(profileId, 'container.exited');
    const started = (dispatcher as unknown as { started: Map<string, Set<string>> }).started;
    await waitFor(() => !started.get(nodeName)?.has(profileId));
  }

  /** A profile.start error the real agent never caches; FakeAgent caches everything, so evict it. */
  const uncachedStartError = (code: string) => (_cmd: unknown, command: { cmdId: string }) => {
    setImmediate(() => (agent as unknown as { cache: Map<string, unknown> }).cache.delete(command.cmdId));
    return { outcome: 'error' as const, error: { code, message: '' } };
  };

  it('a cold-start profile.start error is retried and the action then posts once', async () => {
    const d = await draftCopy('comment');
    await coldProfile(prof.comment.id);
    agent.next('profile.start', uncachedStartError('cdp_timeout'));
    agent.next('profile.start', { outcome: 'ok' });
    agent.next('action.submitComment', { outcome: 'posted', data: { fullname: 't1_cold' } });
    const job = await enqueue({
      kind: 'action.submitComment',
      workspaceId,
      profileId: prof.comment.id,
      draftId: d.id,
    });
    const out = await settle(job);
    expect(out).toMatchObject({ ok: true, value: { outcome: 'posted', postedRedditId: 't1_cold' } });
    const starts = agent.commands.items.filter((c) => c.cmdId === `${job.id}-start`);
    expect(starts).toHaveLength(2);
    expect(commandsFor(d.id)).toHaveLength(1);
    expect(await prisma.auditEvent.count({ where: { targetId: d.id, action: 'draft.posted' } })).toBe(1);
    expect(await prisma.auditEvent.count({ where: { targetId: d.id, action: 'draft.failed' } })).toBe(0);
  });

  it('a cold-start profile.start that keeps failing marks the draft failed on the last attempt', async () => {
    const d = await draftCopy('comment');
    await coldProfile(prof.comment.id);
    agent.setScript('profile.start', uncachedStartError('cdp_timeout'));
    try {
      const job = await queue.add(
        'action.submitComment',
        { kind: 'action.submitComment', workspaceId, profileId: prof.comment.id, draftId: d.id },
        {
          ...browserJobOptions,
          attempts: 2,
          backoff: { type: 'fixed', delay: 100 },
          jobId: `t20-cold-${d.id}`,
        },
      );
      const out = await settle(job);
      expect(out.ok).toBe(false);
      expect(agent.commands.items.filter((c) => c.cmdId === `${job.id}-start`)).toHaveLength(2);
      expect(commandsFor(d.id)).toEqual([]); // nothing reached Reddit
      const after = await prisma.draft.findUniqueOrThrow({ where: { id: d.id } });
      expect(after.status).toBe('failed');
      expect(await prisma.auditEvent.count({ where: { targetId: d.id, action: 'draft.failed' } })).toBe(1);
    } finally {
      agent.setScript('profile.start', { outcome: 'ok' });
    }
  });

  it('a final profile.start refusal (seat_limit) fails the action draft at once', async () => {
    const d = await draftCopy('comment');
    await coldProfile(prof.comment.id);
    agent.next('profile.start', uncachedStartError('seat_limit'));
    const job = await enqueue({
      kind: 'action.submitComment',
      workspaceId,
      profileId: prof.comment.id,
      draftId: d.id,
    });
    const out = await settle(job);
    expect(out.ok).toBe(false);
    expect(agent.commands.items.filter((c) => c.cmdId === `${job.id}-start`)).toHaveLength(1);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('failed');
  });

  it('health.check returns the node data', async () => {
    const data = { running: [], seats: { inUse: 0, limit: 5 }, docker: 'ok' };
    agent.next('health.check', { outcome: 'ok', data });
    const out = await settle(await enqueue({ kind: 'health.check', workspaceId }));
    expect(out).toEqual({ ok: true, value: { outcome: 'ok', kind: 'health.check', data } });
  });

  describe('browser mode (plan 0002)', () => {
    const saved = new Map<
      string,
      {
        username: string;
        redditId: string;
        authMode: 'oauth' | 'browser';
        identifiedAt: Date | null;
        karma: number;
        accountCreatedAt: Date | null;
      }
    >();
    /** Makes the account a browser-mode account nobody has signed in to yet (as startBrowserConnect leaves it). */
    async function pendingBrowserAccount(accountId: string) {
      const a = await prisma.redditAccount.findUniqueOrThrow({ where: { id: accountId } });
      if (!saved.has(accountId))
        saved.set(accountId, {
          username: a.username,
          redditId: a.redditId,
          authMode: a.authMode,
          identifiedAt: a.identifiedAt,
          karma: a.karma,
          accountCreatedAt: a.accountCreatedAt,
        });
      await prisma.redditAccount.update({
        where: { id: accountId },
        data: {
          authMode: 'browser',
          identifiedAt: null,
          username: `pending-${accountId.slice(-6)}`,
          redditId: `pending:${accountId}`,
        },
      });
    }
    afterEach(async () => {
      for (const [id, v] of saved) await prisma.redditAccount.update({ where: { id }, data: v });
      saved.clear();
    });
    const whoamiCmds = (cmdId: string) =>
      agent.commands.items.filter((c) => c.cmdId === cmdId && c.cmd.kind === 'profile.whoami');

    it('profile.whoami starts a cold profile, then records the signed-in identity', async () => {
      await pendingBrowserAccount(prof.dm.accountId);
      await coldProfile(prof.dm.id);
      const name = `b3who_${randomBytes(3).toString('hex')}`;
      const redditId = randomBytes(4).toString('hex');
      agent.next('profile.whoami', {
        outcome: 'ok',
        data: { loggedIn: true, name, id: redditId, totalKarma: 321, createdUtc: 1_600_000_000 },
      });
      const job = await enqueue({ kind: 'profile.whoami', workspaceId, profileId: prof.dm.id });
      const out = await settle(job);
      expect(out).toEqual({
        ok: true,
        value: {
          outcome: 'ok',
          kind: 'profile.whoami',
          data: { loggedIn: true, changed: true, username: name },
        },
      });
      expect(agent.commands.items.some((c) => c.cmdId === `${job.id}-start`)).toBe(true);
      expect(whoamiCmds(job.id!)[0]?.cmd).toEqual({ kind: 'profile.whoami', profileId: prof.dm.id });
      const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: prof.dm.accountId } });
      expect(acc).toMatchObject({ username: name, redditId: `t2_${redditId}`, karma: 321 });
      expect(acc.identifiedAt).not.toBeNull();
      const ev = await prisma.auditEvent.findFirst({
        where: { targetId: prof.dm.accountId, action: 'account.connected' },
        orderBy: { at: 'desc' },
      });
      expect(ev?.meta).toMatchObject({ username: name, authMode: 'browser' });
    });

    it('profile.whoami with nobody signed in changes nothing', async () => {
      await pendingBrowserAccount(prof.dm.accountId);
      agent.next('profile.whoami', { outcome: 'ok', data: { loggedIn: false } });
      const out = await settle(await enqueue({ kind: 'profile.whoami', workspaceId, profileId: prof.dm.id }));
      expect(out).toEqual({
        ok: true,
        value: { outcome: 'ok', kind: 'profile.whoami', data: { loggedIn: false } },
      });
      const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: prof.dm.accountId } });
      expect(acc.identifiedAt).toBeNull();
    });

    it('profile.whoami for a user already connected in the workspace is final (not retried)', async () => {
      await pendingBrowserAccount(prof.dm.accountId);
      const other = await prisma.redditAccount.findUniqueOrThrow({ where: { id: prof.comment.accountId } });
      agent.setScript('profile.whoami', {
        outcome: 'ok',
        data: { loggedIn: true, name: other.username, id: 'zzz111' },
      });
      try {
        const job = await enqueue({ kind: 'profile.whoami', workspaceId, profileId: prof.dm.id });
        const out = await settle(job);
        expect(out.ok).toBe(false);
        expect(!out.ok && out.error).toMatch(/identity_conflict/);
        expect(!out.ok && out.error).not.toContain(other.username);
        expect(whoamiCmds(job.id!)).toHaveLength(1);
        const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: prof.dm.accountId } });
        expect(acc.identifiedAt).toBeNull();
      } finally {
        agent.setScript('profile.whoami', { outcome: 'ok', data: { loggedIn: false } });
      }
    });

    it('profile.signIn sends the stored credentials and cookies, imports them once and records the identity', async () => {
      const p = prof.dm;
      await pendingBrowserAccount(p.accountId);
      const name = `b3sign_${randomBytes(3).toString('hex')}`;
      const redditId = randomBytes(4).toString('hex');
      const password = `pw-${randomBytes(6).toString('hex')}`;
      const totpSecret = 'JBSWY3DPEHPK3PXP';
      const cookieValue = `cv-${randomBytes(6).toString('hex')}`;
      const cookieJson = JSON.stringify([
        {
          name: 'reddit_session',
          value: cookieValue,
          domain: '.reddit.com',
          path: '/',
          httpOnly: true,
          secure: true,
        },
      ]);
      const cookiesEnc = encrypt(cookieJson);
      // A real username (not pending-…) so the gateway sends credentials.
      await prisma.redditAccount.update({
        where: { id: p.accountId },
        data: { username: name, loginPasswordEnc: encrypt(password), totpSecretEnc: encrypt(totpSecret) },
      });
      await prisma.browserProfile.update({
        where: { id: p.id },
        data: { cookiesEnc, startUrl: 'https://www.reddit.com/r/startups/' },
      });
      try {
        agent.next('profile.signIn', { outcome: 'ok', data: { loggedIn: true, name, id: redditId } });
        const job = await enqueue({ kind: 'profile.signIn', workspaceId, profileId: p.id });
        const out = await settle(job);
        expect(out).toEqual({
          ok: true,
          value: {
            outcome: 'ok',
            kind: 'profile.signIn',
            data: { loggedIn: true, changed: true, username: name },
          },
        });
        const cmd = agent.commands.items.find((c) => c.cmdId === job.id)?.cmd;
        expect(cmd).toMatchObject({
          kind: 'profile.signIn',
          profileId: p.id,
          startUrl: 'https://www.reddit.com/r/startups/',
          credentials: { username: name, password, totpSecret },
          cookies: [expect.objectContaining({ name: 'reddit_session', value: cookieValue })],
        });
        // Secrets never in the job payload, its stored result or audit rows.
        const stored = await queue.getJob(job.id!);
        const where = JSON.stringify([stored?.data, stored?.returnvalue]);
        for (const secret of [password, totpSecret, cookieValue, cookiesEnc])
          expect(where).not.toContain(secret);
        const row = await prisma.browserProfile.findUniqueOrThrow({ where: { id: p.id } });
        expect(row.cookiesEnc).toBeNull();
        expect(row.cookiesImportedAt).not.toBeNull();
        const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: p.accountId } });
        expect(acc).toMatchObject({ username: name, redditId: `t2_${redditId}` });
        expect(acc.identifiedAt).not.toBeNull();
        const evs = await prisma.auditEvent.findMany({
          where: {
            OR: [{ targetId: p.id }, { targetId: p.accountId }],
            at: { gte: new Date(Date.now() - 60_000) },
          },
        });
        const audit = JSON.stringify(evs.map((e) => e.meta));
        for (const secret of [password, totpSecret, cookieValue]) expect(audit).not.toContain(secret);
      } finally {
        await prisma.redditAccount.update({
          where: { id: p.accountId },
          data: { loginPasswordEnc: null, totpSecretEnc: null },
        });
        await prisma.browserProfile.update({
          where: { id: p.id },
          data: { cookiesEnc: null, cookiesImportedAt: null, startUrl: null },
        });
      }
    });

    it('an action for a browser whose account was unassigned is refused, nothing sent', async () => {
      const d = await draftCopy('dm');
      const p = prof.dm;
      await prisma.browserProfile.update({ where: { id: p.id }, data: { accountId: null } });
      try {
        const before = agent.commands.items.length;
        const out = await settle(
          await enqueue({ kind: 'action.sendDm', workspaceId, profileId: p.id, draftId: d.id }),
        );
        expect(out.ok).toBe(false);
        expect(!out.ok && out.error).toMatch(/^refused: no account assigned to this browser/);
        expect(agent.commands.items.length).toBe(before);
      } finally {
        await prisma.browserProfile.update({ where: { id: p.id }, data: { accountId: p.accountId } });
      }
    });

    it('the approval gate refuses an action for an account nobody has signed in to', async () => {
      const d = await draftCopy('dm'); // approved while the account was identified
      await pendingBrowserAccount(prof.dm.accountId);
      const before = agent.commands.items.length;
      const out = await settle(
        await enqueue({ kind: 'action.sendDm', workspaceId, profileId: prof.dm.id, draftId: d.id }),
      );
      expect(out.ok).toBe(false);
      expect(!out.ok && out.error).toMatch(/^refused: account not signed in yet/);
      expect(agent.commands.items.length).toBe(before); // not even a profile.start
      expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('failed');
    });
  });
});
