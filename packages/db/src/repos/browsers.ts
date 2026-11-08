// Repository functions for Browsers (9b) and Remote session (9c). See docs/PLAN.md §6, §7.
// Browser-node functions (assignNode … getProfileForDispatch): docs/plans/0001-infra-implementation.md §3.
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  type AccountAuthMode,
  CloakGpu,
  CloakPersona,
  type PauseReason,
  type ProxySpec,
} from '@threadline/shared';
import { decrypt } from '@threadline/shared/crypto';
import { prisma } from '../client';
import { writeAudit } from './audit';

export interface Fingerprint {
  os?: string;
  screen?: string;
  tz?: string;
  locale?: string;
  ownerPlace?: string;
  capturedAt?: string;
  /** hex salt `cloakSeed` was derived from (ensureCloakFingerprint); kept so the seed is reproducible */
  cloakSalt?: string;
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

// ── browser nodes and CloakBrowser (ADR-0001) ──

type Db = Prisma.TransactionClient;

/** {@link assignNode} inside `tx`: writes `profile.node_assigned` { from, to } when the node changes. */
export async function assignNodeTx(
  tx: Db,
  workspaceId: string,
  profileId: string,
  nodeId: string | null,
  actorMemberId: string | null = null,
) {
  const profile = await tx.browserProfile.findFirstOrThrow({
    where: { workspaceId, id: profileId },
    select: { id: true, name: true, accountId: true, nodeId: true, node: { select: { name: true } } },
  });
  const to = nodeId
    ? await tx.browserNode.findFirstOrThrow({
        where: { workspaceId, id: nodeId },
        select: { id: true, name: true },
      })
    : null;
  const row = await tx.browserProfile.update({
    where: { id: profileId },
    data: { nodeId },
    select: { id: true, nodeId: true },
  });
  if (profile.nodeId !== nodeId) {
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.node_assigned',
        targetType: 'BrowserProfile',
        targetId: profileId,
        accountId: profile.accountId,
        meta: {
          item: `${profile.name} → ${to?.name ?? 'no node'}`,
          from: profile.node?.name ?? null,
          to: to?.name ?? null,
          fromNodeId: profile.nodeId,
          toNodeId: to?.id ?? null,
        },
      },
      tx,
    );
  }
  return row;
}

/** Runs the profile on a node (or detaches it with null). The node must belong to the same workspace. */
export async function assignNode(
  workspaceId: string,
  profileId: string,
  nodeId: string | null,
  actorMemberId: string | null = null,
) {
  return prisma.$transaction((tx) => assignNodeTx(tx, workspaceId, profileId, nodeId, actorMemberId));
}

// ── proxies (one workspace's proxies can be shared by several profiles) ──

/** Proxy fields that are safe to show. The encrypted username/password are never returned. */
export interface ProxyListItem {
  id: string;
  provider: string;
  protocol: 'http' | 'socks5' | 'none';
  host: string | null;
  port: number | null;
  sticky: boolean;
  region: string | null;
  lastTest: ProxyTest | null;
  /** a username or password is saved (encrypted); the values are not returned */
  hasCredentials: boolean;
  profileCount: number;
  createdAt: Date;
}

/** The workspace's proxies, oldest first (the "use an existing proxy" picker). */
export async function listProxies(workspaceId: string): Promise<ProxyListItem[]> {
  const rows = await prisma.proxy.findMany({
    where: { workspaceId },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      provider: true,
      protocol: true,
      host: true,
      port: true,
      sticky: true,
      region: true,
      lastTest: true,
      createdAt: true,
      usernameEnc: true,
      passwordEnc: true,
      _count: { select: { profiles: true } },
    },
  });
  return rows.map(({ usernameEnc, passwordEnc, _count, lastTest, ...r }) => ({
    ...r,
    lastTest: (lastTest ?? null) as ProxyTest | null,
    hasCredentials: Boolean(usernameEnc || passwordEnc),
    profileCount: _count.profiles,
  }));
}

/**
 * Adds a workspace proxy no profile uses yet (ops CLI `add-proxy`; the picker then offers it). Credentials arrive
 * already encrypted. Re-adding the same host:port in the workspace updates that row instead of duplicating it.
 */
export async function createProxy(
  workspaceId: string,
  data: {
    provider: string;
    protocol: 'http' | 'socks5';
    host: string;
    port: number;
    region?: string | null;
    sticky?: boolean;
    usernameEnc?: string | null;
    passwordEnc?: string | null;
  },
): Promise<{ id: string; created: boolean }> {
  const fields = {
    provider: data.provider,
    protocol: data.protocol,
    host: data.host,
    port: data.port,
    region: data.region ?? null,
    sticky: data.sticky ?? true,
    usernameEnc: data.usernameEnc ?? null,
    passwordEnc: data.passwordEnc ?? null,
  };
  const existing = await prisma.proxy.findFirst({
    where: { workspaceId, host: data.host, port: data.port },
    select: { id: true },
  });
  if (existing) {
    await prisma.proxy.update({ where: { id: existing.id }, data: fields });
    return { id: existing.id, created: false };
  }
  const p = await prisma.proxy.create({ data: { workspaceId, ...fields }, select: { id: true } });
  return { id: p.id, created: true };
}

/** {@link attachProxy} inside `tx`. */
export async function attachProxyTx(
  tx: Db,
  workspaceId: string,
  profileId: string,
  proxyId: string,
  actorMemberId: string | null = null,
): Promise<{ changed: boolean }> {
  const profile = await tx.browserProfile.findFirstOrThrow({
    where: { workspaceId, id: profileId },
    select: { id: true, name: true, accountId: true, proxyId: true },
  });
  const proxy = await tx.proxy.findFirst({
    where: { workspaceId, id: proxyId },
    select: { id: true, protocol: true, host: true, port: true },
  });
  if (!proxy) throw new Error('Proxy not found');
  if (profile.proxyId === proxy.id) return { changed: false };
  await tx.browserProfile.update({ where: { id: profile.id }, data: { proxyId: proxy.id } });
  await writeAudit(
    {
      workspaceId,
      actorMemberId,
      action: 'profile.proxy_updated',
      targetType: 'BrowserProfile',
      targetId: profile.id,
      accountId: profile.accountId,
      meta: {
        item: `Proxy settings for ${profile.name}`,
        attachedProxyId: proxy.id,
        previousProxyId: profile.proxyId,
        protocol: proxy.protocol,
        host: proxy.host,
        port: proxy.port,
        credentialsChanged: false,
      },
    },
    tx,
  );
  return { changed: true };
}

/**
 * Points a profile at an existing proxy of the same workspace; no-op when it already uses it. Nothing is
 * decrypted. The previous proxy, if any, stays for the profiles that still use it.
 */
export function attachProxy(
  workspaceId: string,
  profileId: string,
  proxyId: string,
  actorMemberId: string | null = null,
): Promise<{ changed: boolean }> {
  return prisma.$transaction((tx) => attachProxyTx(tx, workspaceId, profileId, proxyId, actorMemberId));
}

/** Seed in [0, 2^31) from the profile id and a salt: fits `Int` and CloakBrowser's `--fingerprint`. */
export function deriveCloakSeed(profileId: string, salt: string): number {
  return createHash('sha256').update(`${profileId}:${salt}`, 'utf8').digest().readUInt32BE(0) >>> 1;
}

/** Owner's OS (as captured at connect time) → CloakBrowser persona. */
export function personaFromOs(os: string | undefined): CloakPersona {
  if (!os) return 'windows';
  if (/mac|darwin|os ?x/i.test(os)) return 'macos';
  if (/linux|ubuntu|debian|fedora|chrome ?os/i.test(os)) return 'linux';
  return 'windows';
}

export interface CloakFingerprint {
  seed: number;
  persona: CloakPersona;
  gpu: CloakGpu;
}

/**
 * Gives the profile its CloakBrowser fingerprint once, at connect time, and never changes it: a new seed
 * would look like a new device. The seed is derived from the profile id and a random salt that is stored
 * in `fingerprint.cloakSalt`. Persona defaults to the owner's captured OS, GPU to `intel`.
 * Writes `profile.fingerprint_assigned` only on the call that assigns it.
 */
export function ensureCloakFingerprint(
  input: EnsureCloakInput,
): Promise<CloakFingerprint & { assigned: boolean }> {
  return prisma.$transaction((tx) => ensureCloakFingerprintTx(tx, input));
}

export interface EnsureCloakInput {
  workspaceId: string;
  profileId: string;
  persona?: CloakPersona;
  gpu?: CloakGpu;
  actorMemberId?: string | null;
}

/** {@link ensureCloakFingerprint} inside `tx` (accounts.startBrowserConnect creates the profile in the same one). */
export async function ensureCloakFingerprintTx(
  tx: Db,
  input: EnsureCloakInput,
): Promise<CloakFingerprint & { assigned: boolean }> {
  if (input.persona && !CloakPersona.includes(input.persona)) throw new Error('unknown persona');
  if (input.gpu && !CloakGpu.includes(input.gpu)) throw new Error('unknown gpu');
  {
    const existing = (p: {
      cloakSeed: number | null;
      cloakPersona: string | null;
      cloakGpu: string | null;
    }) => ({
      seed: p.cloakSeed!,
      persona: (p.cloakPersona ?? 'windows') as CloakPersona,
      gpu: (p.cloakGpu ?? 'intel') as CloakGpu,
      assigned: false,
    });
    const profile = await tx.browserProfile.findFirstOrThrow({
      where: { workspaceId: input.workspaceId, id: input.profileId },
    });
    if (profile.cloakSeed !== null) return existing(profile);

    const fp = (profile.fingerprint ?? {}) as Fingerprint;
    const salt = randomBytes(16).toString('hex');
    const out: CloakFingerprint = {
      seed: deriveCloakSeed(profile.id, salt),
      persona: input.persona ?? personaFromOs(fp.os),
      gpu: input.gpu ?? 'intel',
    };
    // Conditional write: a concurrent caller that got here first wins, and we return its values.
    const { count } = await tx.browserProfile.updateMany({
      where: { id: profile.id, cloakSeed: null },
      data: {
        cloakSeed: out.seed,
        cloakPersona: out.persona,
        cloakGpu: out.gpu,
        fingerprint: { ...fp, cloakSalt: salt } as Prisma.InputJsonValue,
      },
    });
    if (count === 0)
      return existing(await tx.browserProfile.findUniqueOrThrow({ where: { id: profile.id } }));
    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorMemberId: input.actorMemberId ?? null,
        action: 'profile.fingerprint_assigned',
        targetType: 'BrowserProfile',
        targetId: profile.id,
        accountId: profile.accountId,
        // the seed itself is not secret, but there is no reason to spread it
        meta: { item: `Fingerprint for ${profile.name}`, persona: out.persona, gpu: out.gpu },
      },
      tx,
    );
    return { ...out, assigned: true };
  }
}

/**
 * Pauses a Reddit account: `post.publish` and browser dispatch skip it until resumed. The first reason
 * wins: pausing an already-paused account changes nothing and writes no audit row, so a later
 * `node_offline` cannot hide an earlier `needs_human`.
 */
export async function pauseAccount(input: {
  workspaceId: string;
  accountId: string;
  reason: PauseReason;
  actorMemberId?: string | null;
  detail?: string;
}): Promise<{ changed: boolean; reason: PauseReason }> {
  return prisma.$transaction(async (tx) => {
    const acc = await tx.redditAccount.findFirstOrThrow({
      where: { workspaceId: input.workspaceId, id: input.accountId },
      select: { id: true, username: true, pausedReason: true },
    });
    if (acc.pausedReason) return { changed: false, reason: acc.pausedReason };
    const { count } = await tx.redditAccount.updateMany({
      where: { id: acc.id, pausedReason: null },
      data: { pausedReason: input.reason, pausedAt: new Date() },
    });
    if (count === 0) {
      const now = await tx.redditAccount.findUniqueOrThrow({
        where: { id: acc.id },
        select: { pausedReason: true },
      });
      return { changed: false, reason: now.pausedReason ?? input.reason };
    }
    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorMemberId: input.actorMemberId ?? null,
        action: 'account.paused',
        targetType: 'RedditAccount',
        targetId: acc.id,
        accountId: acc.id,
        meta: {
          item: `u/${acc.username} paused`,
          reason: input.reason,
          ...(input.detail ? { detail: input.detail } : {}),
        },
      },
      tx,
    );
    return { changed: true, reason: input.reason };
  });
}

/**
 * Clears an account's pause. With `onlyReasons`, resumes only if the current reason is one of them
 * (the gateway resumes `node_offline` pauses when a node returns, never a `needs_human` one).
 */
export async function resumeAccount(input: {
  workspaceId: string;
  accountId: string;
  actorMemberId?: string | null;
  onlyReasons?: PauseReason[];
}): Promise<{ changed: boolean; was: PauseReason | null }> {
  return prisma.$transaction(async (tx) => {
    const acc = await tx.redditAccount.findFirstOrThrow({
      where: { workspaceId: input.workspaceId, id: input.accountId },
      select: { id: true, username: true, pausedReason: true, pausedAt: true },
    });
    const was = acc.pausedReason;
    if (!was || (input.onlyReasons && !input.onlyReasons.includes(was))) return { changed: false, was };
    const { count } = await tx.redditAccount.updateMany({
      where: { id: acc.id, pausedReason: was },
      data: { pausedReason: null, pausedAt: null },
    });
    if (count === 0) return { changed: false, was };
    await writeAudit(
      {
        workspaceId: input.workspaceId,
        actorMemberId: input.actorMemberId ?? null,
        action: 'account.resumed',
        targetType: 'RedditAccount',
        targetId: acc.id,
        accountId: acc.id,
        meta: { item: `u/${acc.username} resumed`, was, pausedAt: acc.pausedAt?.toISOString() ?? null },
      },
      tx,
    );
    return { changed: true, was };
  });
}

/** `1512×982` / `1512x982` → `1512x982`; anything else → null. */
/**
 * One BCP 47 tag for the browser's LOCALE. The captured fingerprint holds the owner's `navigator.languages`
 * ("en-US, en, zh-CN" or "en-US;q=0.9"); the container takes a single tag and exits on anything else.
 */
export function normalizeLocale(s: string | undefined): string {
  const first = s?.split(',')[0]?.split(';')[0]?.trim() ?? '';
  return /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/.test(first) ? first : 'en-US';
}

function normalizeScreen(s: string | undefined): string | null {
  const m = s?.match(/^\s*(\d{3,5})\s*[x×X]\s*(\d{3,5})\s*$/);
  return m ? `${m[1]}x${m[2]}` : null;
}

export interface DispatchProfile {
  id: string;
  workspaceId: string;
  name: string;
  accountId: string;
  account: {
    id: string;
    username: string;
    ownerMemberId: string;
    pausedReason: PauseReason | null;
    authMode: AccountAuthMode;
    /** null = nobody has signed in to this browser-mode account yet: never dispatch actions (isIdentified) */
    identifiedAt: Date | null;
  };
  node: { id: string; name: string; status: string } | null;
  /** null until ensureCloakFingerprint ran: the gateway must not start the profile without it */
  cloak: CloakFingerprint | null;
  tz: string;
  locale: string;
  screen: string;
  /** decrypted; null when the profile has no proxy or protocol `none` */
  proxy: ProxySpec | null;
}

/**
 * GATEWAY-ONLY. Loads a profile for `profile.start` with its proxy credentials decrypted. This is the
 * only function that decrypts proxy credentials; call it at dispatch time, put the result only in the
 * command sent over the authenticated socket, and never log, queue or persist it.
 */
export async function getProfileForDispatch(
  workspaceId: string,
  profileId: string,
): Promise<DispatchProfile | null> {
  const p = await prisma.browserProfile.findFirst({
    where: { workspaceId, id: profileId },
    include: {
      proxy: true,
      node: { select: { id: true, name: true, status: true } },
      account: {
        select: {
          id: true,
          username: true,
          ownerMemberId: true,
          pausedReason: true,
          authMode: true,
          identifiedAt: true,
        },
      },
    },
  });
  if (!p) return null;
  const fp = (p.fingerprint ?? {}) as Fingerprint;
  let proxy: ProxySpec | null = null;
  const px = p.proxy;
  if (px && px.protocol !== 'none' && px.host && px.port) {
    proxy = {
      protocol: px.protocol,
      host: px.host,
      port: px.port,
      ...(px.usernameEnc ? { username: decrypt(px.usernameEnc) } : {}),
      ...(px.passwordEnc ? { password: decrypt(px.passwordEnc) } : {}),
    };
  }
  return {
    id: p.id,
    workspaceId: p.workspaceId,
    name: p.name,
    accountId: p.accountId,
    account: p.account,
    node: p.node,
    cloak:
      p.cloakSeed === null
        ? null
        : {
            seed: p.cloakSeed,
            persona: (p.cloakPersona ?? 'windows') as CloakPersona,
            gpu: (p.cloakGpu ?? 'intel') as CloakGpu,
          },
    tz: fp.tz || 'UTC',
    locale: normalizeLocale(fp.locale),
    screen: normalizeScreen(fp.screen) ?? '1920x1080',
    proxy,
  };
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
