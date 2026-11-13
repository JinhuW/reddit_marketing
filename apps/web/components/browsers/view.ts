import { proxyRegionMismatch } from '@threadline/agents';
import type { browsers } from '@threadline/db';
import { type PauseReason, ago } from '@threadline/shared';
import type { WhoamiStatus } from '../../lib/browser-jobs';

type Row = browsers.ProfileRow;

export const STATUS = {
  running: { label: 'Running', chip: 'chip-ok', dot: 'var(--ok)' },
  idle: { label: 'Idle', chip: 'chip-mid', dot: 'var(--faint)' },
  check: { label: 'Check', chip: 'chip-warn', dot: 'var(--warn)' },
  error: { label: 'Error', chip: 'chip-bad', dot: 'var(--bad)' },
} as const;

const ROLE = { founder: 'Founder', support: 'Support', brand: 'Brand' } as const;

/** Why the account is paused (`RedditAccount.pausedReason`), as the Browsers screen says it. */
export const PAUSE_LABEL: Record<PauseReason, string> = {
  needs_human: 'Needs a human',
  license_denied: 'No browser seat',
  node_offline: 'Node offline',
  proxy_failed: 'Proxy failed',
  manual: 'Paused by an admin',
};

export interface NodeInfo {
  id: string;
  name: string;
  status: string;
}

/** Node cell: name + online/offline (draining counts as not online). */
export function nodeView(node: NodeInfo | null) {
  if (!node) return { id: null, name: 'Unassigned', online: false, label: 'No node', chip: 'chip-mid' };
  const online = node.status === 'online';
  return {
    id: node.id,
    name: node.name,
    online,
    label: online ? 'Online' : node.status === 'draining' ? 'Draining' : 'Offline',
    chip: online ? 'chip-ok' : 'chip-warn',
  };
}

/** Options for the Admin "Assign node" select: online nodes, plus the current one when it is not online. */
export function nodeOptions(online: NodeInfo[], current: NodeInfo | null) {
  const opts = online.map((n) => ({ id: n.id, label: n.name }));
  if (current && !online.some((n) => n.id === current.id))
    opts.unshift({ id: current.id, label: `${current.name} (${current.status})` });
  return [{ id: '', label: 'Unassigned' }, ...opts];
}

/** "Decodo · gate.decodo.com:10001 · 2 profiles" — safe fields only, never credentials. */
export function savedProxyLabel(x: {
  provider: string;
  protocol: string;
  host: string | null;
  port: number | null;
  profileCount: number;
}) {
  const where = x.protocol === 'none' || !x.host ? 'direct' : `${x.host}${x.port ? `:${x.port}` : ''}`;
  const used = x.profileCount === 1 ? '1 profile' : `${x.profileCount} profiles`;
  return `${x.provider} · ${where} · ${used}`;
}

/** What the session page shows for a browser-mode sign-in check. */
export type SignInCheck =
  | { state: 'signed_in'; username: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'not_signed_in'; message: string }
  | { state: 'failed'; message: string };

/**
 * Account identity first; otherwise the `profile.whoami` / `profile.signIn` job's answer (null = nothing asked
 * yet). `account` null = a browser with no account (plan 0003): whoever the browser is signed in as counts.
 */
export function signInView(
  account: { identified: boolean; username: string } | null,
  status: WhoamiStatus | null,
): SignInCheck {
  if (account?.identified) return { state: 'signed_in', username: account.username };
  if (!status) return { state: 'idle' };
  switch (status.state) {
    case 'pending':
      return { state: 'checking' };
    case 'gone':
      return { state: 'failed', message: 'The check expired. Press I’m signed in again.' };
    case 'failed':
      return { state: 'failed', message: status.reason };
    case 'done':
      if (!account && status.whoami.loggedIn) return { state: 'signed_in', username: status.whoami.name };
      return status.whoami.loggedIn
        ? {
            // The gateway links the identity before the job completes; still unlinked = it was refused.
            state: 'failed',
            message: `The browser is signed in as u/${status.whoami.name}, but it could not be linked. Is that account already connected?`,
          }
        : { state: 'not_signed_in', message: 'Not signed in yet' };
  }
}

/** Show the sign-in banner: asked for (`?login=1`), or a browser-mode account nobody has signed in to yet. */
export function showSignIn(
  login: string | undefined,
  account: { authMode: string; identifiedAt: unknown } | null,
) {
  return login === '1' || (account?.authMode === 'browser' && account.identifiedAt == null);
}

/** A real Reddit username, or null for the `pending-…` placeholder of a browser connect nobody finished. */
export function realUsername(username: string): string | null {
  return username.startsWith('pending-') ? null : username;
}

const firstName = (n: string) => n.split(' ')[0] ?? n;

/** Plain, client-safe view of a profile. Never includes proxy credentials. */
export function profileView(p: Row, now = new Date(), node: NodeInfo | null = null) {
  const fp = (p.fingerprint ?? {}) as browsers.Fingerprint;
  const test = (p.proxy?.lastTest ?? null) as browsers.ProxyTest | null;
  const region = proxyRegionMismatch(test ? { country: test.country, timeZone: test.timeZone } : null, fp.tz);
  const a = p.account;
  const agent = a?.agents[0] ?? null;
  const ownerName = a ? (a.owner.user.name ?? a.owner.user.email) : null;
  const creatorName = p.createdBy ? (p.createdBy.user.name ?? p.createdBy.user.email) : null;
  const open = p.sessions[0] ?? null;
  const providerName = p.proxy?.provider.split(' · ')[0] ?? '';
  const proxyLabel =
    test?.label ?? p.proxy?.provider.split(' · ')[1] ?? (p.proxy ? p.proxy.host : null) ?? 'No proxy';
  const proxyType =
    p.proxy && p.proxy.protocol !== 'none'
      ? `${test?.kind ?? p.proxy.protocol.toUpperCase()} · ${p.proxy.sticky ? 'sticky' : 'rotating'}`
      : 'Direct connection';
  const status = STATUS[p.status];
  const paused = a?.pausedReason ? { reason: a.pausedReason, label: PAUSE_LABEL[a.pausedReason] } : null;
  // No account = nothing waiting for a sign-in.
  const signedIn = !a || a.authMode !== 'browser' || a.identifiedAt != null;
  // Who may change the browser besides admins: the account owner, or the creator of a browser with no account.
  const controllerFirst = ownerName
    ? firstName(ownerName)
    : creatorName
      ? firstName(creatorName)
      : 'its creator';
  const needsAttention =
    region.mismatch || p.status === 'check' || p.status === 'error' || paused !== null || !signedIn;
  return {
    id: p.id,
    name: p.name,
    node: nodeView(node),
    paused,
    /** false for a browser-mode account nobody has signed in to yet */
    signedIn,
    accountId: p.accountId,
    device: [fp.os, fp.screen].filter(Boolean).join(' · ') || 'Not captured',
    os: fp.os ?? '—',
    screen: fp.screen ?? '—',
    tz: fp.tz ?? '—',
    locale: fp.locale ?? '—',
    capturedAt: fp.capturedAt ?? null,
    ownerPlace: fp.ownerPlace ?? null,
    account: !a ? 'No account' : signedIn ? `u/${a.username}` : 'Waiting for sign-in',
    accountOwnerMemberId: a?.ownerMemberId ?? null,
    owner:
      a && ownerName
        ? `${ownerName} · ${ROLE[a.roleLabel]}`
        : creatorName
          ? `Created by ${creatorName}`
          : '—',
    /** the account owner's first name, else the creator's (a browser with no account) */
    ownerFirst: controllerFirst,
    /** The assigned account for the editor's Account section. Never the stored password or TOTP secret. */
    accountInfo: a
      ? {
          id: a.id,
          /** null while a browser connect is still `pending-…` */
          username: realUsername(a.username),
          authMode: a.authMode,
          identified: a.identifiedAt != null,
          hasPassword: Boolean(a.loginPasswordEnc),
          hasTotp: Boolean(a.totpSecretEnc),
          ownerName: ownerName ?? '',
        }
      : null,
    startUrl: p.startUrl ?? null,
    /** pasted cookies wait (encrypted) for the next sign-in run; never their values */
    cookies: {
      pending: Boolean(p.cookiesEnc),
      importedAt: p.cookiesImportedAt ? p.cookiesImportedAt.toISOString() : null,
    },
    agent: agent ? { name: agent.name, color: agent.color } : null,
    proxyLabel,
    proxyType,
    proxy: p.proxy
      ? {
          provider: providerName || p.proxy.provider,
          providerFull: p.proxy.provider,
          protocol: p.proxy.protocol,
          host: p.proxy.host ?? '',
          port: p.proxy.port ? String(p.proxy.port) : '',
          sticky: p.proxy.sticky,
          region: p.proxy.region ?? '',
          hasUsername: Boolean(p.proxy.usernameEnc),
          hasPassword: Boolean(p.proxy.passwordEnc),
        }
      : null,
    region: {
      label: test?.city ?? p.proxy?.region ?? '—',
      mismatch: region.mismatch,
      reason: region.reason,
    },
    test: test
      ? {
          ip: test.ip ?? '—',
          location: test.city ?? '—',
          latency: test.latencyMs != null ? `${test.latencyMs} ms` : '—',
          latencyMs: test.latencyMs ?? null,
          redditOk: test.redditOk ?? null,
          /** false only when the last test failed; older rows have no flag */
          failed: test.ok === false,
          error: test.error ?? null,
          testedAgo: test.testedAt ? `${ago(test.testedAt, now)} ago` : 'never',
        }
      : null,
    status: { key: p.status, ...status },
    needsAttention,
    lastSession: open
      ? `Now · ${ago(open.startedAt, now)}`
      : p.lastSessionAt
        ? `${ago(p.lastSessionAt, now)} ago`
        : 'Never',
    openSession: open
      ? { driver: open.driver, by: open.startedBy?.user.name ?? open.agent?.name ?? 'Agent' }
      : null,
    action: needsAttention ? 'Fix' : 'View',
  };
}
export type ProfileView = ReturnType<typeof profileView>;
