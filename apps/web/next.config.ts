import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  transpilePackages: ['@threadline/shared', '@threadline/agents', '@threadline/db', '@threadline/ui-tokens'],
  serverExternalPackages: ['@prisma/client'],
  poweredByHeader: false,
};

export default nextConfig;
