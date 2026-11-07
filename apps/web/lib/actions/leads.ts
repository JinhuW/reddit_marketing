'use server';

import { ForbiddenError, requireRole } from '@/lib/session';
import { leads } from '@threadline/db';
import { type LeadStage, MoveLeadStageInput } from '@threadline/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

export type ActionResult = { ok: true } | { ok: false; error: string };

const fail = (e: unknown): ActionResult => ({
  ok: false,
  error:
    e instanceof ForbiddenError || e instanceof leads.LeadNotFoundError
      ? e.message
      : 'Something went wrong. Try again.',
});

/** Drag-to-stage and the stage stepper. Editors and above; audited in the same transaction. */
export async function moveStage(input: { leadId: string; stage: LeadStage }): Promise<ActionResult> {
  try {
    const me = await requireRole('editor');
    const data = MoveLeadStageInput.parse(input);
    await leads.moveStage({
      workspaceId: me.workspaceId,
      leadId: data.leadId,
      stage: data.stage,
      actorMemberId: me.id,
    });
    revalidatePath('/leads');
    revalidatePath(`/leads/${data.leadId}`);
    revalidatePath('/conversations');
    return { ok: true };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: 'Unknown stage.' };
    return fail(e);
  }
}

const NoteInput = z.object({ leadId: z.string().min(1), body: z.string().trim().min(1).max(4000) });

export async function addNote(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const me = await requireRole('editor');
    const data = NoteInput.parse({ leadId: form.get('leadId'), body: form.get('body') });
    await leads.addNote({
      workspaceId: me.workspaceId,
      leadId: data.leadId,
      by: me.user.name ?? me.user.email,
      body: data.body,
    });
    revalidatePath(`/leads/${data.leadId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: 'Write a note first.' };
    return fail(e);
  }
}

const TaskInput = z.object({
  leadId: z.string().min(1),
  title: z.string().trim().min(1).max(300),
  dueAt: z
    .string()
    .optional()
    .transform((v) => (v ? new Date(`${v}T12:00:00`) : null)),
});

export async function addTask(_prev: ActionResult | null, form: FormData): Promise<ActionResult> {
  try {
    const me = await requireRole('editor');
    const data = TaskInput.parse({
      leadId: form.get('leadId'),
      title: form.get('title'),
      dueAt: (form.get('dueAt') as string) || undefined,
    });
    await leads.addTask({
      workspaceId: me.workspaceId,
      leadId: data.leadId,
      title: data.title,
      dueAt: data.dueAt,
    });
    revalidatePath(`/leads/${data.leadId}`);
    return { ok: true };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: 'Give the task a title.' };
    return fail(e);
  }
}

export async function setTaskDone(input: {
  taskId: string;
  leadId: string;
  done: boolean;
}): Promise<ActionResult> {
  try {
    const me = await requireRole('editor');
    await leads.setTaskDone({
      workspaceId: me.workspaceId,
      taskId: z.string().parse(input.taskId),
      done: !!input.done,
    });
    revalidatePath(`/leads/${input.leadId}`);
    return { ok: true };
  } catch (e) {
    return fail(e);
  }
}
