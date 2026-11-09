// Repository functions for Browsers (9b) and Remote session (9c). See docs/PLAN.md §6, §7.
// Browser-node functions (assignNode … getProfileForDispatch): docs/plans/0001-infra-implementation.md §3.
import { createHash, randomBytes } from 'node:crypto';
import type { Prisma } from '@prisma/client';
import {
  type AccountAuthMode,
  type BrowserCookie,
  CloakGpu,
  CloakPersona,
  type PauseReason,
  type ProxySpec,
  parseCookieJson,
} from '@threadline/shared';
import { decrypt } from '@threadline/shared/crypto';
import { prisma } from '../client';
import { writeAudit } from './audit';
import { pickForProfile } from './nodes';

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
  createdBy: { include: { user: { select: { name: true, email: true } } } },
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

/**
 * Admins and the account's owner may change a profile or take over its browser. A browser with no account
 * (plan 0003): admins and the member who created it.
 */
export function canControlProfile(
  me: { id: string; role: string },
  profile: { account: { ownerMemberId: string } | null; createdByMemberId?: string | null },
): boolean {
  if (me.role === 'admin') return true;
  return profile.account
    ? profile.account.ownerMemberId === me.id
    : profile.createdByMemberId != null && profile.createdByMemberId === me.id;
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

/**
 * Owner's OS (as captured at connect time) → CloakBrowser persona. Always `windows` for now, whatever the owner
 * runs: the profile image ships only Windows-metric fonts, and `CloakGpu` has no Apple vendor, so a `macos`
 * persona showed an Intel WebGL vendor on an Apple renderer and no macOS system fonts (DECISIONS.md, 2026-11-09).
 * Mirroring the owner's OS buys nothing: Reddit never sees the owner's device, only the profile's.
 */
export function personaFromOs(_os: string | undefined): CloakPersona {
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
 * in `fingerprint.cloakSalt`. Persona defaults to `windows` ({@link personaFromOs}), GPU to `intel`.
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
  /** null = a standalone browser with no account (plan 0003): never dispatched for actions */
  accountId: string | null;
  account: null | {
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
    const agent = profile.account?.agents[0] ?? null;
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

// ── standalone browsers and account assignment (docs/plans/0003-standalone-browsers.md) ──

export const DEFAULT_START_URL = 'https://www.reddit.com/';

/** The browser refused a change (account in another browser, someone in control, …). Message is user-facing. */
export class BrowserAssignError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserAssignError';
  }
}

/** `https?://…` with a host, or null for empty. Throws BrowserAssignError otherwise. */
export function normalizeStartUrl(raw: string | null | undefined): string | null {
  const s = raw?.trim();
  if (!s) return null;
  let u: URL;
  try {
    u = new URL(/^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`);
  } catch {
    throw new BrowserAssignError('Start tab must be a web address.');
  }
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new BrowserAssignError('Start tab must be an http(s) address.');
  return u.toString();
}

export interface CreateBrowserInput {
  workspaceId: string;
  actorMemberId: string;
  /** empty = "<creator first name> · Chrome N" */
  name?: string | null;
  /** the creator's device as captured in the form ({ os, screen, tz, locale }); drives the CloakBrowser persona */
  fingerprint?: Prisma.InputJsonValue;
  proxyId?: string | null;
  startUrl?: string | null;
  /** cookie JSON, already validated (parseCookieJson) and encrypted */
  cookiesEnc?: string | null;
}

/** {@link createBrowser} inside `tx`. */
export async function createBrowserTx(
  tx: Db,
  input: CreateBrowserInput,
): Promise<{ profileId: string; name: string; node: { id: string; name: string } | null }> {
  const actor = await tx.workspaceMember.findFirst({
    where: { id: input.actorMemberId, workspaceId: input.workspaceId },
    include: { user: { select: { name: true, email: true } } },
  });
  if (!actor) throw new Error('Member is not in this workspace');
  if (input.proxyId) {
    const px = await tx.proxy.findFirst({ where: { workspaceId: input.workspaceId, id: input.proxyId } });
    if (!px) throw new Error('Proxy not found');
  }
  const startUrl = normalizeStartUrl(input.startUrl);
  let name = input.name?.trim().slice(0, 80);
  if (!name) {
    const first = (actor.user.name ?? actor.user.email.split('@')[0] ?? 'Browser').split(' ')[0];
    const n = await tx.browserProfile.count({
      where: {
        workspaceId: input.workspaceId,
        OR: [{ createdByMemberId: actor.id }, { account: { ownerMemberId: actor.id } }],
      },
    });
    name = `${first} · Chrome${n ? ` ${n + 1}` : ''}`;
  }
  const created = await tx.browserProfile.create({
    data: {
      workspaceId: input.workspaceId,
      createdByMemberId: actor.id,
      name,
      fingerprint: input.fingerprint ?? {},
      startUrl,
      cookiesEnc: input.cookiesEnc ?? null,
    },
    select: { id: true },
  });
  await tx.browserProfile.update({
    where: { id: created.id },
    data: { cookiesVolume: `tl-profile-${created.id}` },
  });
  await writeAudit(
    {
      workspaceId: input.workspaceId,
      actorMemberId: actor.id,
      action: 'profile.created',
      targetType: 'BrowserProfile',
      targetId: created.id,
      meta: { item: `Browser ${name} created`, startUrl, cookiesPending: Boolean(input.cookiesEnc) },
    },
    tx,
  );
  await ensureCloakFingerprintTx(tx, {
    workspaceId: input.workspaceId,
    profileId: created.id,
    actorMemberId: actor.id,
  });
  const node = await pickForProfile(input.workspaceId, tx);
  if (node) await assignNodeTx(tx, input.workspaceId, created.id, node.id, actor.id);
  if (input.proxyId) await attachProxyTx(tx, input.workspaceId, created.id, input.proxyId, actor.id);
  return { profileId: created.id, name, node: node ? { id: node.id, name: node.name } : null };
}

/**
 * A browser with no account: CloakBrowser fingerprint, least-loaded online node with room, optional proxy, start
 * tab and pending cookies. Audit: `profile.created`, `profile.fingerprint_assigned`, and `profile.node_assigned` /
 * `profile.proxy_updated` when set.
 */
export function createBrowser(input: CreateBrowserInput) {
  return prisma.$transaction((tx) => createBrowserTx(tx, input));
}

/** {@link assignAccount} inside `tx`. */
export async function assignAccountTx(
  tx: Db,
  workspaceId: string,
  profileId: string,
  accountId: string,
  actorMemberId: string | null,
): Promise<{ changed: boolean }> {
  const profile = await tx.browserProfile.findFirst({
    where: { workspaceId, id: profileId },
    select: { id: true, name: true, accountId: true },
  });
  if (!profile) throw new Error('Browser not found');
  const account = await tx.redditAccount.findFirst({
    where: { workspaceId, id: accountId },
    select: { id: true, username: true, health: true, browserProfile: { select: { id: true, name: true } } },
  });
  if (!account) throw new Error('Account not found');
  if (profile.accountId === account.id) return { changed: false };
  if (profile.accountId)
    throw new BrowserAssignError(`${profile.name} already has an account. Unassign it first.`);
  if (account.browserProfile)
    throw new BrowserAssignError(
      `u/${account.username} is in ${account.browserProfile.name}. Unassign it there first.`,
    );
  if (account.health === 'blocked')
    throw new BrowserAssignError(`u/${account.username} is disconnected and cannot be assigned.`);
  await assertNoHumanSession(tx, profile.id, profile.name);
  await tx.browserProfile.update({ where: { id: profile.id }, data: { accountId: account.id } });
  await writeAudit(
    {
      workspaceId,
      actorMemberId,
      action: 'profile.account_assigned',
      targetType: 'BrowserProfile',
      targetId: profile.id,
      accountId: account.id,
      meta: { item: `u/${account.username} → ${profile.name}`, username: account.username },
    },
    tx,
  );
  return { changed: true };
}

/**
 * Puts an account in a browser that has none. Refused (BrowserAssignError) when the browser already has an
 * account, the account is in another browser, the account is disconnected, or someone has control of the browser.
 * Writes `profile.account_assigned`.
 */
export function assignAccount(
  workspaceId: string,
  profileId: string,
  accountId: string,
  actorMemberId: string | null = null,
) {
  return prisma.$transaction((tx) => assignAccountTx(tx, workspaceId, profileId, accountId, actorMemberId));
}

/**
 * Takes the account out of the browser; both stay. Refused while someone has control of the browser. The browser's
 * cookie jar still holds the old sign-in: the next account's sign-in is refused until it is signed out over VNC
 * (completeBrowserIdentity). Writes `profile.account_unassigned`.
 */
export async function unassignAccount(
  workspaceId: string,
  profileId: string,
  actorMemberId: string | null = null,
): Promise<{ changed: boolean }> {
  return prisma.$transaction(async (tx) => {
    const profile = await tx.browserProfile.findFirst({
      where: { workspaceId, id: profileId },
      select: { id: true, name: true, accountId: true, account: { select: { username: true } } },
    });
    if (!profile) throw new Error('Browser not found');
    if (!profile.accountId) return { changed: false };
    await assertNoHumanSession(tx, profile.id, profile.name);
    const { count } = await tx.browserProfile.updateMany({
      where: { id: profile.id, accountId: profile.accountId },
      data: { accountId: null },
    });
    if (count === 0) return { changed: false };
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.account_unassigned',
        targetType: 'BrowserProfile',
        targetId: profile.id,
        accountId: profile.accountId,
        meta: {
          item: `u/${profile.account?.username} out of ${profile.name}`,
          username: profile.account?.username,
        },
      },
      tx,
    );
    return { changed: true };
  });
}

async function assertNoHumanSession(tx: Db, profileId: string, name: string) {
  const open = await tx.browserSession.findFirst({
    where: { profileId, endedAt: null, driver: 'human' },
    select: { id: true },
  });
  if (open) throw new BrowserAssignError(`Someone has control of ${name}. Hand it back first.`);
}

/** Accounts of the workspace that are in no browser and not disconnected (the "assign an account" picker). */
export function listAssignableAccounts(workspaceId: string) {
  return prisma.redditAccount.findMany({
    where: { workspaceId, browserProfile: null, health: { not: 'blocked' } },
    orderBy: { createdAt: 'asc' },
    select: {
      id: true,
      username: true,
      authMode: true,
      identifiedAt: true,
      ownerMemberId: true,
      owner: { select: { user: { select: { name: true, email: true } } } },
    },
  });
}

export interface BrowserSettingsUpdate {
  name?: string;
  /** null clears it (back to the default) */
  startUrl?: string | null;
  /** already validated and encrypted; null drops pending cookies; undefined keeps them */
  cookiesEnc?: string | null;
}

/** Name, start tab and pending cookies. Writes `profile.settings_updated` (never with cookie values). */
export async function updateBrowserSettings(
  workspaceId: string,
  profileId: string,
  actorMemberId: string | null,
  data: BrowserSettingsUpdate,
) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.browserProfile.findFirst({
      where: { workspaceId, id: profileId },
      select: { id: true, name: true, accountId: true, startUrl: true, cookiesEnc: true },
    });
    if (!p) throw new Error('Browser not found');
    const name = data.name?.trim().slice(0, 80);
    const fields: Prisma.BrowserProfileUpdateInput = {};
    const changed: string[] = [];
    if (name && name !== p.name) {
      fields.name = name;
      changed.push('name');
    }
    if (data.startUrl !== undefined) {
      const startUrl = normalizeStartUrl(data.startUrl);
      if (startUrl !== p.startUrl) {
        fields.startUrl = startUrl;
        changed.push('startUrl');
      }
    }
    if (data.cookiesEnc !== undefined && data.cookiesEnc !== p.cookiesEnc) {
      fields.cookiesEnc = data.cookiesEnc;
      changed.push(data.cookiesEnc ? 'cookies' : 'cookiesDropped');
    }
    if (!changed.length) return { changed: [] as string[] };
    await tx.browserProfile.update({ where: { id: p.id }, data: fields });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.settings_updated',
        targetType: 'BrowserProfile',
        targetId: p.id,
        accountId: p.accountId,
        meta: { item: `Settings for ${name || p.name}`, changed, startUrl: fields.startUrl ?? p.startUrl },
      },
      tx,
    );
    return { changed };
  });
}

/** Cookies reached the profile's own volume: drop the stored copy. */
export async function markCookiesImported(workspaceId: string, profileId: string, cookiesEnc: string) {
  // Only clear what was sent: cookies pasted while the job ran stay pending.
  await prisma.browserProfile.updateMany({
    where: { workspaceId, id: profileId, cookiesEnc },
    data: { cookiesEnc: null, cookiesImportedAt: new Date() },
  });
}

export interface SignInDispatch {
  profileId: string;
  startUrl: string;
  /** the encrypted cookie JSON that was sent, for {@link markCookiesImported}; null = none pending */
  cookiesEnc: string | null;
  cookies: BrowserCookie[] | null;
  account: {
    id: string;
    username: string;
    authMode: AccountAuthMode;
    identifiedAt: Date | null;
  } | null;
  /** decrypted; null without an account or without a stored password */
  credentials: { username: string; password: string; totpSecret?: string } | null;
}

/**
 * GATEWAY-ONLY, like {@link getProfileForDispatch}: the only function that decrypts account passwords, TOTP
 * secrets and pending cookies. Put the result only in the `profile.signIn` command; never log, queue or persist it.
 * Credentials are sent only for a browser-mode account that has a real username (not `pending-…`).
 */
export async function getSignInForDispatch(
  workspaceId: string,
  profileId: string,
): Promise<SignInDispatch | null> {
  const p = await prisma.browserProfile.findFirst({
    where: { workspaceId, id: profileId },
    select: {
      id: true,
      startUrl: true,
      cookiesEnc: true,
      account: {
        select: {
          id: true,
          username: true,
          authMode: true,
          identifiedAt: true,
          loginPasswordEnc: true,
          totpSecretEnc: true,
        },
      },
    },
  });
  if (!p) return null;
  let cookies: BrowserCookie[] | null = null;
  if (p.cookiesEnc) cookies = parseCookieJson(decrypt(p.cookiesEnc));
  const a = p.account;
  const credentials =
    a && a.authMode === 'browser' && a.loginPasswordEnc && !a.username.startsWith('pending-')
      ? {
          username: a.username,
          password: decrypt(a.loginPasswordEnc),
          ...(a.totpSecretEnc ? { totpSecret: decrypt(a.totpSecretEnc) } : {}),
        }
      : null;
  return {
    profileId: p.id,
    startUrl: p.startUrl ?? DEFAULT_START_URL,
    cookiesEnc: p.cookiesEnc,
    cookies,
    account: a
      ? { id: a.id, username: a.username, authMode: a.authMode, identifiedAt: a.identifiedAt }
      : null,
    credentials,
  };
}
