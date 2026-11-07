// Repository functions for Browsers (9b) and Remote session (9c). See docs/PLAN.md §6, §7.
import type { Prisma } from '@prisma/client';
import { prisma } from '../client';
import { writeAudit } from './audit';

export interface Fingerprint {
  os?: string;
  screen?: string;
  tz?: string;
  locale?: string;
  ownerPlace?: string;
  capturedAt?: string;
}
export interface ProxyTest {
  ip?: string;
  city?: string;
  country?: string;
  timeZone?: string;
  latencyMs?: number;
  redditOk?: boolean;
  testedAt?: string;
  kind?: string;
  label?: string;
}

const profileInclude = {
  proxy: true,
  account: {
    include: {
      owner: { include: { user: { select: { name: true, email: true } } } },
      agents: { select: { id: true, name: true, color: true, status: true }, orderBy: { createdAt: 'asc' } },
    },
  },
  sessions: {
    where: { endedAt: null },
    orderBy: { startedAt: 'desc' },
    take: 1,
    include: {
      startedBy: { include: { user: { select: { name: true } } } },
      agent: { select: { name: true, color: true } },
    },
  },
} satisfies Prisma.BrowserProfileInclude;

export type ProfileRow = Prisma.BrowserProfileGetPayload<{ include: typeof profileInclude }>;

export function listProfiles(workspaceId: string) {
  return prisma.browserProfile.findMany({
    where: { workspaceId },
    include: profileInclude,
    orderBy: { createdAt: 'asc' },
  });
}

export function getProfile(workspaceId: string, id: string) {
  return prisma.browserProfile.findFirst({ where: { workspaceId, id }, include: profileInclude });
}

/** Admins and the account's owner may change a profile or take over its browser. */
export function canControlProfile(
  me: { id: string; role: string },
  profile: { account: { ownerMemberId: string } },
): boolean {
  return me.role === 'admin' || profile.account.ownerMemberId === me.id;
}

export interface ProxyUpdate {
  provider: string;
  protocol: 'http' | 'socks5' | 'none';
  host: string | null;
  port: number | null;
  sticky: boolean;
  region: string | null;
  /** already encrypted; undefined = keep the saved value */
  usernameEnc?: string;
  passwordEnc?: string;
}

/** Updates (or creates) the profile's proxy. Credentials arrive encrypted; nothing is decrypted here. */
export async function saveProxy(
  workspaceId: string,
  profileId: string,
  actorMemberId: string,
  data: ProxyUpdate,
) {
  return prisma.$transaction(async (tx) => {
    const profile = await tx.browserProfile.findFirstOrThrow({ where: { workspaceId, id: profileId } });
    const fields = {
      provider: data.provider,
      protocol: data.protocol,
      host: data.protocol === 'none' ? null : data.host,
      port: data.protocol === 'none' ? null : data.port,
      sticky: data.sticky,
      region: data.region,
      ...(data.usernameEnc !== undefined ? { usernameEnc: data.usernameEnc } : {}),
      ...(data.passwordEnc !== undefined ? { passwordEnc: data.passwordEnc } : {}),
    };
    let proxyId = profile.proxyId;
    if (proxyId) await tx.proxy.update({ where: { id: proxyId }, data: fields });
    else {
      const p = await tx.proxy.create({ data: { workspaceId, ...fields } });
      proxyId = p.id;
      await tx.browserProfile.update({ where: { id: profileId }, data: { proxyId } });
    }
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.proxy_updated',
        targetType: 'BrowserProfile',
        targetId: profileId,
        accountId: profile.accountId,
        meta: {
          item: `Proxy settings for ${profile.name}`,
          protocol: data.protocol,
          host: fields.host,
          port: fields.port,
          credentialsChanged: data.usernameEnc !== undefined || data.passwordEnc !== undefined,
        },
      },
      tx,
    );
    return proxyId;
  });
}

// ── sessions ──

export function openSession(profileId: string) {
  return prisma.browserSession.findFirst({
    where: { profileId, endedAt: null },
    orderBy: { startedAt: 'desc' },
    include: {
      startedBy: { include: { user: { select: { name: true } } } },
      agent: { select: { name: true, color: true } },
    },
  });
}

export function latestSession(profileId: string) {
  return prisma.browserSession.findFirst({
    where: { profileId },
    orderBy: { startedAt: 'desc' },
    include: {
      startedBy: { include: { user: { select: { name: true } } } },
      agent: { select: { name: true, color: true } },
    },
  });
}

export async function sessionLog(sessionId: string) {
  const rows = await prisma.auditEvent.findMany({
    where: { sessionId },
    orderBy: { at: 'desc' },
    take: 200,
    include: { actor: { include: { user: { select: { name: true } } } } },
  });
  return rows.map((r) => {
    const meta = (r.meta ?? {}) as Record<string, unknown>;
    const who = (meta.who as string) ?? r.actor?.user.name ?? 'System';
    const text =
      (meta.text as string) ??
      (r.action === 'session.started'
        ? `took control${meta.reason ? ` · ${meta.reason}` : ''}`
        : r.action === 'session.handed_back'
          ? 'handed back to the agent'
          : r.action === 'session.ended'
            ? 'ended the session'
            : r.action);
    return { id: r.id, at: r.at, who, text };
  });
}

export class SessionConflictError extends Error {}

/** Human take-over: one open session per profile; pauses the agent for that account (driver = human). */
export async function startHumanSession(input: {
  workspaceId: string;
  profileId: string;
  memberId: string;
  memberName: string;
  reason: string;
}) {
  return prisma.$transaction(async (tx) => {
    const profile = await tx.browserProfile.findFirstOrThrow({
      where: { workspaceId: input.workspaceId, id: input.profileId },
      include: { account: { include: { agents: { select: { id: true, name: true }, take: 1 } } } },
    });
    const open = await tx.browserSession.findFirst({ where: { profileId: profile.id, endedAt: null } });
    if (open?.driver === 'human')
      throw new SessionConflictError('Someone already has control of this browser.');
    if (open) await tx.browserSession.update({ where: { id: open.id }, data: { endedAt: new Date() } });
    const agent = profile.account.agents[0] ?? null;
    const s = await tx.browserSession.create({
      data: {
        workspaceId: input.workspaceId,
        profileId: profile.id,
        driver: 'human',
        startedByMemberId: input.memberId,
        agentId: agent?.id ?? null,
        reason: input.reason,
      },
    });
    await tx.browserProfile.update({ where: { id: profile.id }, data: { lastSessionAt: new Date() } });
    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorMemberId: input.memberId,
        action: 'session.started',
        targetType: 'BrowserSession',
        targetId: s.id,
        sessionId: s.id,
        accountId: profile.accountId,
        meta: {
          who: input.memberName,
          text: `took control${agent ? ` · ${agent.name} paused` : ''}`,
          reason: input.reason,
          profile: profile.name,
        },
      },
      tx,
    );
    return s;
  });
}

/** Ends a human session and returns control to the agent (the worker resumes its queue). */
export async function handBack(input: {
  workspaceId: string;
  sessionId: string;
  memberId: string;
  memberName: string;
}) {
  return prisma.$transaction(async (tx) => {
    const s = await tx.browserSession.findFirstOrThrow({
      where: { workspaceId: input.workspaceId, id: input.sessionId },
      include: { profile: true, agent: { select: { name: true } } },
    });
    if (s.endedAt) return s;
    const ended = await tx.browserSession.update({ where: { id: s.id }, data: { endedAt: new Date() } });
    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorMemberId: input.memberId,
        action: 'session.handed_back',
        targetType: 'BrowserSession',
        targetId: s.id,
        sessionId: s.id,
        accountId: s.profile.accountId,
        meta: {
          who: input.memberName,
          text: `handed back${s.agent ? ` to ${s.agent.name}` : ''}`,
          profile: s.profile.name,
        },
      },
      tx,
    );
    return ended;
  });
}
