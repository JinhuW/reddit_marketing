'use server';

import type { ActionState } from '@/components/settings/action-state';
import { ForbiddenError, requireRole } from '@/lib/session';
import { browsers, settings } from '@threadline/db';
import { MemberRole } from '@threadline/shared';
import { encrypt } from '@threadline/shared/crypto';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

const guard = async <T>(fn: () => Promise<T>): Promise<T | ActionState> => {
  try {
    return await fn();
  } catch (e) {
    if (
      e instanceof ForbiddenError ||
      e instanceof settings.TeamError ||
      e instanceof browsers.ProxyProviderError
    )
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

// ── Proxies (workspace proxy providers): Admin only; credentials are write-only ──

const optPort = z
  .string()
  .trim()
  .transform((v) => (v === '' ? null : Number(v)))
  .refine((v) => v === null || (Number.isInteger(v) && v >= 1 && v <= 65535), 'Ports must be 1–65535.');

const ProviderForm = z.object({
  id: z.string().max(64).optional(),
  name: z.string().trim().min(1, 'Name is required.').max(80),
  protocol: z.enum(['http', 'socks5']),
  host: z.string().trim().min(1, 'Host is required.').max(255),
  portFrom: optPort,
  portTo: optPort,
  username: z.string().max(500).optional(),
  password: z.string().max(500).optional(),
  region: z.string().trim().max(120).optional(),
});

export async function saveProxyProviderAction(
  _prev: ActionState | null,
  form: FormData,
): Promise<ActionState> {
  const parsed = ProviderForm.safeParse({
    id: form.get('id') || undefined,
    name: form.get('name') ?? '',
    protocol: form.get('protocol'),
    host: form.get('host') ?? '',
    portFrom: form.get('portFrom') ?? '',
    portTo: form.get('portTo') ?? '',
    username: form.get('username') ?? '',
    password: form.get('password') ?? '',
    region: form.get('region') ?? '',
  });
  if (!parsed.success) return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the fields.' };
  const d = parsed.data;
  const res = await guard(async () => {
    const me = await requireRole('admin');
    // Write-only credentials: an empty field keeps the saved value.
    const r = await browsers.saveProvider(me.workspaceId, me.id, {
      id: d.id,
      name: d.name,
      protocol: d.protocol,
      host: d.host,
      portFrom: d.portFrom,
      portTo: d.portTo,
      region: d.region || null,
      usernameEnc: d.username ? encrypt(d.username) : undefined,
      passwordEnc: d.password ? encrypt(d.password) : undefined,
    });
    return { ok: true, message: r.created ? `Added ${d.name}.` : `Saved ${d.name}.` };
  });
  revalidatePath('/settings/proxies');
  revalidatePath('/browsers');
  return res;
}

export async function deleteProxyProviderAction(
  _prev: ActionState | null,
  form: FormData,
): Promise<ActionState> {
  const id = String(form.get('id') ?? '');
  const res = await guard(async () => {
    const me = await requireRole('admin');
    await browsers.deleteProvider(me.workspaceId, me.id, id);
    return { ok: true, message: 'Provider deleted.' };
  });
  revalidatePath('/settings/proxies');
  revalidatePath('/browsers');
  return res;
}
