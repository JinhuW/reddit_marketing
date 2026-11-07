'use server';

import { enqueue } from '@/lib/queue';
import { ForbiddenError, requireRole } from '@/lib/session';
import { audit, opportunities, prisma } from '@threadline/db';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

async function guard<T>(fn: () => Promise<T>): Promise<T | ActionResult> {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
}

async function bulkStatus(
  ids: string[],
  status: 'skipped' | 'watched',
  action: 'opportunity.skipped' | 'opportunity.watched',
) {
  return guard(async (): Promise<ActionResult> => {
    const me = await requireRole('editor');
    const owned = await opportunities.ownedIds(me.workspaceId, ids);
    if (!owned.length) return { ok: false, error: 'Select at least one opportunity.' };
    await prisma.$transaction(async (tx) => {
      await tx.opportunity.updateMany({
        where: { workspaceId: me.workspaceId, id: { in: owned } },
        data: { status },
      });
      for (const id of owned)
        await audit.writeAudit(
          {
            workspaceId: me.workspaceId,
            actorMemberId: me.id,
            action,
            targetType: 'Opportunity',
            targetId: id,
          },
          tx,
        );
    });
    revalidatePath('/opportunities');
    revalidatePath('/');
    return { ok: true, message: `${owned.length} ${status === 'skipped' ? 'skipped' : 'marked as watched'}` };
  }) as Promise<ActionResult>;
}

export async function skipOpportunities(ids: string[]) {
  return bulkStatus(ids, 'skipped', 'opportunity.skipped');
}

export async function watchOpportunities(ids: string[]) {
  return bulkStatus(ids, 'watched', 'opportunity.watched');
}

export async function markAllWatched() {
  return guard(async (): Promise<ActionResult> => {
    const me = await requireRole('editor');
    const ids = await opportunities.newIds(me.workspaceId);
    if (!ids.length) return { ok: true, message: 'Nothing new to mark.' };
    return bulkStatus(ids, 'watched', 'opportunity.watched');
  }) as Promise<ActionResult>;
}

export async function assignOpportunities(ids: string[], agentId: string) {
  return guard(async (): Promise<ActionResult> => {
    const me = await requireRole('editor');
    const agent = await opportunities.agentInWorkspace(me.workspaceId, agentId);
    if (!agent) return { ok: false, error: 'Pick an agent.' };
    const owned = await opportunities.ownedIds(me.workspaceId, ids);
    if (!owned.length) return { ok: false, error: 'Select at least one opportunity.' };
    await prisma.$transaction(async (tx) => {
      await tx.opportunity.updateMany({
        where: { workspaceId: me.workspaceId, id: { in: owned } },
        data: { suggestedAgentId: agent.id },
      });
      for (const id of owned)
        await audit.writeAudit(
          {
            workspaceId: me.workspaceId,
            actorMemberId: me.id,
            action: 'opportunity.assigned',
            targetType: 'Opportunity',
            targetId: id,
            meta: { agent: agent.name },
          },
          tx,
        );
    });
    revalidatePath('/opportunities');
    return { ok: true, message: `${owned.length} assigned to ${agent.name}` };
  }) as Promise<ActionResult>;
}

/** Queues draft.generate for the opportunity's suggested agent, then opens Approvals. */
export async function generateDraft(opportunityId: string): Promise<ActionResult> {
  let me: Awaited<ReturnType<typeof requireRole>>;
  try {
    me = await requireRole('editor');
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    throw e;
  }
  const opp = await opportunities.get(me.workspaceId, opportunityId);
  if (!opp) return { ok: false, error: 'Opportunity not found.' };
  if (!opp.agent) return { ok: false, error: 'Assign an agent before generating a draft.' };
  const version = (await opportunities.draftCount(opportunityId)) + 1;
  try {
    await enqueue.draftGenerate(
      {
        workspaceId: me.workspaceId,
        opportunityId,
        agentId: opp.agent.id,
        type: 'comment',
        requestedByMemberId: me.id,
      },
      version,
    );
  } catch {
    return {
      ok: false,
      error: 'Could not reach the job queue (Redis). The draft was not requested; try again shortly.',
    };
  }
  await prisma.$transaction(async (tx) => {
    await tx.opportunity.update({ where: { id: opportunityId }, data: { status: 'drafting' } });
    await audit.writeAudit(
      {
        workspaceId: me.workspaceId,
        actorMemberId: me.id,
        action: 'opportunity.assigned',
        targetType: 'Opportunity',
        targetId: opportunityId,
        meta: { agent: opp.agent!.name, draftRequested: true },
      },
      tx,
    );
  });
  revalidatePath('/opportunities');
  redirect('/approvals');
}
