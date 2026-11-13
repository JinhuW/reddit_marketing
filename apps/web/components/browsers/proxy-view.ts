import type { browsers } from '@threadline/db';
import { ago } from '@threadline/shared';

/** Plain, client-safe row of the proxy pool. Never includes the login or the change-IP link. */
export function proxyRow(x: browsers.ProxyListItem, now = new Date()) {
  const t = x.lastTest;
  const tested = Boolean(t?.testedAt);
  const failed = t?.ok === false;
  return {
    id: x.id,
    // The team's name for it, else the vendor name it was saved with, else its host.
    title: x.label || t?.label || x.provider || x.host || 'Proxy',
    address: x.host ? `${x.host}:${x.port ?? ''}` : 'No host',
    type:
      x.protocol === 'none' ? 'Direct' : `${x.protocol.toUpperCase()} · ${x.sticky ? 'sticky' : 'rotating'}`,
    provider: x.provider,
    hasLogin: x.hasCredentials,
    hasRefreshUrl: x.hasRefreshUrl,
    ip: failed ? '—' : (t?.ip ?? '—'),
    place: failed ? '—' : (t?.city ?? x.region ?? '—'),
    latency: !failed && t?.latencyMs != null ? `${t.latencyMs} ms` : '—',
    status: !tested
      ? { label: 'Not checked', chip: 'chip-mid' }
      : failed
        ? { label: `Failed · ${t?.error ?? 'error'}`, chip: 'chip-bad' }
        : t?.redditOk === false
          ? { label: 'Up · Reddit unreachable', chip: 'chip-warn' }
          : { label: 'Working', chip: 'chip-ok' },
    checked: t?.testedAt ? `${ago(t.testedAt, now)} ago` : 'Never',
    browsers: x.profileCount,
    notes: x.notes ?? '',
    // for the edit panel
    edit: {
      label: x.label ?? '',
      notes: x.notes ?? '',
      provider: x.provider,
      protocol: x.protocol === 'socks5' ? ('socks5' as const) : ('http' as const),
      host: x.host ?? '',
      port: x.port ? String(x.port) : '',
      region: x.region ?? '',
      sticky: x.sticky,
    },
  };
}
export type ProxyRow = ReturnType<typeof proxyRow>;
