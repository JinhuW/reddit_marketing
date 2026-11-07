// Repository functions for browser nodes (docs/plans/0001-infra-implementation.md §3.1, ADR-0001).
// Callers: the gateway (SERVICE_ROLE=gateway) and the Browsers screen. Node tokens are never stored or
// logged; only their sha256 is.
import { createHash, timingSafeEqual } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import { NodeName, type Seats } from '@threadline/shared';
import { prisma } from '../client';
import { writeAudit } from './audit';

/** sha256 (hex) of a node token; this is what `BrowserNode.tokenHash` holds. */
export function hashToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a, 'hex');
  const y = Buffer.from(b, 'hex');
  return x.length === y.length && x.length > 0 && timingSafeEqual(x, y);
}

/** Never return the hash to callers that might log or serialize the row. */
const publicSelect = {
  id: true,
  workspaceId: true,
  name: true,
  status: true,
  agentVersion: true,
  imageDigest: true,
  seatsInUse: true,
  seatsLimit: true,
  maxProfiles: true,
  lastSeenAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.BrowserNodeSelect;
export type NodeRow = Prisma.BrowserNodeGetPayload<{ select: typeof publicSelect }>;

/**
 * Creates the node, or rotates its token if it exists. The plain token goes to Railway
 * (`NODE_TOKEN_<NAME>`) and the node's env file; only its hash is stored.
 */
export async function register(input: {
  workspaceId: string;
  name: string;
  token: string;
  maxProfiles?: number;
  seatsLimit?: number | null;
}): Promise<NodeRow> {
  const name = NodeName.parse(input.name);
  if (input.token.length < 16) throw new Error('node token must be at least 16 characters');
  const tokenHash = hashToken(input.token);
  const limits = {
    ...(input.maxProfiles !== undefined ? { maxProfiles: input.maxProfiles } : {}),
    ...(input.seatsLimit !== undefined ? { seatsLimit: input.seatsLimit } : {}),
  };
  // Names are global (they name the queue and the gateway login), so never re-key another workspace's node.
  const existing = await prisma.browserNode.findUnique({ where: { name }, select: { workspaceId: true } });
  if (existing && existing.workspaceId !== input.workspaceId)
    throw new Error(`node name "${name}" is already used by another workspace`);
  return prisma.browserNode.upsert({
    where: { name },
    create: { workspaceId: input.workspaceId, name, tokenHash, ...limits },
    update: { tokenHash, ...limits },
    select: publicSelect,
  });
}

/**
 * Gateway auth: the node presents `X-Node-Name` and a bearer token. Returns the node whose name matches
 * and whose stored hash equals sha256(token) (constant-time compare), else null.
 */
export async function verifyToken(name: string, token: string): Promise<NodeRow | null> {
  if (!NodeName.safeParse(name).success || !token) return null;
  const candidates = await prisma.browserNode.findMany({
    where: { name },
    select: { ...publicSelect, tokenHash: true },
  });
  const h = hashToken(token);
  const hit = candidates.find((n) => sameHash(n.tokenHash, h));
  if (!hit) return null;
  const { tokenHash: _omit, ...node } = hit;
  return node;
}

export function getByName(workspaceId: string, name: string): Promise<NodeRow | null> {
  return prisma.browserNode.findFirst({ where: { workspaceId, name }, select: publicSelect });
}

export function getById(id: string): Promise<NodeRow | null> {
  return prisma.browserNode.findUnique({ where: { id }, select: publicSelect });
}

/** Online nodes, across workspaces unless one is given. The gateway runs one queue worker per row. */
export function listOnline(workspaceId?: string): Promise<NodeRow[]> {
  return prisma.browserNode.findMany({
    where: { status: 'online', ...(workspaceId ? { workspaceId } : {}) },
    select: publicSelect,
    orderBy: { name: 'asc' },
  });
}

export interface HelloInfo {
  agentVersion: string;
  imageDigest: string | null;
  maxProfiles: number;
  seats: Seats;
}

/** After a valid `hello`: status online, report fields, and `node.online` when it was not online. */
export async function markOnline(nodeId: string, info: HelloInfo, now = new Date()): Promise<NodeRow> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.browserNode.findUniqueOrThrow({ where: { id: nodeId }, select: publicSelect });
    const node = await tx.browserNode.update({
      where: { id: nodeId },
      data: {
        status: 'online',
        agentVersion: info.agentVersion,
        imageDigest: info.imageDigest,
        maxProfiles: info.maxProfiles,
        seatsInUse: info.seats.inUse,
        seatsLimit: info.seats.limit,
        lastSeenAt: now,
      },
      select: publicSelect,
    });
    if (before.status !== 'online') {
      await writeAudit(
        {
          workspaceId: node.workspaceId,
          actorMemberId: null,
          action: 'node.online',
          targetType: 'BrowserNode',
          targetId: node.id,
          meta: {
            node: node.name,
            from: before.status,
            agentVersion: info.agentVersion,
            imageDigest: info.imageDigest,
          },
        },
        tx,
      );
    }
    return node;
  });
}

/** Socket closed or heartbeats missed: status offline, and `node.offline` when it was not offline. */
export async function markOffline(nodeId: string, reason: string): Promise<NodeRow> {
  return prisma.$transaction(async (tx) => {
    const before = await tx.browserNode.findUniqueOrThrow({ where: { id: nodeId }, select: publicSelect });
    if (before.status === 'offline') return before;
    const node = await tx.browserNode.update({
      where: { id: nodeId },
      data: { status: 'offline' },
      select: publicSelect,
    });
    await writeAudit(
      {
        workspaceId: node.workspaceId,
        actorMemberId: null,
        action: 'node.offline',
        targetType: 'BrowserNode',
        targetId: node.id,
        meta: { node: node.name, from: before.status, reason },
      },
      tx,
    );
    return node;
  });
}

/** Every heartbeat: last seen and seat counts. No audit row (it would be one every 15 s). */
export function recordHeartbeat(nodeId: string, seats: Seats, now = new Date()): Promise<NodeRow> {
  return prisma.browserNode.update({
    where: { id: nodeId },
    data: { lastSeenAt: now, seatsInUse: seats.inUse, seatsLimit: seats.limit },
    select: publicSelect,
  });
}
