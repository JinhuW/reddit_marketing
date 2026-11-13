/**
 * Add (or update) a workspace proxy so the connect flow and the Browsers screen can offer it. The proxy URL, which
 * may carry the vendor login, is read from stdin and never echoed; the login is stored encrypted with
 * APP_ENCRYPTION_KEY. Run it where DATABASE_URL and APP_ENCRYPTION_KEY are set (`railway run` or `railway ssh`):
 *
 *   printf '%s' "http://user:pass@host:port" | \
 *     WORKSPACE_SLUG=<slug> PROXY_PROVIDER=Decodo PROXY_REGION="Boston, US" node_modules/.bin/tsx src/cli/add-proxy.ts
 *
 * Prints {id, created, host, port, hasCredentials}.
 */
import { browsers, prisma } from '@threadline/db';
import { encrypt } from '@threadline/shared/crypto';

async function readStdin(): Promise<string> {
  if (process.stdin.isTTY) throw new Error('pipe the proxy URL on stdin (do not paste it)');
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c as Buffer);
  return Buffer.concat(chunks).toString('utf8').trim();
}

/** `scheme://[user:pass@]host:port` → parts; http, https and socks5 (socks5h counts as socks5). */
export function parseProxyUrl(raw: string) {
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new Error('not a proxy URL (expected scheme://[user:pass@]host:port)');
  }
  const scheme = u.protocol.replace(/:$/, '');
  const protocol =
    scheme === 'http' || scheme === 'https'
      ? scheme
      : scheme === 'socks5' || scheme === 'socks5h'
        ? 'socks5'
        : null;
  if (!protocol) throw new Error(`unsupported proxy scheme ${scheme}`);
  const port = Number(u.port);
  if (!u.hostname || !Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('proxy URL needs a host and a port');
  return {
    protocol,
    host: u.hostname,
    port,
    username: u.username ? decodeURIComponent(u.username) : null,
    password: u.password ? decodeURIComponent(u.password) : null,
  } as const;
}

async function main() {
  const slug = process.env.WORKSPACE_SLUG;
  if (!slug) throw new Error('set WORKSPACE_SLUG; pipe the proxy URL on stdin');
  const p = parseProxyUrl(await readStdin());
  const ws = await prisma.workspace.findUnique({ where: { slug }, select: { id: true } });
  if (!ws) throw new Error(`no workspace ${slug}`);
  const r = await browsers.createProxy(ws.id, {
    provider: process.env.PROXY_PROVIDER || p.host,
    protocol: p.protocol,
    host: p.host,
    port: p.port,
    region: process.env.PROXY_REGION || null,
    usernameEnc: p.username ? encrypt(p.username) : null,
    passwordEnc: p.password ? encrypt(p.password) : null,
  });
  console.log(
    JSON.stringify({ ...r, host: p.host, port: p.port, hasCredentials: Boolean(p.username || p.password) }),
  );
}

if (process.argv[1]?.endsWith('add-proxy.ts'))
  main()
    .catch((e: unknown) => {
      console.error(e instanceof Error ? e.message.split('\n')[0] : String(e));
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
