import type { Prisma } from '@prisma/client';
// Repository functions for Settings (10): team, audit log, billing, workspaces, weekly report.
import type { MemberRole } from '@threadline/shared';
import { prisma } from '../client';
import { writeAudit } from './audit';

export async function team(workspaceId: string) {
  const rows = await prisma.workspaceMember.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    include: {
      user: {
        include: { sessions: { orderBy: { updatedAt: 'desc' }, take: 1, select: { updatedAt: true } } },
      },
      ownedAccount: { select: { username: true } },
    },
  });
  return rows.map((m) => ({
    id: m.id,
    userId: m.userId,
    name: m.user.name ?? m.user.email,
    email: m.user.email,
    role: m.role,
    canApprove: m.canApprove,
    account: m.ownedAccount?.username ?? null,
    lastActive: [m.updatedAt, m.user.sessions[0]?.updatedAt]
      .filter(Boolean)
      .sort((a, b) => b!.getTime() - a!.getTime())[0]!,
  }));
}

export class TeamError extends Error {}

/** Approver and Admin roles can approve; Editors and Viewers cannot (docs/PLAN.md §10 Human approval). */
const canApproveForRole = (role: MemberRole) => role === 'admin' || role === 'approver';

export async function invite(workspaceId: string, actorMemberId: string, email: string, role: MemberRole) {
  const normalized = email.trim().toLowerCase();
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.upsert({
      where: { email: normalized },
      create: { email: normalized },
      update: {},
    });
    const existing = await tx.workspaceMember.findUnique({
      where: { workspaceId_userId: { workspaceId, userId: user.id } },
    });
    if (existing) throw new TeamError(`${normalized} is already a member.`);
    const m = await tx.workspaceMember.create({
      data: { workspaceId, userId: user.id, role, canApprove: canApproveForRole(role) },
    });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'member.invited',
        targetType: 'WorkspaceMember',
        targetId: m.id,
        meta: { item: `Invited ${normalized} as ${role}`, email: normalized, role },
      },
      tx,
    );
    return m;
  });
}

export async function changeRole(
  workspaceId: string,
  actorMemberId: string,
  memberId: string,
  role: MemberRole,
) {
  return prisma.$transaction(async (tx) => {
    const m = await tx.workspaceMember.findFirstOrThrow({
      where: { workspaceId, id: memberId },
      include: { user: true },
    });
    if (m.role === role) return m;
    if (m.role === 'admin' && role !== 'admin') {
      const admins = await tx.workspaceMember.count({ where: { workspaceId, role: 'admin' } });
      if (admins <= 1) throw new TeamError('A workspace needs at least one admin.');
    }
    const updated = await tx.workspaceMember.update({
      where: { id: m.id },
      data: { role, canApprove: canApproveForRole(role) },
    });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'member.role_changed',
        targetType: 'WorkspaceMember',
        targetId: m.id,
        meta: { item: `${m.user.name ?? m.user.email}: ${m.role} → ${role}`, from: m.role, to: role },
      },
      tx,
    );
    return updated;
  });
}

// ── audit log ──

export const AUDIT_PAGE_SIZE = 50;

function actionLabel(
  action: string,
  meta: Record<string, unknown>,
): { label: string; tone: 'ok' | 'mid' | 'hot' | 'line' | 'bad' } {
  switch (action) {
    case 'draft.posted':
      return { label: meta.edits ? 'Edited, posted' : 'Posted', tone: 'ok' };
    case 'draft.approved':
      return { label: 'Approved', tone: 'ok' };
    case 'draft.rejected':
      return { label: 'Rejected', tone: 'mid' };
    case 'draft.scheduled':
      return { label: 'Scheduled', tone: 'hot' };
    case 'draft.failed':
      return { label: 'Failed', tone: 'bad' };
    case 'draft.created':
      return { label: 'Drafted', tone: 'line' };
    case 'draft.edited':
      return { label: 'Edited', tone: 'line' };
    case 'draft.regenerated':
      return { label: 'Regenerated', tone: 'line' };
    case 'lead.created':
    case 'lead.stage_changed':
      return { label: 'Lead stage', tone: 'line' };
    case 'session.started':
      return { label: 'Took over', tone: 'hot' };
    case 'session.handed_back':
    case 'session.ended':
      return { label: 'Handed back', tone: 'line' };
    case 'opportunity.skipped':
      return { label: 'Skipped', tone: 'mid' };
    case 'opportunity.watched':
      return { label: 'Watched', tone: 'line' };
    case 'opportunity.assigned':
      return { label: 'Assigned', tone: 'line' };
    case 'account.connected':
      return { label: 'Account connected', tone: 'ok' };
    case 'member.invited':
      return { label: 'Invited', tone: 'line' };
    case 'member.role_changed':
      return { label: 'Role changed', tone: 'line' };
    default:
      return { label: action, tone: 'line' };
  }
}

const cap = (v: unknown) => (typeof v === 'string' && v ? v.charAt(0).toUpperCase() + v.slice(1) : undefined);

function auditItem(action: string, meta: Record<string, unknown>, targetType: string): string {
  if (typeof meta.item === 'string') return meta.item;
  if (action === 'lead.stage_changed')
    return `${meta.lead ?? 'Lead'}: ${meta.from ?? '?'} → ${meta.to ?? '?'}`;
  if (action.startsWith('session.'))
    return `${meta.profile ?? 'Browser'}${meta.reason ? ` · ${meta.reason}` : ''}`;
  if (action === 'draft.created')
    return `${cap(meta.agent) ?? 'Agent'} drafted a ${meta.type === 'dm' ? 'DM' : (meta.type ?? 'reply')}`;
  if (typeof meta.title === 'string') return meta.title;
  return targetType;
}

export async function auditPage(workspaceId: string, page = 1, pageSize = AUDIT_PAGE_SIZE) {
  const where: Prisma.AuditEventWhereInput = { workspaceId, action: { not: 'session.log' } };
  const [total, rows] = await Promise.all([
    prisma.auditEvent.count({ where }),
    prisma.auditEvent.findMany({
      where,
      orderBy: { at: 'desc' },
      skip: (Math.max(1, page) - 1) * pageSize,
      take: pageSize,
      include: {
        actor: { include: { user: { select: { name: true } } } },
        account: { select: { username: true } },
      },
    }),
  ]);
  return {
    total,
    page,
    pages: Math.max(1, Math.ceil(total / pageSize)),
    rows: rows.map((r) => {
      const meta = (r.meta ?? {}) as Record<string, unknown>;
      const { label, tone } = actionLabel(r.action, meta);
      return {
        id: r.id,
        at: r.at,
        action: r.action,
        label,
        tone,
        item: auditItem(r.action, meta, r.targetType),
        agent: cap(meta.agent) ?? '—',
        by: r.actor?.user.name ?? 'System',
        from: r.action === 'draft.posted' && r.account ? `u/${r.account.username}` : '—',
        disclosure: typeof meta.disclosure === 'boolean' ? meta.disclosure : null,
      };
    }),
  };
}

// ── workspaces and reports ──

export function workspaces(workspaceId: string) {
  return prisma.workspace.findMany({
    where: { OR: [{ id: workspaceId }, { parentWorkspaceId: workspaceId }] },
    orderBy: { createdAt: 'asc' },
    select: { id: true, name: true, slug: true, plan: true, parentWorkspaceId: true },
  });
}

export interface WeeklyReport {
  enabled: boolean;
  day: string;
  recipients: string[];
}

export async function weeklyReport(workspaceId: string): Promise<WeeklyReport> {
  const ws = await prisma.workspace.findUniqueOrThrow({
    where: { id: workspaceId },
    select: { settings: true },
  });
  const r = ((ws.settings ?? {}) as Record<string, unknown>).weeklyReport as
    | Partial<WeeklyReport>
    | undefined;
  return { enabled: r?.enabled ?? false, day: r?.day ?? 'monday', recipients: r?.recipients ?? [] };
}

export async function saveWeeklyReport(workspaceId: string, actorMemberId: string, report: WeeklyReport) {
  return prisma.$transaction(async (tx) => {
    const ws = await tx.workspace.findUniqueOrThrow({
      where: { id: workspaceId },
      select: { settings: true },
    });
    const settings = { ...((ws.settings ?? {}) as Record<string, unknown>), weeklyReport: { ...report } };
    await tx.workspace.update({
      where: { id: workspaceId },
      data: { settings: settings as Prisma.InputJsonValue },
    });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'workspace.report_updated',
        targetType: 'Workspace',
        targetId: workspaceId,
        meta: {
          item: `Weekly report ${report.enabled ? `on, ${report.day}` : 'off'} · ${report.recipients.length} recipients`,
        },
      },
      tx,
    );
  });
}
