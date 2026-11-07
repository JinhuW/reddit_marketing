import { PrismaClient } from '@prisma/client';

const g = globalThis as unknown as { __tlPrisma?: PrismaClient };

export const prisma: PrismaClient =
  g.__tlPrisma ??
  new PrismaClient({ log: process.env.PRISMA_LOG === '1' ? ['query', 'warn', 'error'] : ['warn', 'error'] });

if (process.env.NODE_ENV !== 'production') g.__tlPrisma = prisma;

export type { Prisma } from '@prisma/client';
export * as P from '@prisma/client';
