'use server';

import type { ActionState } from '@/components/settings/action-state';
import { ForbiddenError, requireRole } from '@/lib/session';
import { settings } from '@threadline/db';
import { MemberRole } from '@threadline/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const guard = async <T>(fn: () => Promise<T>): Promise<T | ActionState> => {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof settings.TeamError)
      return { ok: false, message: e.message };
    throw e;
  }
};

export async function inviteMemberAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({ email: z.string().trim().email(), role: z.enum(MemberRole) })
    .safeParse({ email: form.get('email'), role: form.get('role') });
  if (!parsed.success) return { ok: false, message: 'Enter a valid email and role.' };
  const res = await guard(async () => {
    const me = await requireRole('admin');
    await settings.invite(me.workspaceId, me.id, parsed.data.email, parsed.data.role);
    return { ok: true, message: `Invited ${parsed.data.email}. They can sign in with a magic link.` };
  });
  revalidatePath('/settings');
  return res;
}

export async function changeRoleAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const parsed = z
    .object({ memberId: z.string().min(1), role: z.enum(MemberRole) })
    .safeParse({ memberId: form.get('memberId'), role: form.get('role') });
  if (!parsed.success) return { ok: false, message: 'Pick a role.' };
  const res = await guard(async () => {
    const me = await requireRole('admin');
    await settings.changeRole(me.workspaceId, me.id, parsed.data.memberId, parsed.data.role);
    return { ok: true, message: 'Role updated.' };
  });
  revalidatePath('/settings');
  return res;
}

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;

export async function saveReportAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const recipients = String(form.get('recipients') ?? '')
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const parsed = z
    .object({ enabled: z.boolean(), day: z.enum(DAYS), recipients: z.array(z.string().email()).max(20) })
    .safeParse({ enabled: form.get('enabled') === 'on', day: form.get('day'), recipients });
  if (!parsed.success) return { ok: false, message: 'Check the day and recipient emails.' };
  const res = await guard(async () => {
    const me = await requireRole('admin');
    await settings.saveWeeklyReport(me.workspaceId, me.id, parsed.data);
    return { ok: true, message: 'Weekly report saved.' };
  });
  revalidatePath('/settings/reports');
  return res;
}
