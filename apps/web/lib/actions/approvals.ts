'use server';

import { enqueue } from '@/lib/queue';
import { ForbiddenError, requireRole } from '@/lib/session';
import { PolicyError } from '@threadline/agents';
import { drafts } from '@threadline/db';
import {
  ApproveDraftInput,
  RegenerateDraftInput,
  RejectDraftInput,
  ScheduleDraftInput,
} from '@threadline/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

export type ActionResult = { ok: true; message?: string } | { ok: false; error: string };

function fail(e: unknown): ActionResult {
  if (e instanceof PolicyError || e instanceof ForbiddenError) return { ok: false, error: e.message };
  if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? 'Invalid input.' };
  console.error('[approvals]', e);
  return { ok: false, error: 'Something went wrong. Try again.' };
}

async function queuePost(workspaceId: string, draftId: string, delayMs = 0) {
  try {
    await enqueue.postPublish({ workspaceId, draftId }, Math.max(0, delayMs));
    return delayMs > 0 ? 'Scheduled. It will post at the chosen time.' : 'Approved. Posting now.';
  } catch (e) {
    console.error('[approvals] enqueue post.publish failed', e);
    return 'Approved. The posting queue is unavailable; the worker will pick it up when it reconnects.';
  }
}

export async function approveDraft(input: { draftId: string; body?: string }): Promise<ActionResult> {
  try {
    const me = await requireRole('approver', { approve: true });
    const data = ApproveDraftInput.parse(input);
    await drafts.approve(data.draftId, me, { body: data.body });
    const message = await queuePost(me.workspaceId, data.draftId);
    revalidatePath('/approvals');
    return { ok: true, message };
  } catch (e) {
    return fail(e);
  }
}

export async function scheduleDraft(input: {
  draftId: string;
  at: string;
  body?: string;
}): Promise<ActionResult> {
  try {
    const me = await requireRole('approver', { approve: true });
    const data = ScheduleDraftInput.parse(input);
    await drafts.schedule(data.draftId, me, data.at, { body: input.body });
    const message = await queuePost(me.workspaceId, data.draftId, data.at.getTime() - Date.now());
    revalidatePath('/approvals');
    return { ok: true, message };
  } catch (e) {
    return fail(e);
  }
}

export async function rejectDraft(input: { draftId: string; reason: string }): Promise<ActionResult> {
  try {
    const me = await requireRole('approver', { approve: true });
    const data = RejectDraftInput.parse(input);
    await drafts.reject(data.draftId, me, data.reason);
    revalidatePath('/approvals');
    return { ok: true, message: 'Rejected. The agent will see your reason.' };
  } catch (e) {
    return fail(e);
  }
}

export async function editDraft(input: { draftId: string; body: string }): Promise<ActionResult> {
  try {
    const me = await requireRole('editor');
    const data = z
      .object({ draftId: z.string(), body: z.string().trim().min(1, 'The draft cannot be empty.') })
      .parse(input);
    await drafts.edit(data.draftId, me, input.body);
    revalidatePath('/approvals');
    return { ok: true, message: 'Saved.' };
  } catch (e) {
    return fail(e);
  }
}

export async function regenerateDraft(input: {
  draftId: string;
  instruction: string;
}): Promise<ActionResult> {
  try {
    const me = await requireRole('editor');
    const data = RegenerateDraftInput.parse(input);
    const { draft, version } = await drafts.requestRegenerate(data.draftId, me, data.instruction);
    try {
      await enqueue.draftGenerate(
        {
          workspaceId: me.workspaceId,
          draftId: draft.id,
          opportunityId: draft.opportunityId ?? undefined,
          conversationId: draft.conversationId ?? undefined,
          agentId: draft.agentId,
          type: draft.type,
          instruction: data.instruction,
          requestedByMemberId: me.id,
        },
        version,
      );
    } catch (e) {
      console.error('[approvals] enqueue draft.generate failed', e);
      return {
        ok: true,
        message: 'Instruction saved. The agent queue is unavailable; it will regenerate when it reconnects.',
      };
    }
    revalidatePath('/approvals');
    return { ok: true, message: 'Sent back to the agent with your instruction.' };
  } catch (e) {
    return fail(e);
  }
}
