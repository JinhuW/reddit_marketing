import type { Prisma } from '@prisma/client';
// Repository functions for the Agents screen (docs/PLAN.md §7 row 6).
import type { ConnectorProvider, ContextKind, SkillKey } from '@threadline/shared';
import { prisma } from '../client';
import { PLAN_LIMITS } from './shell';

export interface AgentPersona {
  focus?: string;
  voice?: { formal?: number; playful?: number; concise?: number; technical?: number };
  dos?: string[];
  donts?: string[];
  disclosure?: string;
  samples?: string[];
  subreddits?: string[];
}

export const asPersona = (v: Prisma.JsonValue | null | undefined): AgentPersona =>
  v && typeof v === 'object' && !Array.isArray(v) ? (v as AgentPersona) : {};

const DAY = 86_400_000;

/** Revenue (cents) attributed to leads owned by each agent. */
async function revenueByAgent(workspaceId: string, agentIds: string[]) {
  const rows = await prisma.attribution.findMany({
    where: { workspaceId, lead: { agentId: { in: agentIds } }, siteEvent: { kind: 'payment' } },
    select: {
      weight: true,
      lead: { select: { agentId: true } },
      siteEvent: { select: { amountCents: true } },
    },
  });
  const out = new Map<string, number>();
  for (const r of rows) {
    const id = r.lead?.agentId;
    if (id) out.set(id, (out.get(id) ?? 0) + Math.round(r.siteEvent.amountCents * r.weight));
  }
  return out;
}

const DECIDED = ['approved', 'scheduled', 'posted', 'rejected'] as const;
const APPROVED = ['approved', 'scheduled', 'posted'] as const;

/** Cards for the agent list: identity, coverage and 30-day stats. */
export async function listCards(workspaceId: string, now = new Date()) {
  const since = new Date(now.getTime() - 30 * DAY);
  const agents = await prisma.agent.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    include: {
      account: { select: { username: true } },
      keywordGroups: { select: { subreddits: true } },
    },
  });
  const ids = agents.map((a) => a.id);
  const [drafts, decided, approved, leads, revenue] = await Promise.all([
    prisma.draft.groupBy({
      by: ['agentId'],
      where: { workspaceId, agentId: { in: ids }, createdAt: { gte: since } },
      _count: true,
    }),
    prisma.draft.groupBy({
      by: ['agentId'],
      where: { workspaceId, agentId: { in: ids }, status: { in: [...DECIDED] } },
      _count: true,
    }),
    prisma.draft.groupBy({
      by: ['agentId'],
      where: { workspaceId, agentId: { in: ids }, status: { in: [...APPROVED] } },
      _count: true,
    }),
    prisma.lead.groupBy({ by: ['agentId'], where: { workspaceId, agentId: { in: ids } }, _count: true }),
    revenueByAgent(workspaceId, ids),
  ]);
  const count = (rows: { agentId: string | null; _count: number }[], id: string) =>
    rows.find((r) => r.agentId === id)?._count ?? 0;
  return agents.map((a) => {
    const persona = asPersona(a.persona);
    const subs = Array.isArray(persona.subreddits)
      ? persona.subreddits
      : [...new Set(a.keywordGroups.flatMap((g) => g.subreddits))];
    const dec = count(decided, a.id);
    return {
      id: a.id,
      name: a.name,
      roleTitle: a.roleTitle,
      focus: persona.focus ?? null,
      color: a.color,
      status: a.status,
      account: a.account?.username ?? null,
      subreddits: subs,
      drafts30d: count(drafts, a.id),
      approvalRate: dec ? count(approved, a.id) / dec : null,
      leads: count(leads, a.id),
      revenueCents: revenue.get(a.id) ?? 0,
    };
  });
}
export type AgentCard = Awaited<ReturnType<typeof listCards>>[number];

export async function get(workspaceId: string, id: string) {
  return prisma.agent.findFirst({
    where: { workspaceId, id },
    include: {
      account: { select: { id: true, username: true, disclosureLine: true } },
      approver: { include: { user: { select: { name: true } } } },
      skills: { orderBy: { key: 'asc' } },
      contextItems: { orderBy: { freshAt: 'desc' } },
      connectors: true,
      keywordGroups: { select: { id: true, name: true, subreddits: true } },
    },
  });
}
export type AgentDetail = NonNullable<Awaited<ReturnType<typeof get>>>;

/** Options for the Assignment tab. Approvers are limited to members who can approve. */
export async function assignmentOptions(workspaceId: string) {
  const [accounts, approvers, groups] = await Promise.all([
    prisma.redditAccount.findMany({
      where: { workspaceId },
      select: { id: true, username: true },
      orderBy: { createdAt: 'asc' },
    }),
    prisma.workspaceMember.findMany({
      where: { workspaceId, canApprove: true, role: { in: ['admin', 'approver'] } },
      select: { id: true, user: { select: { name: true, email: true } } },
    }),
    prisma.keywordGroup.findMany({
      where: { workspaceId },
      select: { id: true, name: true, agentId: true },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  return { accounts, approvers, groups };
}

/** Performance tab numbers. */
export async function performance(workspaceId: string, agentId: string) {
  const [total, decided, approved, posted, edits, leads, links, revenue, byStatus] = await Promise.all([
    prisma.draft.count({ where: { workspaceId, agentId } }),
    prisma.draft.count({ where: { workspaceId, agentId, status: { in: [...DECIDED] } } }),
    prisma.draft.count({ where: { workspaceId, agentId, status: { in: [...APPROVED] } } }),
    prisma.draft.count({ where: { workspaceId, agentId, status: 'posted' } }),
    prisma.draft.aggregate({
      where: { workspaceId, agentId, status: { in: [...DECIDED] } },
      _avg: { editCount: true },
    }),
    prisma.lead.count({ where: { workspaceId, agentId } }),
    prisma.trackedLink.aggregate({ where: { workspaceId, agentId }, _sum: { clicks: true } }),
    revenueByAgent(workspaceId, [agentId]),
    prisma.draft.groupBy({ by: ['status'], where: { workspaceId, agentId }, _count: true }),
  ]);
  return {
    drafts: total,
    approvalRate: decided ? approved / decided : null,
    avgEdits: edits._avg.editCount ?? 0,
    replies: posted,
    leads,
    clicks: links._sum.clicks ?? 0,
    revenueCents: revenue.get(agentId) ?? 0,
    byStatus: byStatus.map((s) => ({ status: s.status, n: s._count })),
  };
}

// ───────────────────────── mutations ─────────────────────────

export class PlanLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PlanLimitError';
  }
}

export async function create(
  workspaceId: string,
  input: {
    name: string;
    roleTitle: string;
    focus?: string;
    color: string;
    accountId?: string | null;
    approverMemberId?: string | null;
  },
) {
  return prisma.$transaction(async (tx) => {
    const [ws, n] = await Promise.all([
      tx.workspace.findUniqueOrThrow({ where: { id: workspaceId }, select: { plan: true } }),
      tx.agent.count({ where: { workspaceId } }),
    ]);
    const limit = PLAN_LIMITS[ws.plan].agents;
    if (n >= limit)
      throw new PlanLimitError(
        `Your ${ws.plan[0]!.toUpperCase()}${ws.plan.slice(1)} plan includes ${limit} agents. Upgrade the plan or remove an agent first.`,
      );
    const agent = await tx.agent.create({
      data: {
        workspaceId,
        name: input.name,
        roleTitle: input.roleTitle,
        color: input.color,
        status: 'paused',
        accountId: input.accountId ?? null,
        approverMemberId: input.approverMemberId ?? null,
        persona: {
          focus: input.focus ?? '',
          voice: { formal: 50, playful: 25, concise: 60, technical: 50 },
          dos: [],
          donts: [],
          samples: [],
          subreddits: [],
        },
      },
    });
    const keys: SkillKey[] = ['compare_answer', 'launch_post', 'demo_followup', 'thread_to_blog'];
    await tx.agentSkill.createMany({
      data: keys.map((key) => ({ workspaceId, agentId: agent.id, key, enabled: key === 'compare_answer' })),
    });
    const providers: ConnectorProvider[] = [
      'notion',
      'gdrive',
      'hubspot',
      'attio',
      'slack',
      'ga4',
      'posthog',
      'stripe',
      'calendly',
    ];
    await tx.connector.createMany({
      data: providers.map((provider) => ({
        workspaceId,
        agentId: agent.id,
        provider,
        status:
          provider === 'notion' || provider === 'gdrive' || provider === 'hubspot'
            ? 'disconnected'
            : 'coming_soon',
      })),
    });
    return agent;
  });
}

async function owned(workspaceId: string, id: string) {
  const a = await prisma.agent.findFirst({ where: { workspaceId, id }, select: { id: true, persona: true } });
  if (!a) throw new Error('Agent not found');
  return a;
}

export async function updatePersona(
  workspaceId: string,
  id: string,
  input: { name: string; roleTitle: string; persona: Omit<AgentPersona, 'subreddits'> },
) {
  const a = await owned(workspaceId, id);
  const prev = asPersona(a.persona);
  return prisma.agent.update({
    where: { id },
    data: {
      name: input.name,
      roleTitle: input.roleTitle,
      persona: { ...prev, ...input.persona } as Prisma.InputJsonValue,
    },
  });
}

export async function setSkill(
  workspaceId: string,
  agentId: string,
  key: SkillKey,
  enabled: boolean,
  promptOverride: string | null,
) {
  await owned(workspaceId, agentId);
  return prisma.agentSkill.upsert({
    where: { agentId_key: { agentId, key } },
    create: { workspaceId, agentId, key, enabled, promptOverride },
    update: { enabled, promptOverride },
  });
}

/** Adds a context item; the embedding is filled later by the context.embed queue. */
export async function addContext(
  workspaceId: string,
  agentId: string,
  input: { kind: ContextKind; title: string; sourceUrl: string | null; content: string },
) {
  await owned(workspaceId, agentId);
  return prisma.contextItem.create({ data: { workspaceId, agentId, ...input } });
}

export async function deleteContext(workspaceId: string, agentId: string, itemId: string) {
  return prisma.contextItem.deleteMany({ where: { workspaceId, agentId, id: itemId } });
}

export async function setConnector(
  workspaceId: string,
  agentId: string,
  provider: ConnectorProvider,
  connected: boolean,
  tools: string[],
) {
  const c = await prisma.connector.findFirst({ where: { workspaceId, agentId, provider } });
  if (!c) throw new Error('Connector not found');
  if (c.status === 'coming_soon') throw new Error('This connector is not available yet.');
  return prisma.connector.update({
    where: { id: c.id },
    data: { status: connected ? 'connected' : 'disconnected', permissions: connected ? { tools } : {} },
  });
}

export async function updateAssignment(
  workspaceId: string,
  agentId: string,
  input: {
    accountId: string | null;
    approverMemberId: string | null;
    dailyDraftLimit: number;
    status: 'active' | 'paused';
    keywordGroupIds: string[];
  },
) {
  await owned(workspaceId, agentId);
  return prisma.$transaction(async (tx) => {
    if (input.accountId) {
      const acc = await tx.redditAccount.findFirst({ where: { workspaceId, id: input.accountId } });
      if (!acc) throw new Error('Account not found');
    }
    if (input.approverMemberId) {
      const m = await tx.workspaceMember.findFirst({ where: { workspaceId, id: input.approverMemberId } });
      if (!m || !m.canApprove || (m.role !== 'admin' && m.role !== 'approver'))
        throw new Error('The approver must be a member who can approve.');
    }
    await tx.keywordGroup.updateMany({
      where: { workspaceId, agentId, id: { notIn: input.keywordGroupIds } },
      data: { agentId: null },
    });
    if (input.keywordGroupIds.length)
      await tx.keywordGroup.updateMany({
        where: { workspaceId, id: { in: input.keywordGroupIds } },
        data: { agentId },
      });
    return tx.agent.update({
      where: { id: agentId },
      data: {
        accountId: input.accountId,
        approverMemberId: input.approverMemberId,
        dailyDraftLimit: input.dailyDraftLimit,
        status: input.status,
      },
    });
  });
}

export async function setStatus(workspaceId: string, agentId: string, status: 'active' | 'paused') {
  await owned(workspaceId, agentId);
  return prisma.agent.update({ where: { id: agentId }, data: { status } });
}

/** Data the playground needs to assemble the system prompt. */
export async function playgroundContext(workspaceId: string, agentId: string) {
  const agent = await prisma.agent.findFirst({
    where: { workspaceId, id: agentId },
    include: {
      account: { select: { disclosureLine: true } },
      skills: true,
      workspace: { select: { name: true, settings: true } },
    },
  });
  if (!agent) return null;
  const persona = asPersona(agent.persona);
  const subName = persona.subreddits?.[0];
  const sub = subName
    ? await prisma.subreddit.findFirst({
        where: { workspaceId, name: subName },
        select: { name: true, linkRule: true, selfPromoPolicy: true },
      })
    : null;
  return { agent, persona, sub };
}
