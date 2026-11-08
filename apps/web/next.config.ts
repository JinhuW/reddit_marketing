import type { NextConfig } from 'next';

/**
 * Hosts a browser may submit Server Actions from. The public domain (APP_URL / AUTH_URL, e.g.
 * reddits.recycleservers.com) forwards to the Railway host, so `x-forwarded-host` names the Railway domain while
 * `origin` names the public one; Next.js aborts such actions unless the public host is listed here.
 */
function actionOrigins(): string[] {
  const hosts = new Set<string>();
  for (const v of [process.env.APP_URL, process.env.AUTH_URL]) {
    if (!v) continue;
    try {
      hosts.add(new URL(v).host);
    } catch {
      // not a URL: ignore
    }
  }
  return [...hosts];
}

const nextConfig: NextConfig = {
  transpilePackages: ['@threadline/shared', '@threadline/agents', '@threadline/db', '@threadline/ui-tokens'],
  serverExternalPackages: ['@prisma/client'],
  poweredByHeader: false,
  experimental: { serverActions: { allowedOrigins: actionOrigins() } },
};

export default nextConfig;
