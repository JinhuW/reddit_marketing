// Plan 0004 phase 3: "bulk add" of the proxy pool. One proxy per line, in the forms proxy vendors hand out:
//   host:port                      host:port:user:pass          user:pass@host:port
//   scheme://host:port             scheme://user:pass@host:port
// with two optional suffixes in any order:  {a note}   [https://change-ip-link]
// Pure; nothing here touches the network.

export const PROXY_PASTE_MAX = 200;

export interface ParsedProxy {
  protocol: 'http' | 'socks5';
  host: string;
  port: number;
  username: string | null;
  password: string | null;
  note: string | null;
  refreshUrl: string | null;
}
export interface ProxyParseResult {
  proxies: ParsedProxy[];
  /** 1-based line numbers with the reason; credentials are never echoed */
  errors: { line: number; reason: string }[];
}

const SCHEMES: Record<string, 'http' | 'socks5'> = { http: 'http', socks5: 'socks5', socks5h: 'socks5' };
const validPort = (s: string) => /^\d{1,5}$/.test(s) && Number(s) >= 1 && Number(s) <= 65535;
// A hostname or an IPv4 address. IPv6 literals need the URL form with brackets.
const validHost = (s: string) => /^[A-Za-z0-9]([A-Za-z0-9.-]{0,251}[A-Za-z0-9])?$/.test(s);

function parseOne(raw: string, fallback: 'http' | 'socks5'): ParsedProxy | string {
  let rest = raw;
  let note: string | null = null;
  let refreshUrl: string | null = null;
  const noteMatch = /\{([^{}]*)\}/.exec(rest);
  if (noteMatch) {
    note = noteMatch[1]?.trim().slice(0, 200) || null;
    rest = rest.replace(noteMatch[0], '');
  }
  // After a scheme, `[` starts an IPv6 host, so only a bracket holding a link counts as the change-IP link.
  const linkMatch = /\[(https?:\/\/[^\]\s]+)\]/i.exec(rest);
  if (linkMatch) {
    refreshUrl = linkMatch[1] ?? null;
    rest = rest.replace(linkMatch[0], '');
  }
  rest = rest.trim();
  if (!rest) return 'no proxy on this line';

  let protocol = fallback;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):\/\//.exec(rest);
  if (scheme) {
    const known = SCHEMES[(scheme[1] ?? '').toLowerCase()];
    if (!known) return `unsupported scheme ${scheme[1]} (use http or socks5)`;
    protocol = known;
    let u: URL;
    try {
      u = new URL(rest);
    } catch {
      return 'not a proxy address';
    }
    if (!u.hostname || !validPort(u.port)) return 'needs a host and a port';
    return {
      protocol,
      host: u.hostname.replace(/^\[|\]$/g, ''),
      port: Number(u.port),
      username: u.username ? decodeURIComponent(u.username) : null,
      password: u.password ? decodeURIComponent(u.password) : null,
      note,
      refreshUrl,
    };
  }

  let userinfo: string | null = null;
  let hostPart = rest;
  const at = rest.lastIndexOf('@');
  if (at > 0) {
    userinfo = rest.slice(0, at);
    hostPart = rest.slice(at + 1);
  }
  const parts = hostPart.split(':');
  const [host = '', port = ''] = parts;
  if (!validHost(host) || !validPort(port)) return 'needs host:port';
  let username: string | null = null;
  let password: string | null = null;
  if (userinfo !== null) {
    if (parts.length !== 2) return 'use user:pass@host:port or host:port:user:pass, not both';
    const i = userinfo.indexOf(':');
    username = i < 0 ? userinfo : userinfo.slice(0, i);
    password = i < 0 ? null : userinfo.slice(i + 1);
  } else if (parts.length >= 3) {
    username = parts[2] || null;
    // A password may contain ':'.
    password = parts.length > 3 ? parts.slice(3).join(':') : null;
  }
  return { protocol, host, port: Number(port), username, password, note, refreshUrl };
}

/** Parses a pasted list. Blank lines and lines starting with `#` are skipped. */
export function parseProxyLines(text: string, fallback: 'http' | 'socks5' = 'http'): ProxyParseResult {
  const out: ProxyParseResult = { proxies: [], errors: [] };
  const lines = text.split(/\r?\n/);
  for (const [i, raw] of lines.entries()) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    if (out.proxies.length >= PROXY_PASTE_MAX) {
      out.errors.push({
        line: i + 1,
        reason: `only the first ${PROXY_PASTE_MAX} proxies are added at a time`,
      });
      break;
    }
    const r = parseOne(line, fallback);
    if (typeof r === 'string') out.errors.push({ line: i + 1, reason: r });
    else out.proxies.push(r);
  }
  return out;
}
