/**
 * Integration: session.idle against the seeded Postgres with an in-memory node queue (no Redis).
 */
import { browsers, drafts, prisma } from '@threadline/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { type BrowserQueues, memoryBrowserQueues } from './browser-health';
import { type Poster, publishDraft } from './post-publish';
import { REQUEUE_DELAY_MS, sessionIdle } from './session-idle';

const createdDrafts: string[] = [];
const touched = new Set<string>();
const createdSessions: string[] = [];

async function jane() {
  const m = await prisma.workspaceMember.findFirstOrThrow({
    where: { user: { email: 'jane@acme.so' } },
    include: { user: true },
  });
  return {
    id: m.id,
    workspaceId: m.workspaceId,
    role: m.role,
    canApprove: m.canApprove,
    name: m.user.name ?? 'Jane',
  };
}
/** A profile whose account has an approvable DM conversation (ops_kat). */
async function dmDraft() {
  const src = await prisma.draft.findFirstOrThrow({
    where: { status: 'pending', type: 'dm', conversation: { lead: { redditUser: { username: 'ops_kat' } } } },
  });
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src;
  const d = await prisma.draft.create({
    data: { ...rest, bodyHistory: rest.bodyHistory ?? [], ruleChecks: rest.ruleChecks ?? [] } as never,
  });
  createdDrafts.push(d.id);
  touched.add(d.accountId);
  const me = await jane();
  await drafts.approve(d.id, me);
  const profile = await prisma.browserProfile.findUniqueOrThrow({ where: { accountId: d.accountId } });
  return { d, profile, me };
}

afterEach(async () => {
  await prisma.browserSession.updateMany({
    where: { id: { in: createdSessions }, endedAt: null },
    data: { endedAt: new Date() },
  });
  // only accounts these tests used: other packages' tests share the database
  for (const a of await prisma.redditAccount.findMany({
    where: { id: { in: [...touched] }, pausedReason: { not: null } },
  }))
    await browsers.resumeAccount({ workspaceId: a.workspaceId, accountId: a.id });
});
afterAll(async () => {
  await prisma.draft.deleteMany({ where: { id: { in: createdDrafts } } });
  await prisma.$disconnect();
});

describe('session.idle', () => {
  it('ends a human session idle for 15 minutes and stops its profile on the node', async () => {
    const { profile, me } = await dmDraft();
    const s = await browsers.startHumanSession({
      workspaceId: me.workspaceId,
      profileId: profile.id,
      memberId: me.id,
      memberName: me.name,
      reason: 'test',
    });
    createdSessions.push(s.id);
    const mem = memoryBrowserQueues();
    const later = new Date(Date.now() + 16 * 60_000);

    const out = await sessionIdle(undefined, { browser: mem, now: later });
    expect(out.ended).toBeGreaterThanOrEqual(1);
    const after = await prisma.browserSession.findUniqueOrThrow({ where: { id: s.id } });
    expect(after.endedAt).not.toBeNull();
    await prisma.auditEvent.findFirstOrThrow({ where: { sessionId: s.id, action: 'session.ended' } });
    expect(mem.jobs.get(`browser-1/bj-profile.stop-${profile.id}-${s.id}`)?.job).toEqual({
      kind: 'profile.stop',
      workspaceId: me.workspaceId,
      profileId: profile.id,
      reason: 'idle',
    });

    // a second sweep finds nothing new for that session
    const again = await sessionIdle(undefined, { browser: mem, now: later });
    expect([...mem.jobs.keys()].filter((k) => k.includes(s.id))).toHaveLength(1);
    expect(again.stopped).toBe(0);
  });

  it('leaves an active session alone', async () => {
    const { profile, me } = await dmDraft();
    const s = await browsers.startHumanSession({
      workspaceId: me.workspaceId,
      profileId: profile.id,
      memberId: me.id,
      memberName: me.name,
      reason: 'test',
    });
    createdSessions.push(s.id);
    const mem = memoryBrowserQueues();
    await sessionIdle(undefined, { browser: mem, now: new Date(Date.now() + 60_000) });
    expect((await prisma.browserSession.findUniqueOrThrow({ where: { id: s.id } })).endedAt).toBeNull();
    expect([...mem.jobs.keys()].filter((k) => k.includes(s.id))).toEqual([]);
  });

  it('on hand-back resumes the needs_human pause and re-queues the browser action once', async () => {
    const { d, profile, me } = await dmDraft();
    const mem = memoryBrowserQueues();
    // the browser tried the DM and hit a wall: the gateway paused the account
    const first = {
      kind: 'action.sendDm',
      workspaceId: d.workspaceId,
      profileId: profile.id,
      draftId: d.id,
    } as const;
    await mem.add('browser-1', first, `bj-action.sendDm-${d.id}`);
    mem.finish('browser-1', `bj-action.sendDm-${d.id}`, { outcome: 'needs_human' });
    await browsers.pauseAccount({
      workspaceId: d.workspaceId,
      accountId: d.accountId,
      reason: 'needs_human',
    });

    const s = await browsers.startHumanSession({
      workspaceId: me.workspaceId,
      profileId: profile.id,
      memberId: me.id,
      memberName: me.name,
      reason: 'verification',
    });
    createdSessions.push(s.id);
    await browsers.handBack({
      workspaceId: me.workspaceId,
      sessionId: s.id,
      memberId: me.id,
      memberName: me.name,
    });

    const out = await sessionIdle(undefined, { browser: mem });
    expect(out.resumed).toBeGreaterThanOrEqual(1);
    expect(out.requeued).toBeGreaterThanOrEqual(1);
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } });
    expect(acc.pausedReason).toBeNull();
    const ev = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'account.resumed', targetId: d.accountId },
      orderBy: { at: 'desc' },
    });
    expect(ev.actorMemberId).toBe(me.id);
    expect(mem.jobs.get(`browser-1/bj-action.sendDm-${d.id}-${s.id}`)?.job).toEqual(first);

    // idempotent: the next sweep queues nothing new for this hand-back
    const before = mem.jobs.size;
    await sessionIdle(undefined, { browser: mem });
    expect(mem.jobs.size).toBe(before);
  });

  it('does not resume a pause that came after the hand-back', async () => {
    const { d, profile, me } = await dmDraft();
    const mem = memoryBrowserQueues();
    const s = await browsers.startHumanSession({
      workspaceId: me.workspaceId,
      profileId: profile.id,
      memberId: me.id,
      memberName: me.name,
      reason: 'verification',
    });
    createdSessions.push(s.id);
    await browsers.handBack({
      workspaceId: me.workspaceId,
      sessionId: s.id,
      memberId: me.id,
      memberName: me.name,
    });
    await new Promise((r) => setTimeout(r, 50));
    await browsers.pauseAccount({
      workspaceId: d.workspaceId,
      accountId: d.accountId,
      reason: 'needs_human',
    });

    await sessionIdle(undefined, { browser: mem });
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } });
    expect(acc.pausedReason).toBe('needs_human');
    expect([...mem.jobs.keys()].filter((k) => k.includes(d.id))).toEqual([]);
  });

  it('does not queue drafts the browser never tried (the API sweep takes them)', async () => {
    const { d, profile, me } = await dmDraft();
    const mem = memoryBrowserQueues();
    const s = await browsers.startHumanSession({
      workspaceId: me.workspaceId,
      profileId: profile.id,
      memberId: me.id,
      memberName: me.name,
      reason: 'look around',
    });
    createdSessions.push(s.id);
    await browsers.handBack({
      workspaceId: me.workspaceId,
      sessionId: s.id,
      memberId: me.id,
      memberName: me.name,
    });
    await sessionIdle(undefined, { browser: mem });
    expect([...mem.jobs.keys()].filter((k) => k.includes(d.id))).toEqual([]);
  });
  it('never lets post.publish reach Reddit while a hand-back re-queues the browser action', async () => {
    const { d, profile, me } = await dmDraft();
    const mem = memoryBrowserQueues();
    const firstId = `bj-action.sendDm-${d.id}`;
    await mem.add(
      'browser-1',
      { kind: 'action.sendDm', workspaceId: d.workspaceId, profileId: profile.id, draftId: d.id },
      firstId,
    );
    mem.finish('browser-1', firstId, { outcome: 'needs_human' });
    await browsers.pauseAccount({
      workspaceId: d.workspaceId,
      accountId: d.accountId,
      reason: 'needs_human',
    });
    const s = await browsers.startHumanSession({
      workspaceId: me.workspaceId,
      profileId: profile.id,
      memberId: me.id,
      memberName: me.name,
      reason: 'verification',
    });
    createdSessions.push(s.id);
    await browsers.handBack({
      workspaceId: me.workspaceId,
      sessionId: s.id,
      memberId: me.id,
      memberName: me.name,
    });

    let redditCalls = 0;
    const counting: Poster = {
      async comment() {
        redditCalls++;
        return 't1_x';
      },
      async submit() {
        redditCalls++;
        return 't3_x';
      },
      async compose() {
        redditCalls++;
        return 'dm_x';
      },
    };
    const order: string[] = [];
    const sweep = async (at: string) => {
      const out = await publishDraft(d.workspaceId, d.id, () => counting, new Date(), mem);
      order.push(`${at}:${out.status}`);
      return out;
    };
    // A post.publish sweep runs at every step session.idle takes with the node queue.
    const spy: BrowserQueues = {
      async add(node, job, id, opts) {
        const paused = (await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } }))
          .pausedReason;
        order.push(`add:${paused ?? 'running'}:${opts?.delay ?? 0}`);
        await sweep('before-add');
        const r = await mem.add(node, job, id, opts);
        await sweep('after-add');
        return r;
      },
      async get(node, id) {
        await sweep('get');
        return mem.get(node, id);
      },
      async inFlight(node, draftId) {
        await sweep('inFlight');
        return mem.inFlight(node, draftId);
      },
      async close() {},
    };

    const out = await sessionIdle(undefined, { browser: spy });
    // the account runs again; the browser job is delayed, so still in flight
    const last = await sweep('after-resume');
    expect(last).toEqual({ status: 'skipped', reason: 'browser fallback in progress on browser-1' });
    expect(out.requeued).toBeGreaterThanOrEqual(1);
    expect(
      (await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } })).pausedReason,
    ).toBeNull();
    // the job went in while the account was still paused, delayed so the gateway waits for the resume
    expect(order).toContain(`add:needs_human:${REQUEUE_DELAY_MS}`);
    expect(mem.jobs.get(`browser-1/bj-action.sendDm-${d.id}-${s.id}`)?.state).toBe('delayed');
    expect(order.filter((o) => !o.startsWith('add:')).every((o) => o.endsWith(':skipped'))).toBe(true);
    expect(redditCalls).toBe(0);
  });
});
