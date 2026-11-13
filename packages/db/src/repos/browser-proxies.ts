// Plan 0004 phase 3: the proxy pool of the Browsers screen. Add, bulk add, edit, delete, checks and the change-IP
// link. Re-exported from ./browsers. Credentials and the change-IP link arrive already encrypted and are never
// returned by the list functions.
import type { Prisma } from '@prisma/client';
import type { ProxySpec } from '@threadline/shared';
import { decrypt } from '@threadline/shared/crypto';
import { prisma } from '../client';
import { writeAudit } from './audit';
import { BrowserManageError } from './browser-manage';
import type { ProxyTest } from './browsers';

export interface NewProxy {
  protocol: 'http' | 'socks5';
  host: string;
  port: number;
  /** plain username: compared with what is stored so a re-pasted list adds nothing twice; never stored plain */
  username: string | null;
  usernameEnc: string | null;
  passwordEnc: string | null;
  label?: string | null;
  notes?: string | null;
  refreshUrlEnc?: string | null;
  provider?: string | null;
  region?: string | null;
  sticky?: boolean;
}

const clean = (v: string | null | undefined, max: number) => v?.trim().slice(0, max) || null;

/**
 * Adds proxies to the pool. A proxy already there (same host, port and username) is skipped, so pasting a list
 * twice adds nothing. Vendors hand out many logins on one gateway host:port, so the username is part of what
 * makes a proxy; stored usernames are decrypted here only to compare them. Audit `proxy.created` per proxy.
 */
export function addProxies(
  workspaceId: string,
  actorMemberId: string,
  items: NewProxy[],
): Promise<{ added: number; skipped: number; ids: string[] }> {
  return prisma.$transaction(async (tx) => {
    const hosts = [...new Set(items.map((i) => i.host))];
    const existing = await tx.proxy.findMany({
      where: { workspaceId, host: { in: hosts } },
      select: { host: true, port: true, usernameEnc: true },
    });
    const key = (host: string | null, port: number | null, user: string | null) =>
      `${host ?? ''}:${port ?? ''}:${user ?? ''}`;
    const have = new Set(
      existing.map((e) => key(e.host, e.port, e.usernameEnc ? decrypt(e.usernameEnc) : null)),
    );
    const ids: string[] = [];
    let skipped = 0;
    for (const it of items) {
      const k = key(it.host, it.port, it.username);
      if (have.has(k)) {
        skipped++;
        continue;
      }
      have.add(k);
      const row = await tx.proxy.create({
        data: {
          workspaceId,
          provider: clean(it.provider, 120) ?? 'Own server',
          protocol: it.protocol,
          host: it.host,
          port: it.port,
          usernameEnc: it.usernameEnc,
          passwordEnc: it.passwordEnc,
          sticky: it.sticky ?? true,
          region: clean(it.region, 120),
          label: clean(it.label, 80),
          notes: clean(it.notes, 500),
          refreshUrlEnc: it.refreshUrlEnc ?? null,
        },
        select: { id: true },
      });
      ids.push(row.id);
      await writeAudit(
        {
          workspaceId,
          actorMemberId,
          action: 'proxy.created',
          targetType: 'Proxy',
          targetId: row.id,
          // Host and port only: never the username, password or change-IP link.
          meta: { item: `Proxy ${it.host}:${it.port} added`, protocol: it.protocol },
        },
        tx,
      );
    }
    return { added: ids.length, skipped, ids };
  });
}

export interface ProxyPatch {
  label?: string | null;
  notes?: string | null;
  provider?: string;
  protocol?: 'http' | 'socks5';
  host?: string;
  port?: number;
  region?: string | null;
  sticky?: boolean;
  /** undefined = keep; null = remove; a string = the new encrypted value */
  usernameEnc?: string | null;
  passwordEnc?: string | null;
  refreshUrlEnc?: string | null;
}

/**
 * Edits a pool proxy. Every browser that uses it gets the change at its next start. Changing where the proxy
 * points (protocol, host, port or login) clears the last check: it described another exit. Audit `proxy.updated`
 * with the names of the fields that changed, never their values.
 */
export function updateProxy(
  workspaceId: string,
  proxyId: string,
  actorMemberId: string,
  patch: ProxyPatch,
): Promise<{ changed: string[] }> {
  return prisma.$transaction(async (tx) => {
    const p = await tx.proxy.findFirst({ where: { workspaceId, id: proxyId } });
    if (!p) throw new BrowserManageError('Proxy not found.');
    const data: Prisma.ProxyUpdateInput = {};
    const changed: string[] = [];
    const set = <K extends keyof ProxyPatch>(k: K, next: ProxyPatch[K], cur: unknown) => {
      if (next === undefined || next === cur) return;
      (data as Record<string, unknown>)[k] = next;
      changed.push(k.replace(/Enc$/, ''));
    };
    set('label', patch.label === undefined ? undefined : clean(patch.label, 80), p.label);
    set('notes', patch.notes === undefined ? undefined : clean(patch.notes, 500), p.notes);
    set(
      'provider',
      patch.provider === undefined ? undefined : (clean(patch.provider, 120) ?? p.provider),
      p.provider,
    );
    set('protocol', patch.protocol, p.protocol);
    set('host', patch.host?.trim(), p.host);
    set('port', patch.port, p.port);
    set('region', patch.region === undefined ? undefined : clean(patch.region, 120), p.region);
    set('sticky', patch.sticky, p.sticky);
    set('usernameEnc', patch.usernameEnc, p.usernameEnc);
    set('passwordEnc', patch.passwordEnc, p.passwordEnc);
    set('refreshUrlEnc', patch.refreshUrlEnc, p.refreshUrlEnc);
    if (changed.length === 0) return { changed };
    if (changed.some((c) => ['protocol', 'host', 'port', 'username', 'password'].includes(c))) {
      const prev = (p.lastTest ?? {}) as ProxyTest;
      // Keep only the display hints; the readings belonged to the old exit.
      data.lastTest = {
        ...(prev.kind ? { kind: prev.kind } : {}),
        ...(prev.label ? { label: prev.label } : {}),
      } as Prisma.InputJsonValue;
    }
    await tx.proxy.update({ where: { id: p.id }, data });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'proxy.updated',
        targetType: 'Proxy',
        targetId: p.id,
        meta: { item: `Proxy ${p.host ?? p.provider} changed`, changed },
      },
      tx,
    );
    return { changed };
  });
}

/**
 * Deletes pool proxies. One that browsers still use is skipped unless `detach` is set; then those browsers are
 * left with no proxy (audit `profile.proxy_updated` on each). Audit `proxy.deleted` per proxy.
 */
export function deleteProxies(
  workspaceId: string,
  actorMemberId: string,
  ids: string[],
  opts: { detach?: boolean } = {},
): Promise<{ deleted: number; inUse: number; detached: number }> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.proxy.findMany({
      where: { workspaceId, id: { in: ids } },
      include: { profiles: { select: { id: true, name: true, accountId: true, purgedAt: true } } },
    });
    let deleted = 0;
    let inUse = 0;
    let detached = 0;
    for (const p of rows) {
      const users = p.profiles.filter((b) => b.purgedAt === null);
      if (users.length && !opts.detach) {
        inUse++;
        continue;
      }
      for (const b of users) {
        await writeAudit(
          {
            workspaceId,
            actorMemberId,
            action: 'profile.proxy_updated',
            targetType: 'BrowserProfile',
            targetId: b.id,
            accountId: b.accountId,
            meta: { item: `Proxy removed from ${b.name}`, previousProxyId: p.id, attachedProxyId: null },
          },
          tx,
        );
        detached++;
      }
      await tx.browserProfile.updateMany({ where: { proxyId: p.id }, data: { proxyId: null } });
      await tx.proxy.delete({ where: { id: p.id } });
      await writeAudit(
        {
          workspaceId,
          actorMemberId,
          action: 'proxy.deleted',
          targetType: 'Proxy',
          targetId: p.id,
          meta: { item: `Proxy ${p.host ?? p.provider} deleted`, browsers: users.length },
        },
        tx,
      );
      deleted++;
    }
    return { deleted, inUse, detached };
  });
}

/** Stores a pool check on the proxy itself (`proxy.check`); display hints are kept, readings replaced. */
export async function recordProxyCheck(
  workspaceId: string,
  proxyId: string,
  test: ProxyTest,
): Promise<{ stored: boolean }> {
  const cur = await prisma.proxy.findFirst({
    where: { workspaceId, id: proxyId },
    select: { lastTest: true },
  });
  if (!cur) return { stored: false };
  const prev = (cur.lastTest ?? {}) as ProxyTest;
  await prisma.proxy.update({
    where: { id: proxyId },
    data: {
      lastTest: {
        ...(prev.kind ? { kind: prev.kind } : {}),
        ...(prev.label ? { label: prev.label } : {}),
        ...test,
      } as Prisma.InputJsonValue,
    },
  });
  return { stored: true };
}

/** Audit row for a change-IP link the node called (`proxy.rotate`). */
export function recordProxyRotated(workspaceId: string, proxyId: string, status: number) {
  return writeAudit({
    workspaceId,
    actorMemberId: null,
    action: 'proxy.rotated',
    targetType: 'Proxy',
    targetId: proxyId,
    meta: { item: 'Proxy IP change requested', status },
  });
}

export interface ProxyDispatch {
  id: string;
  /** null when the proxy has no host (protocol `none`) */
  spec: ProxySpec | null;
  /** decrypted change-IP link */
  refreshUrl: string | null;
}

/**
 * GATEWAY-ONLY. A pool proxy with its login and change-IP link decrypted, for `proxy.check` / `proxy.rotate`.
 * Put the result only in the command sent over the authenticated socket; never log, queue or persist it.
 */
export async function getProxyForDispatch(
  workspaceId: string,
  proxyId: string,
): Promise<ProxyDispatch | null> {
  const p = await prisma.proxy.findFirst({ where: { workspaceId, id: proxyId } });
  if (!p) return null;
  const spec: ProxySpec | null =
    p.protocol !== 'none' && p.host && p.port
      ? {
          protocol: p.protocol,
          host: p.host,
          port: p.port,
          ...(p.usernameEnc ? { username: decrypt(p.usernameEnc) } : {}),
          ...(p.passwordEnc ? { password: decrypt(p.passwordEnc) } : {}),
        }
      : null;
  return { id: p.id, spec, refreshUrl: p.refreshUrlEnc ? decrypt(p.refreshUrlEnc) : null };
}

/** A pool proxy no live browser uses, picked at random ("random unused proxy"); null when there is none. */
export async function pickUnusedProxy(workspaceId: string): Promise<{ id: string } | null> {
  const free = await prisma.proxy.findMany({
    where: {
      workspaceId,
      protocol: { not: 'none' },
      host: { not: null },
      profiles: { none: { purgedAt: null } },
    },
    select: { id: true },
  });
  return free.length ? (free[Math.floor(Math.random() * free.length)] ?? null) : null;
}
