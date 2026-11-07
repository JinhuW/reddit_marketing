/**
 * Integration: post.publish against the real (seeded) Postgres with a fake Reddit poster.
 * Each test copies a seeded pending draft and removes the copy afterwards.
 */
import { drafts, members, prisma } from '@threadline/db';
import { afterAll, describe, expect, it } from 'vitest';
import { type Poster, publishDraft } from './post-publish';

const created: string[] = [];
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
  return d;
}
async function jane() {
  const m = await prisma.workspaceMember.findFirstOrThrow({ where: { user: { email: 'jane@acme.so' } } });
  return { id: m.id, workspaceId: m.workspaceId, role: m.role, canApprove: m.canApprove };
}

afterAll(async () => {
  await prisma.message.deleteMany({ where: { draftId: { in: created } } });
  await prisma.draft.deleteMany({ where: { id: { in: created } } });
  await prisma.$disconnect();
});

describe('post.publish', () => {
  it('refuses a pending (unapproved) draft and never calls Reddit', async () => {
    const d = await copyOf({ type: 'comment', subreddit: { name: 'projectmanagement' } });
    calls.length = 0;
    const out = await publishDraft(d.workspaceId, d.id, () => fake);
    expect(out.status).toBe('refused');
    expect(calls).toEqual([]);
  });

  it('posts an approved comment, records approver/disclosure and moves the opportunity to replied', async () => {
    const d = await copyOf({ type: 'comment', subreddit: { name: 'projectmanagement' } });
    const actor = await jane();
    expect(members.memberCanApprove(actor)).toBe(true);
    await drafts.approve(d.id, actor);
    calls.length = 0;
    const out = await publishDraft(d.workspaceId, d.id, () => fake);
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
    const out = await publishDraft(d.workspaceId, d.id, () => fake);
    expect(out.status).toBe('refused');
    expect(out.status === 'refused' && out.failures).toContain('disclosure');
    expect(calls).toEqual([]);
  });

  it('sends an approved DM and records the outbound message', async () => {
    const d = await copyOf({ type: 'dm', conversation: { lead: { redditUser: { username: 'ops_kat' } } } });
    await drafts.approve(d.id, await jane());
    const out = await publishDraft(d.workspaceId, d.id, () => fake);
    expect(out.status).toBe('posted');
    const msg = await prisma.message.findFirstOrThrow({ where: { draftId: d.id } });
    expect(msg.direction).toBe('out');
  });
});
