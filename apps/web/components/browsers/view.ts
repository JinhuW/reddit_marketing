import { proxyRegionMismatch } from '@threadline/agents';
import type { browsers } from '@threadline/db';
import { ago } from '@threadline/shared';

type Row = browsers.ProfileRow;

export const STATUS = {
  running: { label: 'Running', chip: 'chip-ok', dot: 'var(--ok)' },
  idle: { label: 'Idle', chip: 'chip-mid', dot: 'var(--faint)' },
  check: { label: 'Check', chip: 'chip-warn', dot: 'var(--warn)' },
  error: { label: 'Error', chip: 'chip-bad', dot: 'var(--bad)' },
} as const;

const ROLE = { founder: 'Founder', support: 'Support', brand: 'Brand' } as const;

/** Plain, client-safe view of a profile. Never includes proxy credentials. */
export function profileView(p: Row, now = new Date()) {
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
  const needsAttention = region.mismatch || p.status === 'check' || p.status === 'error';
  return {
    id: p.id,
    name: p.name,
    device: [fp.os, fp.screen].filter(Boolean).join(' · ') || 'Not captured',
    os: fp.os ?? '—',
    screen: fp.screen ?? '—',
    tz: fp.tz ?? '—',
    locale: fp.locale ?? '—',
    capturedAt: fp.capturedAt ?? null,
    ownerPlace: fp.ownerPlace ?? null,
    account: `u/${p.account.username}`,
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
