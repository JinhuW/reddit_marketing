'use server';

import { enqueueProfileJob } from '@/lib/browser-jobs';
import { PENDING_COOKIE, openPending } from '@/lib/reddit-oauth';
import { ForbiddenError, requireRole } from '@/lib/session';
import { PolicyError } from '@threadline/agents';
import { accounts, agents, browsers } from '@threadline/db';
import { AccountRoleLabel } from '@threadline/shared';
import { revalidatePath } from 'next/cache';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';
import { z } from 'zod';

export interface ActionState {
  ok?: boolean;
  error?: string;
  message?: string;
}

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();

const Limits = {
  dailyPostLimit: z.coerce
    .number()
    .int()
    .min(1, 'Posts per day must be at least 1.')
    .max(50, 'Posts per day is at most 50.'),
  selfPromoMax: z.coerce.number().int().min(0).max(100, 'Self-promo max is a percentage (0–100).'),
};
const Disclosure = z.string().min(3, 'Add a disclosure line, e.g. “I work on Acme”.').max(200);

const Fingerprint = z.object({
  userAgent: z.string().max(500),
  screen: z.string().max(40),
  tz: z.string().max(80),
  locale: z.string().max(80),
  os: z.string().max(80).optional(),
});

const fail = (e: unknown): ActionState => {
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Invalid input.' };
  if (e instanceof PolicyError || e instanceof ForbiddenError || e instanceof agents.PlanLimitError)
    return { error: e.message };
  if (e instanceof Error && /Unique constraint/i.test(e.message))
    return { error: 'That Reddit account is already connected.' };
  return { error: e instanceof Error ? e.message : 'Something went wrong.' };
};

/** Steps 2–4: owner (the signed-in member), role + disclosure, limits. Creates the account and its browser profile. */
export async function finishConnect(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const me = await requireRole('editor');
    const jar = await cookies();
    const pending = openPending(jar.get(PENDING_COOKIE)?.value, me.id);
    if (!pending)
      return { error: 'Sign in with Reddit first (step 1). The authorization expires after 15 minutes.' };
    const input = z
      .object({
        roleLabel: z.enum(AccountRoleLabel),
        disclosureLine: Disclosure,
        ...Limits,
        fingerprint: z.string(),
      })
      .parse({
        roleLabel: str(f, 'roleLabel'),
        disclosureLine: str(f, 'disclosureLine'),
        dailyPostLimit: f.get('dailyPostLimit'),
        selfPromoMax: str(f, 'selfPromoMax').replace('%', ''),
        fingerprint: str(f, 'fingerprint'),
      });
    const fp = Fingerprint.safeParse(JSON.parse(input.fingerprint || '{}'));
    await accounts.connect({
      workspaceId: me.workspaceId,
      ownerMemberId: me.id,
      username: pending.username,
      redditId: pending.redditId,
      karma: pending.karma,
      accountCreatedAt: new Date(pending.createdUtc * 1000),
      oauthTokenEnc: pending.refreshEnc,
      scopes: pending.scopes,
      roleLabel: input.roleLabel,
      disclosureLine: input.disclosureLine,
      dailyPostLimit: input.dailyPostLimit,
      selfPromoMax: input.selfPromoMax,
      fingerprint: fp.success ? { ...fp.data, capturedAt: new Date().toISOString() } : {},
    });
    jar.delete(PENDING_COOKIE);
  } catch (e) {
    return fail(e);
  }
  revalidatePath('/accounts');
  redirect('/accounts');
}

/**
 * Browser mode, step 1 (docs/plans/0002-browser-mode.md): the signed-in member becomes the owner of a pending
 * account + browser profile (node and optional proxy), `profile.start` is queued, and a take-over session opens
 * so the owner can sign in to reddit.com themselves. The account cannot post until `profile.whoami` identifies it.
 */
export async function startBrowserConnect(_: ActionState, f: FormData): Promise<ActionState> {
  let profileId: string;
  try {
    const me = await requireRole('editor');
    const input = z
      .object({
        roleLabel: z.enum(AccountRoleLabel),
        disclosureLine: Disclosure,
        ...Limits,
        proxyId: z.string().max(64),
        fingerprint: z.string(),
      })
      .parse({
        roleLabel: str(f, 'roleLabel'),
        disclosureLine: str(f, 'disclosureLine'),
        dailyPostLimit: f.get('dailyPostLimit'),
        selfPromoMax: str(f, 'selfPromoMax').replace('%', ''),
        proxyId: str(f, 'proxyId'),
        fingerprint: str(f, 'fingerprint'),
      });
    if (input.proxyId && !(await browsers.listProxies(me.workspaceId)).some((p) => p.id === input.proxyId))
      return { error: 'That proxy is not in this workspace.' };
    let fpRaw: unknown = {};
    try {
      fpRaw = JSON.parse(input.fingerprint || '{}');
    } catch {}
    const fp = Fingerprint.safeParse(fpRaw);
    const r = await accounts.startBrowserConnect({
      workspaceId: me.workspaceId,
      ownerMemberId: me.id,
      roleLabel: input.roleLabel,
      disclosureLine: input.disclosureLine,
      dailyPostLimit: input.dailyPostLimit,
      selfPromoMax: input.selfPromoMax,
      proxyId: input.proxyId || null,
      fingerprint: fp.success ? { ...fp.data, capturedAt: new Date().toISOString() } : {},
    });
    profileId = r.profileId;
    // No node / node offline: nothing is queued; the session page says why.
    await enqueueProfileJob(me.workspaceId, r.profileId, 'profile.start');
    try {
      await browsers.startHumanSession({
        workspaceId: me.workspaceId,
        profileId: r.profileId,
        memberId: me.id,
        memberName: me.user.name ?? me.user.email,
        reason: 'Sign in to Reddit',
      });
    } catch (e) {
      // Resuming: the owner's earlier sign-in session may still be open; the session page picks it up.
      if (!(r.resumed && e instanceof browsers.SessionConflictError)) throw e;
    }
  } catch (e) {
    return fail(e);
  }
  revalidatePath('/accounts');
  revalidatePath('/browsers');
  redirect(`/browsers/${profileId}/session?login=1`);
}

/** Admins, or the account owner, can edit limits and the disclosure line. */
export async function saveLimits(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const me = await requireRole('editor');
    const id = str(f, 'accountId');
    const isOwner = me.ownedAccounts.some((a) => a.id === id);
    if (me.role !== 'admin' && !isOwner)
      throw new ForbiddenError('Only an admin or the account owner can change limits.');
    const input = z.object({ disclosureLine: Disclosure, ...Limits }).parse({
      disclosureLine: str(f, 'disclosureLine'),
      dailyPostLimit: f.get('dailyPostLimit'),
      selfPromoMax: str(f, 'selfPromoMax').replace('%', ''),
    });
    await accounts.updateLimits(me.workspaceId, id, input);
    revalidatePath('/accounts');
    return { ok: true, message: 'Limits saved.' };
  } catch (e) {
    return fail(e);
  }
}

export async function disconnectAccount(f: FormData) {
  const me = await requireRole('editor');
  const id = str(f, 'accountId');
  if (me.role !== 'admin' && !me.ownedAccounts.some((a) => a.id === id))
    throw new ForbiddenError('Only an admin or the account owner can disconnect.');
  await accounts.disconnect(me.workspaceId, id, me.id);
  revalidatePath('/accounts');
}
