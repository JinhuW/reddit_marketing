'use server';

import type { ActionState } from '@/components/browsers/action-state';
import { ForbiddenError, requireMember } from '@/lib/session';
import { browsers } from '@threadline/db';
import { encrypt } from '@threadline/shared/crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

async function controllable(profileId: string) {
  const me = await requireMember();
  const profile = await browsers.getProfile(me.workspaceId, profileId);
  if (!profile) throw new ForbiddenError('Profile not found.');
  if (!browsers.canControlProfile(me, profile))
    throw new ForbiddenError('Only an admin or the account owner can change this profile.');
  return { me, profile };
}

const ProxyForm = z.object({
  profileId: z.string().min(1),
  provider: z.string().trim().min(1).max(120),
  protocol: z.enum(['http', 'socks5', 'none']),
  host: z.string().trim().max(255).optional(),
  port: z.string().trim().optional(),
  username: z.string().optional(),
  password: z.string().optional(),
  sticky: z.enum(['sticky', 'rotate']),
  region: z.string().trim().max(120).optional(),
});

export async function saveProxyAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const parsed = ProxyForm.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { ok: false, message: 'Check the proxy fields.' };
  const d = parsed.data;
  try {
    const { me } = await controllable(d.profileId);
    let port: number | null = null;
    if (d.protocol !== 'none') {
      if (!d.host) return { ok: false, message: 'Host is required unless the protocol is None.' };
      port = Number(d.port);
      if (!Number.isInteger(port) || port < 1 || port > 65535)
        return { ok: false, message: 'Port must be 1–65535.' };
    }
    // Write-only credentials: an empty field keeps the saved value.
    await browsers.saveProxy(me.workspaceId, d.profileId, me.id, {
      provider: d.provider,
      protocol: d.protocol,
      host: d.host || null,
      port,
      sticky: d.sticky === 'sticky',
      region: d.region || null,
      usernameEnc: d.username ? encrypt(d.username) : undefined,
      passwordEnc: d.password ? encrypt(d.password) : undefined,
    });
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, message: e.message };
    throw e;
  }
  revalidatePath('/browsers');
  return { ok: true, message: 'Proxy saved.' };
}

export async function runProxyTestAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    await controllable(String(form.get('profileId') ?? ''));
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, message: e.message };
    throw e;
  }
  // The test runs inside the profile's container (worker, M6). No result is invented here.
  return { ok: false, message: 'Connection tests run in the worker (M6); last result shown.' };
}

export async function startSessionAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const profileId = String(form.get('profileId') ?? '');
  const reason = String(form.get('reason') ?? '').trim();
  if (reason.length < 3)
    return { ok: false, message: 'Say why you are taking over (at least 3 characters).' };
  try {
    const { me } = await controllable(profileId);
    await browsers.startHumanSession({
      workspaceId: me.workspaceId,
      profileId,
      memberId: me.id,
      memberName: me.user.name ?? me.user.email,
      reason,
    });
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof browsers.SessionConflictError)
      return { ok: false, message: e.message };
    throw e;
  }
  revalidatePath(`/browsers/${profileId}/session`);
  redirect(`/browsers/${profileId}/session`);
}

export async function handBackAction(form: FormData): Promise<void> {
  const profileId = String(form.get('profileId') ?? '');
  const sessionId = String(form.get('sessionId') ?? '');
  const { me } = await controllable(profileId);
  await browsers.handBack({
    workspaceId: me.workspaceId,
    sessionId,
    memberId: me.id,
    memberName: me.user.name ?? me.user.email,
  });
  revalidatePath(`/browsers/${profileId}/session`);
  revalidatePath('/browsers');
}
