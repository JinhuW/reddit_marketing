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

/** A range wider than this gets a number field instead of a select (one option per port). */
export const MAX_PORT_OPTIONS = 500;

export interface PortOption {
  port: number;
  label: string;
  /** another profile of the workspace uses it (one IP per account) */
  disabled: boolean;
}

/** Client-safe provider for the Browsers editor and the connect flow. Never includes credentials. */
export interface ProviderChoice {
  id: string;
  name: string;
  label: string;
  portFrom: number | null;
  portTo: number | null;
  /** null: no range (or one too wide), so the port is typed in */
  ports: PortOption[] | null;
  /** ports other profiles use, for the typed-in case */
  usedPorts: { port: number; profileName: string }[];
}

type ProviderLike = Pick<
  browsers.ProxyProviderListItem,
  'id' | 'name' | 'host' | 'portFrom' | 'portTo' | 'portsInUse'
>;

/** Ports of the provider's range; the ones another profile uses are disabled and say which profile. */
export function providerPortOptions(p: ProviderLike, profileId: string | null): PortOption[] | null {
  if (p.portFrom == null || p.portTo == null) return null;
  if (p.portTo - p.portFrom + 1 > MAX_PORT_OPTIONS) return null;
  const used = new Map(p.portsInUse.map((u) => [u.port, u]));
  const out: PortOption[] = [];
  for (let port = p.portFrom; port <= p.portTo; port++) {
    const u = used.get(port);
    const mine = u?.profileId === profileId;
    out.push({
      port,
      label: !u ? String(port) : mine ? `${port} · this profile` : `${port} · ${u.profileName}`,
      disabled: Boolean(u) && !mine,
    });
  }
  return out;
}

/** "Decodo · isp.decodo.com · 10001–10100" */
export function providerLabel(p: Pick<ProviderLike, 'name' | 'host' | 'portFrom' | 'portTo'>) {
  const range = p.portFrom != null && p.portTo != null ? ` · ${p.portFrom}–${p.portTo}` : '';
  return `${p.name} · ${p.host}${range}`;
}

export function providerChoices(list: ProviderLike[], profileId: string | null): ProviderChoice[] {
  return list.map((p) => ({
    id: p.id,
    name: p.name,
    label: providerLabel(p),
    portFrom: p.portFrom,
    portTo: p.portTo,
    ports: providerPortOptions(p, profileId),
    usedPorts: p.portsInUse
      .filter((u) => u.profileId !== profileId)
      .map((u) => ({ port: u.port, profileName: u.profileName })),
  }));
}

/** First port of the range nobody uses, else '' (the connect flow's and editor's default pick). */
export function firstFreePort(c: ProviderChoice | undefined): string {
  const free = c?.ports?.find((o) => !o.disabled);
  return free ? String(free.port) : '';
}

/** What the session page shows for a browser-mode sign-in check. */
export type SignInCheck =
  | { state: 'signed_in'; username: string }
  | { state: 'idle' }
  | { state: 'checking' }
  | { state: 'not_signed_in'; message: string }
  | { state: 'failed'; message: string };

/** Account identity first; otherwise the `profile.whoami` job's answer (null = nothing asked yet). */
export function signInView(
  account: { identified: boolean; username: string },
  status: WhoamiStatus | null,
): SignInCheck {
  if (account.identified) return { state: 'signed_in', username: account.username };
  if (!status) return { state: 'idle' };
  switch (status.state) {
    case 'pending':
      return { state: 'checking' };
    case 'gone':
      return { state: 'failed', message: 'The check expired. Press I’m signed in again.' };
    case 'failed':
      return { state: 'failed', message: status.reason };
    case 'done':
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
export function showSignIn(login: string | undefined, account: { authMode: string; identifiedAt: unknown }) {
  return login === '1' || (account.authMode === 'browser' && account.identifiedAt == null);
}

/** Plain, client-safe view of a profile. Never includes proxy credentials. */
export function profileView(p: Row, now = new Date(), node: NodeInfo | null = null) {
  const fp = (p.fingerprint ?? {}) as browsers.Fingerprint;
  const test = (p.proxy?.lastTest ?? null) as browsers.ProxyTest | null;
  const region = proxyRegionMismatch(test ? { country: test.country, timeZone: test.timeZone } : null, fp.tz);
  const agent = p.account.agents[0] ?? null;
  const ownerName = p.account.owner.user.name ?? p.account.owner.user.email;
  const open = p.sessions[0] ?? null;
  const providerName = p.proxy?.provider.split(' · ')[0] ?? '';
  const proxyLabel =
    test?.label ?? p.proxy?.provider.split(' · ')[1] ?? (p.proxy ? p.proxy.host : null) ?? 'No proxy';
  const proxyType =
    p.proxy && p.proxy.protocol !== 'none'
      ? `${test?.kind ?? p.proxy.protocol.toUpperCase()} · ${p.proxy.sticky ? 'sticky' : 'rotating'}`
      : 'Direct connection';
  const status = STATUS[p.status];
  const paused = p.account.pausedReason
    ? { reason: p.account.pausedReason, label: PAUSE_LABEL[p.account.pausedReason] }
    : null;
  const signedIn = p.account.authMode !== 'browser' || p.account.identifiedAt != null;
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
    account: signedIn ? `u/${p.account.username}` : 'Waiting for sign-in',
    accountOwnerMemberId: p.account.ownerMemberId,
    owner: `${ownerName} · ${ROLE[p.account.roleLabel]}`,
    ownerFirst: ownerName.split(' ')[0] ?? ownerName,
    agent: agent ? { name: agent.name, color: agent.color } : null,
    proxyLabel,
    proxyType,
    proxy: p.proxy
      ? {
          provider: providerName || p.proxy.provider,
          providerFull: p.proxy.provider,
          /** set: the profile uses a port of a workspace provider (Settings → Proxies) */
          providerId: p.proxy.providerId ?? null,
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
