/**
 * Integration: post.publish against the real (seeded) Postgres with a fake Reddit poster.
 * Each test copies a seeded pending draft and removes the copy afterwards.
 */
import { browsers, drafts, members, prisma } from '@threadline/db';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { NeedsBrowser } from '../reddit/client';
import { DISPATCH_REFUSED_PREFIX, memoryBrowserQueues } from './browser-health';
import {
  BROWSER_FALLBACK_ACTION,
  BROWSER_POST_UNSUPPORTED,
  FALLBACK_ATTEMPTS,
  MAX_BROWSER_REQUEUES,
  type Poster,
  fallbackJob,
  publishDraft,
} from './post-publish';

const created: string[] = [];
const touched = new Set<string>();
const calls: string[] = [];
const fake: Poster = {
  comment: async (parent) => {
    calls.push(`comment:${parent}`);
    return 't1_fake';
  },
  submit: async (sr) => {
    calls.push(`submit:${sr}`);
    return 't3_fake';
  },
  compose: async (to) => {
    calls.push(`dm:${to}`);
    return 'dm_fake';
  },
};

async function copyOf(where: object) {
  const src = await prisma.draft.findFirstOrThrow({ where: { status: 'pending', ...where } });
  const { id: _id, createdAt: _c, updatedAt: _u, ...rest } = src;
  const d = await prisma.draft.create({
    data: { ...rest, bodyHistory: rest.bodyHistory ?? [], ruleChecks: rest.ruleChecks ?? [] } as never,
  });
  created.push(d.id);
  touched.add(d.accountId);
  return d;
}
async function jane() {
  const m = await prisma.workspaceMember.findFirstOrThrow({ where: { user: { email: 'jane@acme.so' } } });
  return { id: m.id, workspaceId: m.workspaceId, role: m.role, canApprove: m.canApprove };
}

/** Every test gets a fresh in-memory node queue; nothing here touches Redis. */
let mem = memoryBrowserQueues();
afterEach(async () => {
  mem = memoryBrowserQueues();
  // undo pauses a test caused (the audit rows stay: the log is append-only)
  // only accounts these tests used: other packages' tests share the database
  for (const a of await prisma.redditAccount.findMany({
    where: { id: { in: [...touched] }, pausedReason: { not: null } },
  }))
    await browsers.resumeAccount({ workspaceId: a.workspaceId, accountId: a.id });
});

afterAll(async () => {
  for (const id of created)
    await prisma.notification.deleteMany({ where: { payload: { path: ['draftId'], equals: id } } });
  await prisma.message.deleteMany({ where: { draftId: { in: created } } });
  await prisma.draft.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe('post.publish', () => {
  it('refuses a pending (unapproved) draft and never calls Reddit', async () => {
    const d = await copyOf({ type: 'comment', subreddit: { name: 'projectmanagement' } });
    calls.length = 0;
    const out = await publishDraft(d.workspaceId, d.id, () => fake, new Date(), mem);
    expect(out.status).toBe('refused');
    expect(calls).toEqual([]);
  });

  it('posts an approved comment, records approver/disclosure and moves the opportunity to replied', async () => {
    const d = await copyOf({ type: 'comment', subreddit: { name: 'projectmanagement' } });
    const actor = await jane();
    expect(members.memberCanApprove(actor)).toBe(true);
    await drafts.approve(d.id, actor);
    calls.length = 0;
    const out = await publishDraft(d.workspaceId, d.id, () => fake, new Date(), mem);
    expect(out).toEqual({ status: 'posted', postedRedditId: 't1_fake' });
    expect(calls[0]).toMatch(/^comment:t3_/);
    const after = await prisma.draft.findUniqueOrThrow({ where: { id: d.id } });
    expect(after.status).toBe('posted');
    const ev = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId: d.id, action: 'draft.posted' },
    });
    expect(ev.meta).toMatchObject({ approverMemberId: actor.id, disclosurePresent: true });
    // restore the seeded opportunity status
    if (d.opportunityId)
      await prisma.opportunity.update({ where: { id: d.opportunityId }, data: { status: 'new' } });
  });

  it('refuses at post time when the body lost its disclosure after approval', async () => {
    const d = await copyOf({ type: 'comment', subreddit: { name: 'projectmanagement' } });
    await drafts.approve(d.id, await jane());
    await prisma.draft.update({ where: { id: d.id }, data: { body: 'Try Acme, it is great.' } });
    calls.length = 0;
    const out = await publishDraft(d.workspaceId, d.id, () => fake, new Date(), mem);
    expect(out.status).toBe('refused');
    expect(out.status === 'refused' && out.failures).toContain('disclosure');
    expect(calls).toEqual([]);
  });

  it('sends an approved DM and records the outbound message', async () => {
    const d = await copyOf({ type: 'dm', conversation: { lead: { redditUser: { username: 'ops_kat' } } } });
    await drafts.approve(d.id, await jane());
    const out = await publishDraft(d.workspaceId, d.id, () => fake, new Date(), mem);
    expect(out.status).toBe('posted');
    const msg = await prisma.message.findFirstOrThrow({ where: { draftId: d.id } });
    expect(msg.direction).toBe('out');
  });
});

/** A poster that hits Reddit's verification wall on every call. */
const walled: Poster = {
  comment: async () => {
    throw new NeedsBrowser('captcha required');
  },
  submit: async () => {
    throw new NeedsBrowser('captcha required');
  },
  compose: async () => {
    throw new NeedsBrowser('captcha required');
  },
};

async function approvedCopy(where: object) {
  const d = await copyOf(where);
  await drafts.approve(d.id, await jane());
  return prisma.draft.findUniqueOrThrow({ where: { id: d.id } });
}
async function profileOf(accountId: string) {
  return prisma.browserProfile.findUniqueOrThrow({
    where: { accountId },
    select: { id: true, node: { select: { name: true } } },
  });
}

describe('post.publish browser fallback', () => {
  it('maps only comments and DMs to browser actions (PLAN §14)', () => {
    expect(BROWSER_FALLBACK_ACTION).toEqual({ comment: 'action.submitComment', dm: 'action.sendDm' });
    const base = { id: 'd1', workspaceId: 'w1' };
    expect(fallbackJob({ ...base, type: 'post' }, 'p1')).toBeNull();
    expect(fallbackJob({ ...base, type: 'dm' }, 'p1')).toEqual({
      kind: 'action.sendDm',
      workspaceId: 'w1',
      profileId: 'p1',
      draftId: 'd1',
    });
  });

  it('queues an approved DM on its node after a verification wall, notifies, and does not pause', async () => {
    const d = await approvedCopy({
      type: 'dm',
      conversation: { lead: { redditUser: { username: 'ops_kat' } } },
    });
    const profile = await profileOf(d.accountId);
    expect(profile.node?.name).toBe('browser-1');

    const out = await publishDraft(d.workspaceId, d.id, () => walled, new Date(), mem);
    expect(out).toEqual({
      status: 'needs_human',
      reason: 'captcha required',
      fallback: { node: 'browser-1', jobId: `bj-action.sendDm-${d.id}` },
    });
    expect([...mem.jobs.values()].map((j) => j.job)).toEqual([
      { kind: 'action.sendDm', workspaceId: d.workspaceId, profileId: profile.id, draftId: d.id },
    ]);
    expect(mem.jobs.get(`browser-1/bj-action.sendDm-${d.id}`)?.opts.attempts).toBe(3);
    const n = await prisma.notification.findFirstOrThrow({
      where: { kind: 'needs_human', payload: { path: ['draftId'], equals: d.id } },
    });
    expect(n.payload).toMatchObject({ profileId: profile.id, fallback: true });
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } });
    expect(acc.pausedReason).toBeNull();
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('approved');
  });

  it('queues an approved comment as action.submitComment (verification recovery)', async () => {
    const d = await approvedCopy({ type: 'comment', subreddit: { name: 'projectmanagement' } });
    const out = await publishDraft(d.workspaceId, d.id, () => walled, new Date(), mem);
    expect(out.status === 'needs_human' && out.fallback?.jobId).toBe(`bj-action.submitComment-${d.id}`);
    if (d.opportunityId)
      await prisma.opportunity.update({ where: { id: d.opportunityId }, data: { status: 'new' } });
  });

  it('never queues a post in the browser: it pauses the account with needs_human instead', async () => {
    const d = await approvedCopy({ type: 'post' });
    const before = await publishDraft(d.workspaceId, d.id, () => walled, new Date(), mem);
    expect(before.status).toBe('needs_human');
    expect(before.status === 'needs_human' && before.fallback).toBeNull();
    expect(mem.jobs.size).toBe(0);
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } });
    expect(acc.pausedReason).toBe('needs_human');
    const ev = await prisma.auditEvent.findFirstOrThrow({
      where: { action: 'account.paused', targetId: d.accountId },
      orderBy: { at: 'desc' },
    });
    expect(ev.meta).toMatchObject({ reason: 'needs_human' });
  });

  it('does not post through the API while the browser has the draft', async () => {
    const d = await approvedCopy({
      type: 'dm',
      conversation: { lead: { redditUser: { username: 'ops_kat' } } },
    });
    await publishDraft(d.workspaceId, d.id, () => walled, new Date(), mem);
    calls.length = 0;
    const out = await publishDraft(d.workspaceId, d.id, () => fake, new Date(), mem);
    expect(out).toEqual({ status: 'skipped', reason: 'browser fallback in progress on browser-1' });
    expect(calls).toEqual([]);
  });

  it('pauses instead of queueing twice once the browser already tried the draft', async () => {
    const d = await approvedCopy({
      type: 'dm',
      conversation: { lead: { redditUser: { username: 'ops_kat' } } },
    });
    await publishDraft(d.workspaceId, d.id, () => walled, new Date(), mem);
    mem.finish('browser-1', `bj-action.sendDm-${d.id}`, { outcome: 'error' });
    const out = await publishDraft(d.workspaceId, d.id, () => walled, new Date(), mem);
    expect(out.status === 'needs_human' && out.fallback).toBeNull();
    expect(mem.jobs.size).toBe(1);
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } });
    expect(acc.pausedReason).toBe('needs_human');
  });
});

describe('post.publish on a paused account', () => {
  it('skips with the pause reason, never calls Reddit and leaves the draft approved', async () => {
    const d = await approvedCopy({ type: 'comment', subreddit: { name: 'projectmanagement' } });
    for (const reason of [
      'needs_human',
      'license_denied',
      'node_offline',
      'proxy_failed',
      'manual',
    ] as const) {
      await browsers.pauseAccount({ workspaceId: d.workspaceId, accountId: d.accountId, reason });
      const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } });
      calls.length = 0;
      const out = await publishDraft(d.workspaceId, d.id, () => fake, new Date(), mem);
      expect(out).toEqual({ status: 'skipped', reason: `account u/${acc.username} is paused (${reason})` });
      expect(calls).toEqual([]);
      expect(mem.jobs.size).toBe(0);
      await browsers.resumeAccount({ workspaceId: d.workspaceId, accountId: d.accountId });
    }
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('approved');
  });
});

describe('post.publish for a browser-mode account (plan 0002)', () => {
  /** Accounts switched to browser mode by a test, with what to put back. */
  const switched = new Map<string, { authMode: 'oauth' | 'browser'; identifiedAt: Date | null }>();
  const nodeRestore: { id: string; nodeId: string | null }[] = [];
  async function browserMode(accountId: string, identifiedAt: Date | null = new Date()) {
    const a = await prisma.redditAccount.findUniqueOrThrow({ where: { id: accountId } });
    if (!switched.has(accountId))
      switched.set(accountId, { authMode: a.authMode, identifiedAt: a.identifiedAt });
    await prisma.redditAccount.update({
      where: { id: accountId },
      data: { authMode: 'browser', identifiedAt },
    });
  }
  afterEach(async () => {
    for (const [id, v] of switched) await prisma.redditAccount.update({ where: { id }, data: v });
    switched.clear();
    for (const r of nodeRestore.splice(0))
      await prisma.browserProfile.update({ where: { id: r.id }, data: { nodeId: r.nodeId } });
  });
  /** Any call to the Reddit API fails the test. */
  const noApi: Poster = {
    comment: async () => {
      throw new Error('Reddit API called in browser mode');
    },
    submit: async () => {
      throw new Error('Reddit API called in browser mode');
    },
    compose: async () => {
      throw new Error('Reddit API called in browser mode');
    },
  };
  const dmWhere = { type: 'dm', conversation: { lead: { redditUser: { username: 'ops_kat' } } } };
  const commentWhere = { type: 'comment', subreddit: { name: 'projectmanagement' } };
  const restoreOpp = async (d: { opportunityId: string | null }) => {
    if (d.opportunityId)
      await prisma.opportunity.update({ where: { id: d.opportunityId }, data: { status: 'new' } });
  };

  it('queues an approved comment on its node with the fallback job id; never calls the API', async () => {
    const d = await approvedCopy(commentWhere);
    await browserMode(d.accountId);
    const profile = await profileOf(d.accountId);
    const out = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(out).toEqual({
      status: 'queued',
      node: profile.node?.name,
      jobId: `bj-action.submitComment-${d.id}`,
    });
    const job = mem.jobs.get(`${profile.node?.name}/bj-action.submitComment-${d.id}`);
    expect(job?.job).toEqual({
      kind: 'action.submitComment',
      workspaceId: d.workspaceId,
      profileId: profile.id,
      draftId: d.id,
    });
    expect(job?.opts.attempts).toBe(FALLBACK_ATTEMPTS);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('approved');
    // the minute sweep sees the job in flight and does not queue it again
    const again = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(again.status).toBe('skipped');
    expect(mem.jobs.size).toBe(1);
    await restoreOpp(d);
  });

  it('queues an approved DM as action.sendDm', async () => {
    const d = await approvedCopy(dmWhere);
    await browserMode(d.accountId);
    const out = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(out.status === 'queued' && out.jobId).toBe(`bj-action.sendDm-${d.id}`);
  });

  it('marks a post draft failed: new threads are not supported in browser mode', async () => {
    const d = await approvedCopy({ type: 'post' });
    await browserMode(d.accountId);
    const out = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(out).toEqual({
      status: 'refused',
      reason: BROWSER_POST_UNSUPPORTED,
      failures: ['browser_mode'],
    });
    expect(BROWSER_POST_UNSUPPORTED).toBe('New threads are not supported in browser mode; nothing was sent.');
    expect(mem.jobs.size).toBe(0);
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('failed');
  });

  it('still refuses an unapproved draft before anything is queued', async () => {
    const d = await copyOf(commentWhere);
    await browserMode(d.accountId);
    const out = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(out.status).toBe('refused');
    expect(mem.jobs.size).toBe(0);
  });

  it('refuses a draft of an account nobody has signed in to yet', async () => {
    const d = await approvedCopy(commentWhere);
    await browserMode(d.accountId, null);
    const out = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(out.status).toBe('refused');
    expect(out.status === 'refused' && out.failures).toContain('account_eligible');
    expect(mem.jobs.size).toBe(0);
  });

  it('pauses the account with needs_human when its profile has no node', async () => {
    const d = await approvedCopy(commentWhere);
    await browserMode(d.accountId);
    const p = await prisma.browserProfile.findUniqueOrThrow({ where: { accountId: d.accountId } });
    nodeRestore.push({ id: p.id, nodeId: p.nodeId });
    await prisma.browserProfile.update({ where: { id: p.id }, data: { nodeId: null } });
    const out = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(out).toEqual({
      status: 'needs_human',
      reason: 'the browser profile has no node assigned',
      fallback: null,
    });
    expect(mem.jobs.size).toBe(0);
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } });
    expect(acc.pausedReason).toBe('needs_human');
    const n = await prisma.notification.findFirstOrThrow({
      where: { kind: 'needs_human', payload: { path: ['draftId'], equals: d.id } },
    });
    expect(n.payload).toMatchObject({ profileId: p.id, fallback: false });
    expect((await prisma.draft.findUniqueOrThrow({ where: { id: d.id } })).status).toBe('approved');
  });

  it('queues again under a new id only when the gateway refused before sending', async () => {
    const d = await approvedCopy(dmWhere);
    await browserMode(d.accountId);
    const node = (await profileOf(d.accountId)).node?.name ?? '';
    const first = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(first.status).toBe('queued');
    mem.fail(
      node,
      `bj-action.sendDm-${d.id}`,
      `${DISPATCH_REFUSED_PREFIX}account is paused (manual); not sent`,
    );
    const second = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(second).toEqual({ status: 'queued', node, jobId: `bj-action.sendDm-${d.id}-r1` });

    // A failure that may have reached the node (e.g. retries exhausted on a timeout) is never re-sent.
    mem.fail(node, `bj-action.sendDm-${d.id}-r1`, 'node timed out');
    const third = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(third.status === 'needs_human' && third.fallback).toBeNull();
    expect(mem.jobs.size).toBe(2);
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } });
    expect(acc.pausedReason).toBe('needs_human');
  });

  it('stops re-queueing after MAX_BROWSER_REQUEUES refusals', async () => {
    const d = await approvedCopy(dmWhere);
    await browserMode(d.accountId);
    const node = (await profileOf(d.accountId)).node?.name ?? '';
    for (let n = 0; n <= MAX_BROWSER_REQUEUES; n++) {
      const out = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
      expect(out.status).toBe('queued');
      if (out.status === 'queued') mem.fail(node, out.jobId, `${DISPATCH_REFUSED_PREFIX}refused`);
    }
    const last = await publishDraft(d.workspaceId, d.id, () => noApi, new Date(), mem);
    expect(last.status).toBe('needs_human');
    expect(mem.jobs.size).toBe(MAX_BROWSER_REQUEUES + 1);
  });

  it('leaves OAuth accounts on the API path', async () => {
    const d = await approvedCopy(dmWhere);
    const acc = await prisma.redditAccount.findUniqueOrThrow({ where: { id: d.accountId } });
    expect(acc.authMode).toBe('oauth');
    calls.length = 0;
    const out = await publishDraft(d.workspaceId, d.id, () => fake, new Date(), mem);
    expect(out.status).toBe('posted');
    expect(calls).toEqual(['dm:ops_kat']);
    expect(mem.jobs.size).toBe(0);
  });
});
