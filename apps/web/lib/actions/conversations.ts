'use server';

import { enqueue } from '@/lib/queue';
import { ForbiddenError, requireMember, requireRole } from '@/lib/session';
import { audit, conversations, prisma } from '@threadline/db';
import { revalidatePath } from 'next/cache';

export type AskDraftResult = { ok: true; message: string } | { ok: false; error: string } | null;

const DM_REFUSAL = 'DM follow-ups are only allowed after this person messaged or replied to us.';

/** Opening a conversation marks it read. */
export async function markConversationRead(conversationId: string) {
  const me = await requireMember();
  // No revalidatePath here: a refresh would race the user's next click in the list.
  // The sidebar badge updates over SSE.
  await conversations.markRead(me.workspaceId, conversationId);
}

/**
 * "Ask <agent> to draft": queues draft.generate for this conversation. The resulting Draft goes to Approvals.
 * DMs are refused unless the person has sent us at least one inbound message (docs/PLAN.md §10, block rule).
 */
export async function askAgentToDraft(_prev: AskDraftResult, form: FormData): Promise<AskDraftResult> {
  try {
    const me = await requireRole('editor');
    const conversationId = String(form.get('conversationId') ?? '');
    const instruction = String(form.get('instruction') ?? '').trim() || undefined;
    const conv = await prisma.conversation.findFirst({
      where: { workspaceId: me.workspaceId, id: conversationId },
      include: { lead: { include: { agent: { select: { id: true, name: true } } } } },
    });
    if (!conv) return { ok: false, error: 'Conversation not found.' };
    const agent = conv.lead.agent;
    if (!agent) return { ok: false, error: 'Assign an agent to this lead first.' };
    const type = conv.kind === 'dm' ? 'dm' : 'comment';
    if (type === 'dm' && (await conversations.inboundCount(me.workspaceId, conv.id)) === 0) {
      return { ok: false, error: DM_REFUSAL };
    }
    await enqueue.draftGenerate(
      {
        workspaceId: me.workspaceId,
        conversationId: conv.id,
        agentId: agent.id,
        type,
        instruction,
        requestedByMemberId: me.id,
      },
      Date.now(),
    );
    await audit.writeAudit({
      workspaceId: me.workspaceId,
      actorMemberId: me.id,
      action: 'draft.requested',
      targetType: 'Conversation',
      targetId: conv.id,
      meta: { agent: agent.name, type, instruction: instruction ?? null },
    });
    return { ok: true, message: `${agent.name} is drafting. It will appear in Approvals.` };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, error: e.message };
    console.error('[askAgentToDraft]', e);
    return { ok: false, error: 'Could not queue the draft. Try again.' };
  }
}
