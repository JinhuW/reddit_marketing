'use server';

import type { ActionState } from '@/components/browsers/action-state';
import { type SignInCheck, signInView } from '@/components/browsers/view';
import { type WebBrowserJobKind, enqueueProfileJob, whoamiStatus } from '@/lib/browser-jobs';
import { ForbiddenError, requireMember } from '@/lib/session';
import { browsers, nodes } from '@threadline/db';
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
  revalidatePath('/settings/proxies');
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
  const login = form.get('login') === '1';
  try {
    const { me } = await controllable(profileId);
    await browsers.startHumanSession({
      workspaceId: me.workspaceId,
      profileId,
      memberId: me.id,
      memberName: me.user.name ?? me.user.email,
      reason,
    });
    // The viewer needs the profile's browser running; a node problem is shown on the session page.
    await enqueueProfileJob(me.workspaceId, profileId, 'profile.start');
  } catch (e) {
    if (e instanceof ForbiddenError || e instanceof browsers.SessionConflictError)
      return { ok: false, message: e.message };
    throw e;
  }
  revalidatePath(`/browsers/${profileId}/session`);
  redirect(`/browsers/${profileId}/session${login ? '?login=1' : ''}`);
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

const fid = (form: FormData, k: string) => String(form.get(k) ?? '').trim();
const forbidden = (e: unknown): ActionState | null =>
  e instanceof ForbiddenError ? { ok: false, message: e.message } : null;

async function admin() {
  const me = await requireMember();
  if (me.role !== 'admin') throw new ForbiddenError('Only an admin can do that.');
  return me;
}

const JOB_DONE: Record<WebBrowserJobKind, string> = {
  'profile.start': 'Start queued. The browser opens on its node in a few seconds.',
  'profile.stop': 'Stop queued.',
  'profile.whoami': 'Checking the sign-in…',
};

async function queueJob(form: FormData, kind: WebBrowserJobKind): Promise<ActionState> {
  try {
    const { me, profile } = await controllable(fid(form, 'profileId'));
    const r = await enqueueProfileJob(me.workspaceId, profile.id, kind);
    revalidatePath('/browsers');
    return r.queued ? { ok: true, message: JOB_DONE[kind] } : { ok: false, message: r.reason };
  } catch (e) {
    const f = forbidden(e);
    if (f) return f;
    throw e;
  }
}

/** Start / Stop on the Browsers screen: Admin or the account owner. */
export async function startProfileAction(_prev: ActionState | null, form: FormData) {
  return queueJob(form, 'profile.start');
}
export async function stopProfileAction(_prev: ActionState | null, form: FormData) {
  return queueJob(form, 'profile.stop');
}

/** Admin: clears the account's pause (any reason). Writes `account.resumed`. */
export async function resumeAccountAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    const me = await admin();
    const profile = await browsers.getProfile(me.workspaceId, fid(form, 'profileId'));
    if (!profile) return { ok: false, message: 'Profile not found.' };
    const r = await browsers.resumeAccount({
      workspaceId: me.workspaceId,
      accountId: profile.accountId,
      actorMemberId: me.id,
    });
    revalidatePath('/browsers');
    return { ok: true, message: r.changed ? 'Account resumed.' : 'The account was not paused.' };
  } catch (e) {
    const f = forbidden(e);
    if (f) return f;
    throw e;
  }
}

/** Admin: runs the profile on another online node of the workspace, or detaches it ('' = Unassigned). */
export async function assignNodeAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    const me = await admin();
    const profileId = fid(form, 'profileId');
    const nodeId = fid(form, 'nodeId') || null;
    if (!(await browsers.getProfile(me.workspaceId, profileId)))
      return { ok: false, message: 'Profile not found.' };
    if (nodeId) {
      const online = await nodes.listOnline(me.workspaceId);
      if (!online.some((n) => n.id === nodeId))
        return { ok: false, message: 'Pick an online node of this workspace.' };
    }
    await browsers.assignNode(me.workspaceId, profileId, nodeId, me.id);
    revalidatePath('/browsers');
    return { ok: true, message: nodeId ? 'Node assigned.' : 'Profile unassigned.' };
  } catch (e) {
    const f = forbidden(e);
    if (f) return f;
    throw e;
  }
}

/**
 * Puts the profile on one port of a workspace proxy provider (Settings → Proxies). Host, protocol and
 * credentials come from the provider; nothing is decrypted here.
 */
export async function assignProviderPortAction(
  _prev: ActionState | null,
  form: FormData,
): Promise<ActionState> {
  try {
    const { me, profile } = await controllable(fid(form, 'profileId'));
    const providerId = fid(form, 'providerId');
    const port = Number(fid(form, 'port'));
    if (!providerId) return { ok: false, message: 'Pick a provider.' };
    if (!Number.isInteger(port) || port < 1 || port > 65535)
      return { ok: false, message: 'Pick a port (1–65535).' };
    const r = await browsers.assignProviderPort(me.workspaceId, profile.id, providerId, port, me.id);
    revalidatePath('/browsers');
    revalidatePath('/settings/proxies');
    return {
      ok: true,
      message: r.changed ? `Proxy saved · port ${port}.` : 'The profile already uses that port.',
    };
  } catch (e) {
    const f = forbidden(e);
    if (f) return f;
    if (e instanceof browsers.ProxyProviderError) return { ok: false, message: e.message };
    throw e;
  }
}

// ── browser-mode sign-in (docs/plans/0002-browser-mode.md, Flow step 3) ──

/** "I'm signed in": queues `profile.whoami` on the profile's node. */
export async function checkSignInAction(
  profileId: string,
): Promise<{ ok: true; jobId: string } | { ok: false; message: string }> {
  try {
    const { me } = await controllable(profileId);
    const r = await enqueueProfileJob(me.workspaceId, profileId, 'profile.whoami');
    return r.queued ? { ok: true, jobId: r.jobId } : { ok: false, message: r.reason };
  } catch (e) {
    if (e instanceof ForbiddenError) return { ok: false, message: e.message };
    throw e;
  }
}

/** Polled every 3 s by the session page: the account's identity, else the whoami job's answer. */
export async function signInStatusAction(profileId: string, jobId: string | null): Promise<SignInCheck> {
  const { me, profile } = await controllable(profileId);
  const identified = profile.account.identifiedAt != null;
  const status = !identified && jobId ? await whoamiStatus(me.workspaceId, profile.id, jobId) : null;
  return signInView({ identified, username: profile.account.username }, status);
}

/** "Hand back and finish": ends the sign-in take-over, then back to the accounts list. */
export async function finishSignInAction(form: FormData): Promise<void> {
  const profileId = fid(form, 'profileId');
  const { me } = await controllable(profileId);
  const open = await browsers.openSession(profileId);
  if (open?.driver === 'human')
    await browsers.handBack({
      workspaceId: me.workspaceId,
      sessionId: open.id,
      memberId: me.id,
      memberName: me.user.name ?? me.user.email,
    });
  revalidatePath('/accounts');
  revalidatePath('/browsers');
  redirect('/accounts');
}
