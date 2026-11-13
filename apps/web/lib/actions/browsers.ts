'use server';

import type { ActionState } from '@/components/browsers/action-state';
import { type SignInCheck, signInView } from '@/components/browsers/view';
import { type WebBrowserJobKind, enqueueProfileJob, whoamiStatus } from '@/lib/browser-jobs';
import { parseDeviceFingerprint } from '@/lib/device-fingerprint';
import { ForbiddenError, requireMember, requireRole } from '@/lib/session';
import { normalizeTotpSecret } from '@/lib/totp-secret';
import { accounts, agents, browsers, nodes } from '@threadline/db';
import { CookieParseError, cookieDomains, parseCookieText } from '@threadline/shared';
import { encrypt } from '@threadline/shared/crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

/** `proxyId` value of the New browser form that means "a random pool proxy no browser uses". */
const RANDOM_PROXY = '__random_unused__';
/** Most browsers one "create" makes. */
const QUICK_CREATE_MAX = 50;

async function controllable(profileId: string) {
  const me = await requireMember();
  const profile = await browsers.getProfile(me.workspaceId, profileId);
  if (!profile) throw new ForbiddenError('Profile not found.');
  if (!browsers.canControlProfile(me, profile))
    throw new ForbiddenError(
      profile.account
        ? 'Only an admin or the account owner can change this profile.'
        : 'Only an admin or the member who created this browser can change it.',
    );
  return { me, profile };
}

/**
 * Plan 0004 phase 5: like `controllable`, but also lets in an editor an admin gave access to the browser's group.
 * Only for what `browsers.canManageProfile` covers: start, stop, proxy test, name, notes, group, tags, proxy and
 * fingerprint settings.
 */
async function manageable(profileId: string) {
  const me = await requireMember();
  const profile = await browsers.getProfile(me.workspaceId, profileId);
  if (!profile) throw new ForbiddenError('Browser not found.');
  if (!browsers.canManageProfile(me, profile))
    throw new ForbiddenError(
      'Only an admin, the browser’s owner, or a member with access to its group can change this browser.',
    );
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
    const { me } = await manageable(d.profileId);
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
  'profile.signIn': 'Sign-in queued.',
  'profile.testProxy': 'Test started. The result shows here in a few seconds.',
};

async function queueJob(form: FormData, kind: WebBrowserJobKind): Promise<ActionState> {
  try {
    // Starting, stopping and testing the proxy are management; a sign-in or identity check is control.
    const manage = kind === 'profile.start' || kind === 'profile.stop' || kind === 'profile.testProxy';
    const { me, profile } = await (manage ? manageable : controllable)(fid(form, 'profileId'));
    const r = await enqueueProfileJob(me.workspaceId, profile.id, kind);
    revalidatePath('/browsers');
    return r.queued ? { ok: true, message: JOB_DONE[kind] } : { ok: false, message: r.reason };
  } catch (e) {
    const f = forbidden(e);
    if (f) return f;
    throw e;
  }
}

/** "Test now": runs inside the profile's own browser on its node; the gateway stores the result on the proxy. */
export async function runProxyTestAction(_prev: ActionState | null, form: FormData) {
  return queueJob(form, 'profile.testProxy');
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
    if (!profile.accountId) return { ok: false, message: 'This browser has no account.' };
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

/** Points the profile at a proxy the workspace already has. Nothing is decrypted. */
export async function attachProxyAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    const { me, profile } = await manageable(fid(form, 'profileId'));
    const proxyId = fid(form, 'proxyId');
    if (!proxyId) return { ok: false, message: 'Pick a saved proxy.' };
    const proxies = await browsers.listProxies(me.workspaceId);
    if (!proxies.some((p) => p.id === proxyId)) return { ok: false, message: 'Proxy not found.' };
    const r = await browsers.attachProxy(me.workspaceId, profile.id, proxyId, me.id);
    revalidatePath('/browsers');
    return { ok: true, message: r.changed ? 'Proxy attached.' : 'The profile already uses that proxy.' };
  } catch (e) {
    const f = forbidden(e);
    if (f) return f;
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

/**
 * Polled every 3 s by the session page: the account's identity, else the answer of the `profile.whoami` /
 * `profile.signIn` job.
 */
export async function signInStatusAction(profileId: string, jobId: string | null): Promise<SignInCheck> {
  const { me, profile } = await controllable(profileId);
  const a = profile.account;
  const identified = a?.identifiedAt != null;
  const status = !identified && jobId ? await whoamiStatus(me.workspaceId, profile.id, jobId) : null;
  return signInView(a ? { identified, username: a.username } : null, status);
}

/**
 * "Hand back and finish": ends the sign-in take-over, then back to the accounts list (or to the browser, when the
 * sign-in started on the Browsers screen: `back=browser`).
 */
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
  redirect(fid(form, 'back') === 'browser' ? `/browsers?id=${encodeURIComponent(profileId)}` : '/accounts');
}

// ── standalone browsers, accounts assigned to them (docs/plans/0003-standalone-browsers.md) ──

const fail = (e: unknown): ActionState | null => {
  if (
    e instanceof ForbiddenError ||
    e instanceof browsers.BrowserAssignError ||
    e instanceof accounts.AccountConflictError ||
    e instanceof agents.PlanLimitError ||
    e instanceof browsers.SessionConflictError ||
    e instanceof CookieParseError
  )
    return { ok: false, message: e.message };
  return null;
};

/**
 * Pasted cookie JSON → encrypted normalized cookies. Empty = none (undefined). The values never leave this
 * function except encrypted; messages name counts and domains only.
 */
function readCookies(form: FormData): { enc: string; note: string } | undefined {
  const raw = String(form.get('cookies') ?? '').trim();
  if (!raw) return undefined;
  // JSON, a cookies.txt file, or name=value pairs; pairs carry no site, so they go under the start tab's.
  const list = parseCookieText(raw, { defaultDomain: pairDomain(String(form.get('startUrl') ?? '')) });
  const domains = cookieDomains(list);
  const n = list.length === 1 ? '1 cookie' : `${list.length} cookies`;
  const reddit = domains.some((d) => d === 'reddit.com' || d.endsWith('.reddit.com'));
  return {
    enc: encrypt(JSON.stringify(list)),
    note: `${n} for ${domains.slice(0, 3).join(', ')}${domains.length > 3 ? '…' : ''} wait for the next sign-in.${reddit ? '' : ' None of them is for reddit.com.'}`,
  };
}

/** `.example.com` for the start tab's site; reddit.com when there is none. */
function pairDomain(startUrl: string): string {
  try {
    const host = new URL(startUrl.trim()).hostname.replace(/^www\./, '');
    return host ? `.${host}` : '.reddit.com';
  } catch {
    return '.reddit.com';
  }
}
const lines = (form: FormData, k: string) =>
  String(form.get(k) ?? '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

/** Optional password / 2FA fields → encrypted values (undefined = left blank). */
function readCredentials(
  form: FormData,
): { ok: true; passwordEnc?: string; totpEnc?: string } | { ok: false; message: string } {
  const password = String(form.get('password') ?? '');
  const totpRaw = String(form.get('totp') ?? '').trim();
  if (password.length > 200) return { ok: false, message: 'Password is too long.' };
  let totpEnc: string | undefined;
  if (totpRaw) {
    const t = normalizeTotpSecret(totpRaw);
    if (!t.ok) return t;
    totpEnc = encrypt(t.secret);
  }
  return { ok: true, passwordEnc: password ? encrypt(password) : undefined, totpEnc };
}

/** /browsers/new: a browser with no account. Editors and admins. Redirects to it on the Browsers screen. */
export async function createBrowserAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  let target: string;
  try {
    const me = await requireRole('editor');
    // Plan 0004 phase 4: "how many". One browser is the old form; more makes numbered copies of it.
    const count = Number.parseInt(fid(form, 'count') || '1', 10);
    if (!Number.isInteger(count) || count < 1 || count > QUICK_CREATE_MAX)
      return { ok: false, message: `Create between 1 and ${QUICK_CREATE_MAX} browsers at a time.` };
    const pool = await browsers.listProxies(me.workspaceId);
    const picked = fid(form, 'proxyId') || null;
    const random = picked === RANDOM_PROXY;
    if (picked && !random && !pool.some((x) => x.id === picked))
      return { ok: false, message: 'That proxy is not in this workspace.' };
    // Plan 0004 phase 3: pool proxies no browser uses yet, one per new browser.
    const free = random
      ? pool.filter((x) => x.profileCount === 0 && x.host && x.protocol !== 'none').map((x) => x.id)
      : [];
    if (random && free.length < count)
      return {
        ok: false,
        message:
          free.length === 0
            ? 'Every proxy in the pool is in use. Add one or pick one.'
            : `Only ${free.length} unused ${free.length === 1 ? 'proxy' : 'proxies'} in the pool for ${count} browsers.`,
      };
    for (let i = free.length - 1; i > 0; i--) {
      const k = Math.floor(Math.random() * (i + 1));
      [free[i], free[k]] = [free[k] as string, free[i] as string];
    }
    const startUrl = browsers.normalizeStartUrl(fid(form, 'startUrl'));
    const cookies = readCookies(form);
    if (cookies && count > 1)
      return {
        ok: false,
        message: 'Cookies belong to one browser. Create one browser, or leave the cookie box empty.',
      };
    const name = fid(form, 'name');
    if (count > 1 && !name)
      return { ok: false, message: 'Give the browsers a name; each gets a number after it.' };
    const shared = {
      workspaceId: me.workspaceId,
      actorMemberId: me.id,
      fingerprint: parseDeviceFingerprint(fid(form, 'fingerprint')),
      startUrl,
      extraStartUrls: lines(form, 'extraStartUrls'),
      groupId: fid(form, 'groupId') || null,
      tagIds: form.getAll('tagIds').map(String).filter(Boolean),
      notes: fid(form, 'notes') || null,
    };
    let first = '';
    for (let i = 0; i < count; i++) {
      const r = await browsers.createBrowser({
        ...shared,
        name: count > 1 ? `${name.slice(0, 72)} ${i + 1}` : name || null,
        proxyId: random ? (free[i] ?? null) : picked,
        cookiesEnc: cookies?.enc ?? null,
      });
      first ||= r.profileId;
    }
    target =
      count > 1
        ? `/browsers?q=${encodeURIComponent(name.slice(0, 72))}`
        : `/browsers?id=${encodeURIComponent(first)}`;
  } catch (e) {
    const f = fail(e);
    if (f) return f;
    throw e;
  }
  revalidatePath('/browsers');
  redirect(target);
}

/**
 * Puts an existing account (in no browser) into this browser. Admins, or the account's owner when they also
 * control the browser: nobody moves someone else's account.
 */
export async function assignAccountAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    const { me, profile } = await controllable(fid(form, 'profileId'));
    const accountId = fid(form, 'accountId');
    if (!accountId) return { ok: false, message: 'Pick an account.' };
    const acc = (await browsers.listAssignableAccounts(me.workspaceId)).find((a) => a.id === accountId);
    if (!acc) return { ok: false, message: 'That account is in another browser or disconnected.' };
    if (me.role !== 'admin' && acc.ownerMemberId !== me.id)
      throw new ForbiddenError('Only an admin or the account’s owner can put it in a browser.');
    await browsers.assignAccount(me.workspaceId, profile.id, acc.id, me.id);
    revalidatePath('/browsers');
    return { ok: true, message: `u/${acc.username} assigned. Press Sign in now to check the sign-in.` };
  } catch (e) {
    const f = fail(e);
    if (f) return f;
    throw e;
  }
}

/**
 * "Add account": platform reddit.com, username, password, 2FA secret, like an anti-detect browser's account
 * dialog. Creates a browser-mode account owned by the actor and assigns it here. Credentials are encrypted
 * before they reach the repo and are never sent back.
 */
export async function addAccountAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    const { me, profile } = await controllable(fid(form, 'profileId'));
    if (fid(form, 'platform') && fid(form, 'platform') !== 'reddit.com')
      return { ok: false, message: 'Only reddit.com accounts are supported.' };
    const username = fid(form, 'username');
    if (!username) return { ok: false, message: 'Enter the Reddit username.' };
    const cred = readCredentials(form);
    if (!cred.ok) return { ok: false, message: cred.message };
    await accounts.addBrowserAccount({
      workspaceId: me.workspaceId,
      profileId: profile.id,
      actorMemberId: me.id,
      username,
      loginPasswordEnc: cred.passwordEnc ?? null,
      totpSecretEnc: cred.totpEnc ?? null,
    });
    revalidatePath('/browsers');
    revalidatePath('/accounts');
    return {
      ok: true,
      message: cred.passwordEnc
        ? 'Account added. Press Sign in now to sign in with the saved password.'
        : 'Account added. Press Sign in now, then sign in over the live view.',
    };
  } catch (e) {
    const f = fail(e);
    if (f) return f;
    throw e;
  }
}

/** Takes the account out of this browser; both stay. */
export async function unassignAccountAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    const { me, profile } = await controllable(fid(form, 'profileId'));
    const r = await browsers.unassignAccount(me.workspaceId, profile.id, me.id);
    revalidatePath('/browsers');
    return {
      ok: true,
      message: r.changed
        ? 'Account unassigned. The browser may still be signed in to it: sign out over the live view before adding another account.'
        : 'This browser had no account.',
    };
  } catch (e) {
    const f = fail(e);
    if (f) return f;
    throw e;
  }
}

/** Password / 2FA of the assigned account: blank keeps, the "Remove" boxes clear. Values are never sent back. */
export async function saveCredentialsAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  try {
    const { me, profile } = await controllable(fid(form, 'profileId'));
    const a = profile.account;
    if (!a) return { ok: false, message: 'This browser has no account.' };
    if (a.authMode !== 'browser')
      return { ok: false, message: 'This account signs in with Reddit authorization, not a password.' };
    const cred = readCredentials(form);
    if (!cred.ok) return { ok: false, message: cred.message };
    const r = await accounts.setCredentials(me.workspaceId, a.id, me.id, {
      loginPasswordEnc: cred.passwordEnc ?? (form.get('clearPassword') === 'on' ? null : undefined),
      totpSecretEnc: cred.totpEnc ?? (form.get('clearTotp') === 'on' ? null : undefined),
    });
    revalidatePath('/browsers');
    return { ok: true, message: r.changed ? 'Sign-in details saved.' : 'Nothing to change.' };
  } catch (e) {
    const f = fail(e);
    if (f) return f;
    throw e;
  }
}

/** Name, start tab and cookies. Empty cookie box keeps pending cookies; "Drop pending cookies" clears them. */
export async function saveBrowserSettingsAction(
  _prev: ActionState | null,
  form: FormData,
): Promise<ActionState> {
  try {
    const { me, profile } = await controllable(fid(form, 'profileId'));
    const cookies = readCookies(form);
    const r = await browsers.updateBrowserSettings(me.workspaceId, profile.id, me.id, {
      name: fid(form, 'name') || undefined,
      startUrl: fid(form, 'startUrl') || null,
      cookiesEnc: cookies ? cookies.enc : form.get('dropCookies') === 'on' ? null : undefined,
      extraStartUrls: lines(form, 'extraStartUrls'),
    });
    revalidatePath('/browsers');
    if (!r.changed.length) return { ok: true, message: 'Nothing to change.' };
    return { ok: true, message: cookies ? `Saved. ${cookies.note}` : 'Saved.' };
  } catch (e) {
    const f = fail(e);
    if (f) return f;
    throw e;
  }
}

/**
 * "Sign in now": queues `profile.signIn` (imports pending cookies, signs in with the stored password + 2FA when
 * nobody is signed in, opens the start tab), then the live view follows the job.
 */
export async function signInNowAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  let target: string;
  try {
    const { me, profile } = await controllable(fid(form, 'profileId'));
    const r = await enqueueProfileJob(me.workspaceId, profile.id, 'profile.signIn');
    if (!r.queued) return { ok: false, message: r.reason };
    target = `/browsers/${profile.id}/session?login=1&job=${encodeURIComponent(r.jobId)}`;
  } catch (e) {
    const f = fail(e);
    if (f) return f;
    throw e;
  }
  revalidatePath('/browsers');
  redirect(target);
}
