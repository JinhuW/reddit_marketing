// Repository functions for the Approvals screen and the post.publish worker. docs/PLAN.md §5 step 4, §7, §10.
import type { Prisma } from '@prisma/client';
import {
  PolicyError,
  type RuleContext,
  canApprove,
  containsDisclosure,
  evaluateDraft,
  warnings,
} from '@threadline/agents';
import {
  type DraftType,
  type MemberRole,
  type RuleCheck,
  buildUtm,
  makeSlug,
  withUtm,
} from '@threadline/shared';
import { prisma } from '../client';
import { writeAudit } from './audit';
import { memberCanApprove } from './members';

type Tx = Prisma.TransactionClient;

/** The acting member, as returned by requireRole()/findMembership(). */
export interface Actor {
  id: string;
  workspaceId: string;
  role: MemberRole;
  canApprove: boolean;
  user?: { name: string | null; email: string } | null;
}

export const draftInclude = {
  subreddit: true,
  agent: { select: { id: true, name: true, roleTitle: true, color: true } },
  account: {
    select: {
      id: true,
      username: true,
      roleLabel: true,
      disclosureLine: true,
      dailyPostLimit: true,
      selfPromoMax: true,
      karma: true,
      accountCreatedAt: true,
      identifiedAt: true,
      health: true,
      owner: { select: { id: true, user: { select: { name: true, email: true } } } },
    },
  },
  opportunity: {
    include: {
      post: { include: { subreddit: true } },
      keywordGroup: { select: { competitor: true, name: true } },
    },
  },
  conversation: {
    include: {
      lead: { include: { redditUser: { select: { username: true } } } },
      messages: { orderBy: { sentAt: 'asc' as const } },
      post: { include: { subreddit: true } },
    },
  },
  trackedLink: { include: { subreddit: true } },
  approver: { select: { id: true, user: { select: { name: true } } } },
} satisfies Prisma.DraftInclude;

export type DraftWithContext = Prisma.DraftGetPayload<{ include: typeof draftInclude }>;

/** Pending approval queue, oldest first. */
export async function pending(workspaceId: string, opts: { type?: DraftType } = {}) {
  return prisma.draft.findMany({
    where: { workspaceId, status: 'pending', ...(opts.type ? { type: opts.type } : {}) },
    orderBy: { createdAt: 'asc' },
    include: draftInclude,
  });
}

export async function pendingCounts(workspaceId: string) {
  const rows = await prisma.draft.groupBy({
    by: ['type'],
    where: { workspaceId, status: 'pending' },
    _count: { _all: true },
  });
  const by = Object.fromEntries(rows.map((r) => [r.type, r._count._all])) as Partial<
    Record<DraftType, number>
  >;
  return {
    all: rows.reduce((a, r) => a + r._count._all, 0),
    comment: by.comment ?? 0,
    post: by.post ?? 0,
    dm: by.dm ?? 0,
  };
}

export async function get(workspaceId: string, draftId: string) {
  return prisma.draft.findFirst({ where: { id: draftId, workspaceId }, include: draftInclude });
}

const dayKey = (d: Date, timeZone: string) =>
  new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

async function workspaceTimeZone(workspaceId: string, db: Tx | typeof prisma = prisma) {
  const ws = await db.workspace.findUnique({ where: { id: workspaceId }, select: { settings: true } });
  const tz = (ws?.settings as { timeZone?: string } | null)?.timeZone;
  return tz || 'UTC';
}

/** Posted-today (in the workspace time zone) and 7-day totals for an account, from posted Drafts. */
export async function accountActivity(
  accountId: string,
  now: Date = new Date(),
  db: Tx | typeof prisma = prisma,
) {
  const acct = await db.redditAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: { workspaceId: true },
  });
  const timeZone = await workspaceTimeZone(acct.workspaceId, db);
  const since7 = new Date(now.getTime() - 7 * 86_400_000);
  const posted = await db.draft.findMany({
    where: { accountId, status: 'posted', postedAt: { gte: since7, lte: now } },
    select: { postedAt: true, promotional: true },
  });
  const today = dayKey(now, timeZone);
  return {
    timeZone,
    postedToday: posted.filter((p) => p.postedAt && dayKey(p.postedAt, timeZone) === today).length,
    totalItems7d: posted.length,
    promoItems7d: posted.filter((p) => p.promotional).length,
  };
}

/** Subreddit the draft would post into (opportunity thread, conversation thread, or tracked link). */
export function draftSubreddit(d: DraftWithContext) {
  return (
    d.subreddit ??
    d.opportunity?.post.subreddit ??
    d.conversation?.post?.subreddit ??
    d.trackedLink?.subreddit ??
    null
  );
}

/** Competitor names: keyword group competitors + "Asana · pricing" style mentions (name part). */
export function draftCompetitors(d: DraftWithContext): string[] {
  const set = new Set<string>();
  for (const c of d.opportunity?.keywordGroup?.competitor ?? []) set.add(c);
  for (const m of d.opportunity?.competitorMentions ?? []) {
    const name = m.split('·')[0]?.trim();
    if (name) set.add(name);
  }
  return [...set];
}

/**
 * The owner's other accounts for `one_voice_per_thread` (block): which of them already spoke in this draft's
 * thread (approved, scheduled or posted draft on the same Reddit post), and whether the thread author or the DM
 * counterpart is one of them. Null when the owner has no other account.
 */
export async function ownerOtherAccounts(
  d: DraftWithContext,
  db: Tx | typeof prisma = prisma,
): Promise<RuleContext['ownerOtherAccounts']> {
  const others = await db.redditAccount.findMany({
    where: { workspaceId: d.workspaceId, ownerMemberId: d.account.owner.id, id: { not: d.accountId } },
    select: { id: true, username: true },
  });
  if (!others.length) return null;
  const thread = d.opportunity?.post ?? d.conversation?.post ?? null;
  const spoke = thread
    ? await db.draft.findMany({
        where: {
          workspaceId: d.workspaceId,
          accountId: { in: others.map((o) => o.id) },
          status: { in: ['approved', 'scheduled', 'posted'] },
          OR: [{ opportunity: { postId: thread.id } }, { conversation: { postId: thread.id } }],
        },
        select: { account: { select: { username: true } } },
        distinct: ['accountId'],
      })
    : [];
  const mine = new Map(others.map((o) => [o.username.toLowerCase(), o.username]));
  const people = [thread?.authorUsername, d.conversation?.lead.redditUser.username];
  const counterpart = people.map((u) => (u ? mine.get(u.toLowerCase()) : undefined)).find(Boolean) ?? null;
  return { inThread: spoke.map((x) => x.account.username).sort(), counterpart };
}

/** Builds the RuleContext for evaluateDraft (pure). `body` overrides the stored body (for edits). */
export async function buildRuleContext(
  d: DraftWithContext,
  now: Date = new Date(),
  opts: { body?: string; db?: Tx | typeof prisma } = {},
): Promise<RuleContext> {
  const act = await accountActivity(d.accountId, now, opts.db);
  const sub = draftSubreddit(d);
  const msgs = d.conversation?.messages ?? [];
  const ws = await (opts.db ?? prisma).workspace.findUnique({
    where: { id: d.workspaceId },
    select: { settings: true },
  });
  return {
    now,
    timeZone: act.timeZone,
    shortHost: (ws?.settings as { shortHost?: string } | null)?.shortHost ?? null,
    draft: { type: d.type, body: opts.body ?? d.body, promotional: d.promotional },
    account: {
      disclosureLine: d.account.disclosureLine,
      dailyPostLimit: d.account.dailyPostLimit,
      postedToday: act.postedToday,
      karma: d.account.karma,
      accountCreatedAt: d.account.accountCreatedAt,
      identifiedAt: d.account.identifiedAt,
      health: d.account.health,
      selfPromoMax: d.account.selfPromoMax,
      promoItems7d: act.promoItems7d,
      totalItems7d: act.totalItems7d,
    },
    subreddit: sub
      ? {
          name: sub.name,
          linkRule: sub.linkRule,
          minKarma: sub.minKarma,
          minAccountAgeDays: sub.minAccountAgeDays,
        }
      : null,
    post: d.opportunity ? { postedAt: d.opportunity.post.postedAt } : null,
    conversation: d.conversation
      ? {
          inboundCount: msgs.filter((m) => m.direction === 'in').length,
          isFirstOutbound: !msgs.some((m) => m.direction === 'out'),
        }
      : d.type === 'dm'
        ? { inboundCount: 0, isFirstOutbound: true }
        : null,
    competitors: draftCompetitors(d),
    ownerOtherAccounts: await ownerOtherAccounts(d, opts.db),
  };
}

export async function evaluate(
  d: DraftWithContext,
  now: Date = new Date(),
  body?: string,
  db?: Tx | typeof prisma,
) {
  return evaluateDraft(await buildRuleContext(d, now, { body, db }));
}

// ───────────────────────── transitions ─────────────────────────

async function loadForUpdate(tx: Tx, actor: Actor, draftId: string) {
  const d = await tx.draft.findFirst({
    where: { id: draftId, workspaceId: actor.workspaceId },
    include: draftInclude,
  });
  if (!d) throw new PolicyError('Draft not found.');
  return d;
}

function assertPending(d: { status: string }) {
  if (d.status !== 'pending') throw new PolicyError(`Draft is already ${d.status}.`);
}

function assertApprover(actor: Actor) {
  if (!memberCanApprove(actor)) throw new PolicyError('You are not an approver in this workspace.');
}

type HistoryEntry = { body: string; at: string; by: string; instruction?: string };
const history = (d: { bodyHistory: Prisma.JsonValue }) =>
  (Array.isArray(d.bodyHistory) ? d.bodyHistory : []) as unknown as HistoryEntry[];
const actorName = (a: Actor) => a.user?.name ?? a.user?.email ?? a.id;

function approvalChecks(checks: RuleCheck[]) {
  if (!canApprove(checks)) {
    const fails = checks.filter((c) => c.level === 'block' && !c.passed);
    throw new PolicyError(
      `Cannot approve: ${fails.map((f) => f.label).join(', ')}.`,
      fails.map((f) => f.key),
    );
  }
}

async function approveLike(
  draftId: string,
  actor: Actor,
  opts: { body?: string; scheduledFor?: Date; now?: Date },
) {
  assertApprover(actor);
  const now = opts.now ?? new Date();
  if (opts.scheduledFor && opts.scheduledFor.getTime() <= now.getTime())
    throw new PolicyError('Pick a time in the future.');
  return prisma.$transaction(async (tx) => {
    const d = await loadForUpdate(tx, actor, draftId);
    assertPending(d);
    const body = opts.body?.trim() ? opts.body : d.body;
    const edited = body !== d.body;
    const checks = await evaluate(d, now, body, tx);
    approvalChecks(checks);
    const status = opts.scheduledFor ? 'scheduled' : 'approved';
    const updated = await tx.draft.update({
      where: { id: d.id },
      data: {
        body,
        status,
        approverMemberId: actor.id,
        approvedAt: now,
        scheduledFor: opts.scheduledFor ?? null,
        ruleChecks: checks as unknown as Prisma.InputJsonValue,
        ...(edited
          ? {
              editCount: { increment: 1 },
              bodyHistory: [
                ...history(d),
                { body, at: now.toISOString(), by: actorName(actor) },
              ] as Prisma.InputJsonValue,
            }
          : {}),
      },
    });
    if (d.opportunityId)
      await tx.opportunity.update({ where: { id: d.opportunityId }, data: { status: 'drafting' } });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.id,
        action: opts.scheduledFor ? 'draft.scheduled' : 'draft.approved',
        targetType: 'Draft',
        targetId: d.id,
        accountId: d.accountId,
        meta: {
          approver: actorName(actor),
          account: d.account.username,
          agent: d.agent.name,
          type: d.type,
          disclosurePresent: containsDisclosure(body, d.account.disclosureLine),
          warnings: warnings(checks).map((w) => w.key),
          edited,
          ...(opts.scheduledFor ? { scheduledFor: opts.scheduledFor.toISOString() } : {}),
        },
      },
      tx,
    );
    return updated;
  });
}

/** Approve (optionally with an edited body). Refuses when a block rule fails or the actor cannot approve. */
export function approve(draftId: string, actor: Actor, opts: { body?: string; now?: Date } = {}) {
  return approveLike(draftId, actor, opts);
}

/** Approve for posting at a later time. Same checks as approve. */
export function schedule(draftId: string, actor: Actor, at: Date, opts: { body?: string; now?: Date } = {}) {
  return approveLike(draftId, actor, { ...opts, scheduledFor: at });
}

/** Save an edited body without approving. Re-runs the rules. */
export async function edit(draftId: string, actor: Actor, body: string, now: Date = new Date()) {
  if (!body.trim()) throw new PolicyError('The draft cannot be empty.');
  return prisma.$transaction(async (tx) => {
    const d = await loadForUpdate(tx, actor, draftId);
    assertPending(d);
    if (body === d.body) return d;
    const checks = await evaluate(d, now, body, tx);
    const updated = await tx.draft.update({
      where: { id: d.id },
      data: {
        body,
        ruleChecks: checks as unknown as Prisma.InputJsonValue,
        editCount: { increment: 1 },
        bodyHistory: [
          ...history(d),
          { body, at: now.toISOString(), by: actorName(actor) },
        ] as Prisma.InputJsonValue,
      },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.id,
        action: 'draft.edited',
        targetType: 'Draft',
        targetId: d.id,
        accountId: d.accountId,
        meta: { agent: d.agent.name, chars: body.length },
      },
      tx,
    );
    return updated;
  });
}

/** Reject with a required reason. The opportunity returns to `new`. */
export async function reject(draftId: string, actor: Actor, reason: string) {
  assertApprover(actor);
  const why = reason.trim();
  if (why.length < 3) throw new PolicyError('A reason is required to reject.');
  return prisma.$transaction(async (tx) => {
    const d = await loadForUpdate(tx, actor, draftId);
    assertPending(d);
    const updated = await tx.draft.update({
      where: { id: d.id },
      data: { status: 'rejected', rejectReason: why, approverMemberId: actor.id },
    });
    if (d.opportunityId)
      await tx.opportunity.update({ where: { id: d.opportunityId }, data: { status: 'new' } });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.id,
        action: 'draft.rejected',
        targetType: 'Draft',
        targetId: d.id,
        accountId: d.accountId,
        meta: { agent: d.agent.name, type: d.type, reason: why, approver: actorName(actor) },
      },
      tx,
    );
    return updated;
  });
}

/** Record a regenerate request; the caller enqueues draft.generate with version = returned `version`. */
export async function requestRegenerate(
  draftId: string,
  actor: Actor,
  instruction: string,
  now: Date = new Date(),
) {
  const text = instruction.trim();
  if (text.length < 3) throw new PolicyError('Say what to change.');
  return prisma.$transaction(async (tx) => {
    const d = await loadForUpdate(tx, actor, draftId);
    assertPending(d);
    const hist = [
      ...history(d),
      { body: d.body, at: now.toISOString(), by: actorName(actor), instruction: text },
    ];
    const updated = await tx.draft.update({
      where: { id: d.id },
      data: { regenerateInstruction: text, bodyHistory: hist as Prisma.InputJsonValue },
    });
    await writeAudit(
      {
        workspaceId: actor.workspaceId,
        actorMemberId: actor.id,
        action: 'draft.regenerated',
        targetType: 'Draft',
        targetId: d.id,
        accountId: d.accountId,
        meta: { agent: d.agent.name, instruction: text },
      },
      tx,
    );
    return { draft: updated, version: hist.length };
  });
}

// ───────────────────────── worker helpers (post.publish) ─────────────────────────

/** Drafts ready to post: approved, or scheduled with scheduledFor <= now. */
export async function dueForPublishing(now: Date = new Date(), take = 50) {
  return prisma.draft.findMany({
    where: {
      OR: [{ status: 'approved' }, { status: 'scheduled', scheduledFor: { lte: now } }],
      approverMemberId: { not: null },
    },
    orderBy: { approvedAt: 'asc' },
    take,
    select: { id: true, workspaceId: true, accountId: true },
  });
}

/** Whether the draft's approver can approve right now (role + canApprove). */
export async function approverCouldApprove(d: { approverMemberId: string | null }) {
  if (!d.approverMemberId) return false;
  const m = await prisma.workspaceMember.findUnique({ where: { id: d.approverMemberId } });
  return Boolean(m && memberCanApprove(m));
}

export async function markPosted(draftId: string, postedRedditId: string, now: Date = new Date()) {
  return prisma.$transaction(async (tx) => {
    const d = await tx.draft.update({
      where: { id: draftId },
      data: { status: 'posted', postedRedditId, postedAt: now },
      include: {
        account: { select: { username: true, disclosureLine: true } },
        agent: { select: { name: true } },
      },
    });
    if (d.opportunityId)
      await tx.opportunity.update({ where: { id: d.opportunityId }, data: { status: 'replied' } });
    // Outbound messages always link the Draft they came from.
    if (d.conversationId) {
      await tx.message.create({
        data: {
          workspaceId: d.workspaceId,
          conversationId: d.conversationId,
          direction: 'out',
          accountId: d.accountId,
          draftId: d.id,
          redditId: postedRedditId,
          author: d.account.username,
          body: d.body,
          sentAt: now,
        },
      });
      await tx.conversation.update({
        where: { id: d.conversationId },
        data: { lastMessageAt: now, needsReply: false },
      });
    }
    await writeAudit(
      {
        workspaceId: d.workspaceId,
        actorMemberId: null,
        action: 'draft.posted',
        targetType: 'Draft',
        targetId: d.id,
        accountId: d.accountId,
        meta: {
          approverMemberId: d.approverMemberId,
          account: d.account.username,
          agent: d.agent.name,
          postedRedditId,
          disclosurePresent: containsDisclosure(d.body, d.account.disclosureLine),
        },
      },
      tx,
    );
    return d;
  });
}

export async function markFailed(draftId: string, error: string) {
  return prisma.$transaction(async (tx) => {
    const d = await tx.draft.update({ where: { id: draftId }, data: { status: 'failed' } });
    await writeAudit(
      {
        workspaceId: d.workspaceId,
        actorMemberId: null,
        action: 'draft.failed',
        targetType: 'Draft',
        targetId: d.id,
        accountId: d.accountId,
        meta: { error },
      },
      tx,
    );
    return d;
  });
}

// ───────────────────────── agent output (draft.generate) ─────────────────────────

/** Everything draft.generate needs to build the prompt and tools. */
export async function generationContext(input: {
  workspaceId: string;
  agentId: string;
  draftId?: string;
  opportunityId?: string;
  conversationId?: string;
}) {
  const [workspace, agent, existing] = await Promise.all([
    prisma.workspace.findUniqueOrThrow({ where: { id: input.workspaceId } }),
    prisma.agent.findFirstOrThrow({
      where: { id: input.agentId, workspaceId: input.workspaceId },
      include: { account: true, skills: true },
    }),
    input.draftId ? get(input.workspaceId, input.draftId) : Promise.resolve(null),
  ]);
  const opportunityId = input.opportunityId ?? existing?.opportunityId ?? undefined;
  const conversationId = input.conversationId ?? existing?.conversationId ?? undefined;
  const opportunity = opportunityId
    ? await prisma.opportunity.findFirst({
        where: { id: opportunityId, workspaceId: input.workspaceId },
        include: { post: { include: { subreddit: true } }, keywordGroup: true },
      })
    : null;
  const conversation = conversationId
    ? await prisma.conversation.findFirst({
        where: { id: conversationId, workspaceId: input.workspaceId },
        include: {
          messages: { orderBy: { sentAt: 'asc' } },
          lead: { include: { redditUser: true } },
          post: { include: { subreddit: true } },
        },
      })
    : null;
  return { workspace, agent, existing, opportunity, conversation };
}

/** Keyword search over the agent's ContextItems (pgvector similarity replaces this once embeddings exist). */
export async function searchContext(agentId: string, query: string, take = 8) {
  const terms = query
    .toLowerCase()
    .split(/\W+/)
    .filter((t) => t.length > 2)
    .slice(0, 6);
  const items = await prisma.contextItem.findMany({
    where: {
      agentId,
      ...(terms.length
        ? {
            OR: terms.flatMap((t) => [
              { title: { contains: t, mode: 'insensitive' as const } },
              { content: { contains: t, mode: 'insensitive' as const } },
            ]),
          }
        : {}),
    },
    orderBy: { freshAt: 'desc' },
    take,
  });
  return items.map((i) => ({
    title: i.title,
    kind: i.kind,
    source: i.sourceUrl,
    content: i.content.slice(0, 2000),
  }));
}

/** Saves agent output as a pending Draft (new) or as the next version of an existing one (regenerate). */
export async function saveGenerated(input: {
  workspaceId: string;
  agentId: string;
  accountId: string;
  type: DraftType;
  body: string;
  reasoning: string;
  title?: string | null;
  draftId?: string;
  opportunityId?: string | null;
  conversationId?: string | null;
  subredditId?: string | null;
  trackedLinkId?: string | null;
  agentName: string;
}) {
  const now = new Date();
  const id = await prisma.$transaction(async (tx) => {
    let draftId = input.draftId;
    if (draftId) {
      const prev = await tx.draft.findUniqueOrThrow({ where: { id: draftId } });
      const hist = [
        ...((prev.bodyHistory as unknown[]) ?? []),
        {
          body: input.body,
          at: now.toISOString(),
          by: input.agentName,
          instruction: prev.regenerateInstruction,
        },
      ];
      await tx.draft.update({
        where: { id: draftId },
        data: {
          body: input.body,
          reasoning: input.reasoning,
          bodyHistory: hist as Prisma.InputJsonValue,
          regenerateInstruction: null,
          status: 'pending',
          trackedLinkId: input.trackedLinkId ?? prev.trackedLinkId,
        },
      });
    } else {
      const d = await tx.draft.create({
        data: {
          workspaceId: input.workspaceId,
          agentId: input.agentId,
          accountId: input.accountId,
          type: input.type,
          title: input.title ?? null,
          body: input.body,
          reasoning: input.reasoning,
          opportunityId: input.opportunityId ?? null,
          conversationId: input.conversationId ?? null,
          subredditId: input.subredditId ?? null,
          trackedLinkId: input.trackedLinkId ?? null,
          status: 'pending',
          bodyHistory: [{ body: input.body, at: now.toISOString(), by: input.agentName }],
        },
      });
      draftId = d.id;
      if (input.opportunityId)
        await tx.opportunity.update({ where: { id: input.opportunityId }, data: { status: 'drafting' } });
    }
    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorMemberId: null,
        action: input.draftId ? 'draft.regenerated' : 'draft.created',
        targetType: 'Draft',
        targetId: draftId,
        accountId: input.accountId,
        meta: { agent: input.agentName, type: input.type },
      },
      tx,
    );
    return draftId;
  });
  // Rule checks are stored for the queue view; approval re-evaluates them anyway.
  const d = await get(input.workspaceId, id);
  if (d) {
    const checks = await evaluate(d, now);
    await prisma.draft.update({
      where: { id },
      data: { ruleChecks: checks as unknown as Prisma.InputJsonValue },
    });
  }
  return id;
}

/** Mints a TrackedLink for a draft (called only when the subreddit's link rule allows one today). */
export async function mintTrackedLink(input: {
  workspaceId: string;
  destinationUrl: string;
  medium: 'comment' | 'dm' | 'post';
  subredditId?: string | null;
  subredditName?: string | null;
  postId?: string | null;
  postRedditId?: string | null;
  agentId: string;
  agentName: string;
}) {
  const utm = buildUtm({
    medium: input.medium,
    subreddit: input.subredditName,
    postId: input.postRedditId,
    agent: input.agentName,
  });
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await prisma.trackedLink.create({
        data: {
          workspaceId: input.workspaceId,
          slug: makeSlug(),
          destinationUrl: input.destinationUrl,
          medium: input.medium,
          subredditId: input.subredditId ?? null,
          postId: input.postId ?? null,
          agentId: input.agentId,
          utm: { ...utm, full: withUtm(input.destinationUrl, utm) } as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      if ((e as { code?: string }).code !== 'P2002') throw e; // slug collision: retry
    }
  }
  throw new Error('could not mint a unique slug');
}
