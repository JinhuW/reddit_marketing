import type { Prisma, PrismaClient } from '@prisma/client';
import type { AuditAction } from '@threadline/shared';
import { prisma } from '../client';

type Tx = Prisma.TransactionClient | PrismaClient;

export interface AuditInput {
  workspaceId: string;
  actorMemberId: string | null;
  action: AuditAction | 'session.log';
  targetType: string;
  targetId: string;
  accountId?: string | null;
  sessionId?: string | null;
  meta?: Prisma.InputJsonValue;
}

/** Append-only audit write. Pass the transaction client so the audit row commits with the change. */
export function writeAudit(input: AuditInput, tx: Tx = prisma) {
  return tx.auditEvent.create({
    data: {
      workspaceId: input.workspaceId,
      actorMemberId: input.actorMemberId,
      action: input.action,
      targetType: input.targetType,
      targetId: input.targetId,
      accountId: input.accountId ?? null,
      sessionId: input.sessionId ?? null,
      meta: input.meta ?? {},
    },
  });
}

export async function listAudit(workspaceId: string, opts: { take?: number; actions?: string[] } = {}) {
  return prisma.auditEvent.findMany({
    where: {
      workspaceId,
      action: opts.actions ? { in: opts.actions } : { not: 'session.log' },
    },
    orderBy: { at: 'desc' },
    take: opts.take ?? 50,
    include: {
      actor: { include: { user: { select: { name: true } } } },
      account: { select: { username: true } },
    },
  });
}
