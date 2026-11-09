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

/**
 * One id per build, shared by the server and the browser bundle (both inline it at build time). The update banner
 * compares the id the open tab was built with against /api/version and asks for a reload when they differ.
 * Railway passes RAILWAY_GIT_COMMIT_SHA as a Docker build arg (see Dockerfile).
 */
const BUILD_ID = (process.env.RAILWAY_GIT_COMMIT_SHA || `local-${Date.now().toString(36)}`).slice(0, 12);

const nextConfig: NextConfig = {
  generateBuildId: async () => BUILD_ID,
  env: { NEXT_PUBLIC_BUILD_ID: BUILD_ID },
  transpilePackages: ['@threadline/shared', '@threadline/agents', '@threadline/db', '@threadline/ui-tokens'],
  serverExternalPackages: ['@prisma/client'],
  poweredByHeader: false,
  experimental: { serverActions: { allowedOrigins: actionOrigins() } },
};

export default nextConfig;
