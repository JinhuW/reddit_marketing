// Plan 0004 phase 7: keys for the browser management API (/api/v1). A key is shown once, when it is made; the
// database keeps its sha256 only. A key acts as the member it belongs to.
import { createHash, randomBytes } from 'node:crypto';
import { prisma } from '../client';
import { writeAudit } from './audit';

export const API_KEY_PREFIX = 'tl_';
/** Keys one workspace may hold at a time. */
export const MAX_API_KEYS = 20;

export class ApiKeyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApiKeyError';
  }
}

const hash = (key: string) => createHash('sha256').update(key).digest('hex');

/** Creates a key for `memberId`. Returns the key itself: this is the only time it exists outside the caller. */
export async function createApiKey(workspaceId: string, memberId: string, rawName: string) {
  const name = rawName.trim().replace(/\s+/g, ' ').slice(0, 60);
  if (!name) throw new ApiKeyError('Give the key a name.');
  return prisma.$transaction(async (tx) => {
    const member = await tx.workspaceMember.findFirst({ where: { id: memberId, workspaceId } });
    if (!member) throw new ApiKeyError('Member not found.');
    const live = await tx.apiKey.count({ where: { workspaceId, revokedAt: null } });
    if (live >= MAX_API_KEYS) throw new ApiKeyError(`At most ${MAX_API_KEYS} keys. Revoke one first.`);
    const key = `${API_KEY_PREFIX}${randomBytes(32).toString('base64url')}`;
    const row = await tx.apiKey.create({
      data: { workspaceId, memberId, name, prefix: key.slice(0, 10), keyHash: hash(key) },
      select: { id: true },
    });
    await writeAudit(
      {
        workspaceId,
        actorMemberId: memberId,
        action: 'api_key.created',
        targetType: 'ApiKey',
        targetId: row.id,
        meta: { item: `API key ${name} created` },
      },
      tx,
    );
    return { id: row.id, name, key };
  });
}

/** Keys of the workspace, newest first. Never the key or its hash. */
export async function listApiKeys(workspaceId: string) {
  const rows = await prisma.apiKey.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'desc' },
    select: {
      id: true,
      name: true,
      prefix: true,
      lastUsedAt: true,
      revokedAt: true,
      createdAt: true,
      member: { select: { id: true, role: true, user: { select: { name: true, email: true } } } },
    },
  });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    prefix: r.prefix,
    lastUsedAt: r.lastUsedAt,
    revokedAt: r.revokedAt,
    createdAt: r.createdAt,
    memberId: r.member.id,
    memberName: r.member.user.name ?? r.member.user.email,
    memberRole: r.member.role,
  }));
}

/** Revokes a key at once. Audit `api_key.revoked`. */
export function revokeApiKey(workspaceId: string, actorMemberId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const k = await tx.apiKey.findFirst({ where: { workspaceId, id } });
    if (!k) throw new ApiKeyError('Key not found.');
    if (k.revokedAt) return { changed: false };
    await tx.apiKey.update({ where: { id }, data: { revokedAt: new Date() } });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'api_key.revoked',
        targetType: 'ApiKey',
        targetId: id,
        meta: { item: `API key ${k.name} revoked` },
      },
      tx,
    );
    return { changed: true };
  });
}

/**
 * The member a presented key acts as, or null for an unknown or revoked key. `lastUsedAt` is refreshed at most
 * once a minute, so a busy client does not write on every call.
 */
export async function verifyApiKey(key: string, now = new Date()) {
  if (!key.startsWith(API_KEY_PREFIX) || key.length < 20 || key.length > 100) return null;
  const k = await prisma.apiKey.findUnique({
    where: { keyHash: hash(key) },
    select: {
      id: true,
      revokedAt: true,
      lastUsedAt: true,
      workspaceId: true,
      member: { select: { id: true, role: true, workspaceId: true } },
    },
  });
  if (!k || k.revokedAt || k.member.workspaceId !== k.workspaceId) return null;
  if (!k.lastUsedAt || now.getTime() - k.lastUsedAt.getTime() > 60_000)
    await prisma.apiKey.updateMany({ where: { id: k.id }, data: { lastUsedAt: now } });
  return { keyId: k.id, workspaceId: k.workspaceId, id: k.member.id, role: k.member.role };
}
