// Plan 0004 phase 1: the profile list of the Browsers screen. Search, groups, tags, notes, clone and trash.
// Re-exported from ./browsers, so callers use `browsers.searchProfiles(...)`.
import type { Prisma } from '@prisma/client';
import { BrowserTagColor, CloakGpu } from '@threadline/shared';
import { prisma } from '../client';
import { writeAudit } from './audit';
import { type Fingerprint, PROFILE_INCLUDE, createBrowserTx, ensureCloakFingerprintTx } from './browsers';

/** Days a trashed browser can still be restored. */
export const TRASH_DAYS = 30;
export const PROFILE_PAGE_SIZE = 50;
/** Most browsers one bulk action or one "create N" may touch. */
export const BULK_MAX = 100;

export const PROFILE_SORTS = ['serial', 'name', 'status', 'lastSession', 'group'] as const;
export type ProfileSort = (typeof PROFILE_SORTS)[number];
const STATUSES = ['idle', 'running', 'check', 'error'] as const;

export interface ProfileFilter {
  /** matches name, notes, account username, proxy host, or `#12` / `12` for the list number */
  q?: string;
  /** a group id, or `none` for browsers in no group */
  groupId?: string;
  tagId?: string;
  status?: string;
  nodeId?: string;
  /** true = the trash instead of the live list */
  trashed?: boolean;
  sort?: string;
  dir?: string;
  page?: number;
  pageSize?: number;
}

function profileWhere(workspaceId: string, f: ProfileFilter): Prisma.BrowserProfileWhereInput {
  const and: Prisma.BrowserProfileWhereInput[] = [];
  const q = f.q?.trim().slice(0, 100);
  if (q) {
    const or: Prisma.BrowserProfileWhereInput[] = [
      { name: { contains: q, mode: 'insensitive' } },
      { notes: { contains: q, mode: 'insensitive' } },
      { account: { username: { contains: q.replace(/^u\//i, ''), mode: 'insensitive' } } },
      { proxy: { host: { contains: q, mode: 'insensitive' } } },
    ];
    const n = /^#?(\d{1,9})$/.exec(q);
    if (n) or.push({ serial: Number(n[1]) });
    and.push({ OR: or });
  }
  if (f.groupId === 'none') and.push({ groupId: null });
  else if (f.groupId) and.push({ groupId: f.groupId });
  if (f.tagId) and.push({ tags: { some: { id: f.tagId } } });
  if (f.status && (STATUSES as readonly string[]).includes(f.status))
    and.push({ status: f.status as (typeof STATUSES)[number] });
  if (f.nodeId === 'none') and.push({ nodeId: null });
  else if (f.nodeId) and.push({ nodeId: f.nodeId });
  return {
    workspaceId,
    ...(f.trashed ? { deletedAt: { not: null }, purgedAt: null } : { deletedAt: null }),
    ...(and.length ? { AND: and } : {}),
  };
}

function profileOrder(f: ProfileFilter): Prisma.BrowserProfileOrderByWithRelationInput[] {
  const dir = f.dir === 'desc' ? 'desc' : 'asc';
  if (f.trashed && !f.sort) return [{ deletedAt: 'desc' }];
  switch (f.sort) {
    case 'name':
      return [{ name: dir }, { serial: 'asc' }];
    case 'status':
      return [{ status: dir }, { serial: 'asc' }];
    case 'lastSession':
      return [{ lastSessionAt: { sort: dir, nulls: 'last' } }, { serial: 'asc' }];
    case 'group':
      return [{ group: { name: dir } }, { serial: 'asc' }];
    default:
      return [{ serial: dir }, { createdAt: dir }];
  }
}

/** One page of the live list (or of the trash), filtered and sorted in the database. */
export async function searchProfiles(workspaceId: string, f: ProfileFilter = {}) {
  const pageSize = Math.min(Math.max(1, f.pageSize ?? PROFILE_PAGE_SIZE), 200);
  const where = profileWhere(workspaceId, f);
  const total = await prisma.browserProfile.count({ where });
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const page = Math.min(Math.max(1, Math.floor(f.page ?? 1) || 1), pages);
  const rows = await prisma.browserProfile.findMany({
    where,
    include: PROFILE_INCLUDE,
    orderBy: profileOrder(f),
    skip: (page - 1) * pageSize,
    take: pageSize,
  });
  return { rows, total, page, pages, pageSize };
}

// ── groups ──

export class BrowserManageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'BrowserManageError';
  }
}

const cleanName = (raw: string, what: string, max = 40) => {
  const name = raw.trim().replace(/\s+/g, ' ').slice(0, max);
  if (!name) throw new BrowserManageError(`${what} needs a name.`);
  return name;
};
const isUnique = (e: unknown) => (e as { code?: string })?.code === 'P2002';

/** Groups with the number of live browsers in each, in the team's order. */
export async function listGroups(workspaceId: string) {
  const rows = await prisma.browserGroup.findMany({
    where: { workspaceId },
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
    include: { _count: { select: { profiles: { where: { deletedAt: null } } } } },
  });
  return rows.map((g) => ({ id: g.id, name: g.name, profileCount: g._count.profiles }));
}

export async function createGroup(workspaceId: string, actorMemberId: string, rawName: string) {
  const name = cleanName(rawName, 'A group');
  try {
    return await prisma.$transaction(async (tx) => {
      const g = await tx.browserGroup.create({ data: { workspaceId, name } });
      await writeAudit(
        {
          workspaceId,
          actorMemberId,
          action: 'browser_group.created',
          targetType: 'BrowserGroup',
          targetId: g.id,
          meta: { item: `Group ${name} created` },
        },
        tx,
      );
      return { id: g.id, name };
    });
  } catch (e) {
    if (isUnique(e)) throw new BrowserManageError(`A group named ${name} already exists.`);
    throw e;
  }
}

export async function renameGroup(workspaceId: string, actorMemberId: string, id: string, rawName: string) {
  const name = cleanName(rawName, 'A group');
  try {
    return await prisma.$transaction(async (tx) => {
      const g = await tx.browserGroup.findFirst({ where: { workspaceId, id } });
      if (!g) throw new BrowserManageError('Group not found.');
      if (g.name === name) return { changed: false };
      await tx.browserGroup.update({ where: { id }, data: { name } });
      await writeAudit(
        {
          workspaceId,
          actorMemberId,
          action: 'browser_group.renamed',
          targetType: 'BrowserGroup',
          targetId: id,
          meta: { item: `Group ${g.name} renamed to ${name}`, from: g.name, to: name },
        },
        tx,
      );
      return { changed: true };
    });
  } catch (e) {
    if (isUnique(e)) throw new BrowserManageError(`A group named ${name} already exists.`);
    throw e;
  }
}

/** Deletes the group; its browsers stay and become ungrouped. */
export function deleteGroup(workspaceId: string, actorMemberId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const g = await tx.browserGroup.findFirst({
      where: { workspaceId, id },
      include: { _count: { select: { profiles: true } } },
    });
    if (!g) throw new BrowserManageError('Group not found.');
    await tx.browserGroup.delete({ where: { id } });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'browser_group.deleted',
        targetType: 'BrowserGroup',
        targetId: id,
        meta: { item: `Group ${g.name} deleted`, browsers: g._count.profiles },
      },
      tx,
    );
    return { browsers: g._count.profiles };
  });
}

// ── tags ──

export async function listTags(workspaceId: string) {
  const rows = await prisma.browserTag.findMany({
    where: { workspaceId },
    orderBy: { name: 'asc' },
    include: { _count: { select: { profiles: { where: { deletedAt: null } } } } },
  });
  return rows.map((t) => ({
    id: t.id,
    name: t.name,
    color: t.color as BrowserTagColor,
    profileCount: t._count.profiles,
  }));
}

export async function createTag(workspaceId: string, actorMemberId: string, rawName: string, color = 'gray') {
  const name = cleanName(rawName, 'A tag', 24);
  if (!(BrowserTagColor as readonly string[]).includes(color))
    throw new BrowserManageError('Unknown tag color.');
  try {
    return await prisma.$transaction(async (tx) => {
      const t = await tx.browserTag.create({ data: { workspaceId, name, color } });
      await writeAudit(
        {
          workspaceId,
          actorMemberId,
          action: 'browser_tag.created',
          targetType: 'BrowserTag',
          targetId: t.id,
          meta: { item: `Tag ${name} created` },
        },
        tx,
      );
      return { id: t.id, name, color: color as BrowserTagColor };
    });
  } catch (e) {
    if (isUnique(e)) throw new BrowserManageError(`A tag named ${name} already exists.`);
    throw e;
  }
}

/** Deletes the tag and takes it off every browser. */
export function deleteTag(workspaceId: string, actorMemberId: string, id: string) {
  return prisma.$transaction(async (tx) => {
    const t = await tx.browserTag.findFirst({ where: { workspaceId, id } });
    if (!t) throw new BrowserManageError('Tag not found.');
    await tx.browserTag.delete({ where: { id } });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'browser_tag.deleted',
        targetType: 'BrowserTag',
        targetId: id,
        meta: { item: `Tag ${t.name} deleted` },
      },
      tx,
    );
  });
}

// ── one browser: name, notes, group, tags ──

export interface ProfileMetaPatch {
  name?: string;
  /** empty string clears the notes */
  notes?: string;
  /** null = no group */
  groupId?: string | null;
  /** replaces the tag set */
  tagIds?: string[];
  addTagIds?: string[];
  removeTagIds?: string[];
}

/**
 * Quick edit and the bulk bar: name, notes, group, tags of a live browser. Audit `profile.updated` with the
 * fields that changed. Callers check permission (canControlProfile) first.
 */
export function updateProfileMeta(
  workspaceId: string,
  profileId: string,
  actorMemberId: string,
  patch: ProfileMetaPatch,
): Promise<{ changed: string[] }> {
  return prisma.$transaction(async (tx) => {
    const p = await tx.browserProfile.findFirst({
      where: { workspaceId, id: profileId, deletedAt: null },
      include: { tags: { select: { id: true } } },
    });
    if (!p) throw new BrowserManageError('Browser not found.');
    const data: Prisma.BrowserProfileUpdateInput = {};
    const changed: string[] = [];
    if (patch.name !== undefined) {
      const name = cleanName(patch.name, 'A browser', 80);
      if (name !== p.name) {
        data.name = name;
        changed.push('name');
      }
    }
    if (patch.notes !== undefined) {
      const notes = patch.notes.trim().slice(0, 2000) || null;
      if (notes !== p.notes) {
        data.notes = notes;
        changed.push('notes');
      }
    }
    if (patch.groupId !== undefined && patch.groupId !== p.groupId) {
      if (patch.groupId) {
        const g = await tx.browserGroup.findFirst({ where: { workspaceId, id: patch.groupId } });
        if (!g) throw new BrowserManageError('Group not found.');
        data.group = { connect: { id: g.id } };
      } else data.group = { disconnect: true };
      changed.push('group');
    }
    const have = new Set(p.tags.map((t) => t.id));
    let want: Set<string> | null = null;
    if (patch.tagIds) want = new Set(patch.tagIds);
    if (patch.addTagIds?.length || patch.removeTagIds?.length) {
      want ??= new Set(have);
      for (const id of patch.addTagIds ?? []) want.add(id);
      for (const id of patch.removeTagIds ?? []) want.delete(id);
    }
    if (want && (want.size !== have.size || [...want].some((id) => !have.has(id)))) {
      const ids = [...want];
      const n = await tx.browserTag.count({ where: { workspaceId, id: { in: ids } } });
      if (n !== ids.length) throw new BrowserManageError('Tag not found.');
      data.tags = { set: ids.map((id) => ({ id })) };
      changed.push('tags');
    }
    if (changed.length === 0) return { changed };
    await tx.browserProfile.update({ where: { id: p.id }, data });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.updated',
        targetType: 'BrowserProfile',
        targetId: p.id,
        accountId: p.accountId,
        meta: { item: `Browser ${typeof data.name === 'string' ? data.name : p.name} updated`, changed },
      },
      tx,
    );
    return { changed };
  });
}

// ── clone ──

/**
 * A new browser with the same settings: device (GPU vendor, screen, time zone, language), proxy, start
 * tab, group, tags and notes. It gets its own fingerprint seed and an empty volume; the account, cookies and
 * sign-in are never copied. Audit `profile.cloned` (plus what createBrowser writes).
 */
export function cloneProfile(workspaceId: string, sourceId: string, actorMemberId: string) {
  return prisma.$transaction(async (tx) => {
    const src = await tx.browserProfile.findFirst({
      where: { workspaceId, id: sourceId, deletedAt: null },
      include: { tags: { select: { id: true } } },
    });
    if (!src) throw new BrowserManageError('Browser not found.');
    const { cloakSalt: _salt, capturedAt: _at, ...device } = (src.fingerprint ?? {}) as Fingerprint;
    const created = await createBrowserTx(tx, {
      workspaceId,
      actorMemberId,
      name: `${src.name.slice(0, 73)} (copy)`,
      fingerprint: { ...device, capturedAt: new Date().toISOString() } as Prisma.InputJsonValue,
      proxyId: src.proxyId,
      startUrl: src.startUrl,
      groupId: src.groupId,
      notes: src.notes,
      tagIds: src.tags.map((t) => t.id),
    });
    // Same GPU vendor as the source; the seed (what makes it a different device) stays its own. The persona is
    // not copied: a new browser always gets the one createBrowser assigns (DECISIONS 2026-11-09, `windows`).
    const gpu = CloakGpu.find((v) => v === src.cloakGpu);
    if (gpu) await tx.browserProfile.update({ where: { id: created.profileId }, data: { cloakGpu: gpu } });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.cloned',
        targetType: 'BrowserProfile',
        targetId: created.profileId,
        meta: { item: `Browser ${created.name} cloned from ${src.name}`, sourceId: src.id },
      },
      tx,
    );
    return created;
  });
}

// ── trash ──

/**
 * Moves a browser to the trash. Refused while a person controls it. An agent session is ended. The account
 * stays assigned, so a restore brings everything back, and dispatch refuses a trashed browser, so nothing posts
 * from it meanwhile. The caller queues `profile.stop` before calling this. Audit `profile.trashed`.
 */
export function trashProfile(workspaceId: string, profileId: string, actorMemberId: string) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.browserProfile.findFirst({
      where: { workspaceId, id: profileId, deletedAt: null },
      include: { sessions: { where: { endedAt: null }, select: { id: true, driver: true } } },
    });
    if (!p) throw new BrowserManageError('Browser not found.');
    if (p.sessions.some((s) => s.driver === 'human'))
      throw new BrowserManageError('Someone is controlling this browser. Hand it back first.');
    const now = new Date();
    if (p.sessions.length)
      await tx.browserSession.updateMany({
        where: { id: { in: p.sessions.map((s) => s.id) } },
        data: { endedAt: now },
      });
    await tx.browserProfile.update({
      where: { id: p.id },
      data: { deletedAt: now, deletedByMemberId: actorMemberId, status: 'idle' },
    });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.trashed',
        targetType: 'BrowserProfile',
        targetId: p.id,
        accountId: p.accountId,
        meta: { item: `Browser ${p.name} moved to the trash`, restoreDays: TRASH_DAYS },
      },
      tx,
    );
    return { name: p.name, nodeId: p.nodeId };
  });
}

/** Takes a browser out of the trash, as it was. Audit `profile.restored`. */
export function restoreProfile(workspaceId: string, profileId: string, actorMemberId: string) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.browserProfile.findFirst({
      where: { workspaceId, id: profileId, deletedAt: { not: null }, purgedAt: null },
    });
    if (!p) throw new BrowserManageError('Browser not found in the trash.');
    await tx.browserProfile.update({
      where: { id: p.id },
      data: { deletedAt: null, deletedByMemberId: null },
    });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.restored',
        targetType: 'BrowserProfile',
        targetId: p.id,
        accountId: p.accountId,
        meta: { item: `Browser ${p.name} restored` },
      },
      tx,
    );
    return { name: p.name };
  });
}

/**
 * Marks a trashed browser as gone for good, after its container and volume were removed on the node (or when it
 * never had a node). The row stays as a tombstone, because audit rows point at its sessions and AuditEvent is
 * append-only; it loses its account, proxy, node, pending cookies and tags. Audit `profile.purged`.
 * `actorMemberId` null = the 30-day purge job.
 */
export function purgeProfile(workspaceId: string, profileId: string, actorMemberId: string | null) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.browserProfile.findFirst({
      where: { workspaceId, id: profileId, deletedAt: { not: null }, purgedAt: null },
    });
    if (!p) return { purged: false };
    await tx.browserProfile.update({
      where: { id: p.id },
      data: {
        purgedAt: new Date(),
        account: { disconnect: true },
        proxy: { disconnect: true },
        node: { disconnect: true },
        group: { disconnect: true },
        tags: { set: [] },
        cookiesEnc: null,
        notes: null,
        status: 'idle',
      },
    });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.purged',
        targetType: 'BrowserProfile',
        targetId: p.id,
        accountId: p.accountId,
        meta: { item: `Browser ${p.name} deleted for good` },
      },
      tx,
    );
    return { purged: true };
  });
}

/**
 * After the node deleted a live browser's volume (`profile.remove`, then `reset`): the browser is a new device.
 * It gets a new fingerprint seed and the persona every new browser gets (same GPU vendor), and the cookie-import
 * mark is cleared, since the imported cookies went with the volume. Whoever was signed in is signed out. Audit `profile.data_reset`.
 */
export function resetProfileData(
  workspaceId: string,
  profileId: string,
  actorMemberId: string | null = null,
) {
  return prisma.$transaction(async (tx) => {
    const p = await tx.browserProfile.findFirst({ where: { workspaceId, id: profileId, deletedAt: null } });
    if (!p) return { reset: false };
    const { cloakSalt: _salt, ...fp } = (p.fingerprint ?? {}) as Fingerprint;
    await tx.browserProfile.update({
      where: { id: p.id },
      data: {
        cloakSeed: null,
        fingerprint: fp as Prisma.InputJsonValue,
        cookiesImportedAt: null,
        status: 'idle',
      },
    });
    await ensureCloakFingerprintTx(tx, {
      workspaceId,
      profileId: p.id,
      actorMemberId,
      gpu: CloakGpu.find((v) => v === p.cloakGpu),
    });
    await writeAudit(
      {
        workspaceId,
        actorMemberId,
        action: 'profile.data_reset',
        targetType: 'BrowserProfile',
        targetId: p.id,
        accountId: p.accountId,
        meta: { item: `Browser ${p.name}: data cleared, new fingerprint` },
      },
      tx,
    );
    return { reset: true };
  });
}

/** What a purge needs to know about a trashed browser: whether a node holds a volume for it. */
export async function trashedProfileNode(workspaceId: string, profileId: string) {
  const p = await prisma.browserProfile.findFirst({
    where: { workspaceId, id: profileId, deletedAt: { not: null }, purgedAt: null },
    select: { id: true, name: true, node: { select: { id: true, name: true, status: true } } },
  });
  return p;
}

/** Trashed browsers whose restore window is over, across workspaces (the daily purge job). */
export function listPurgeDue(now = new Date(), take = 200) {
  const cutoff = new Date(now.getTime() - TRASH_DAYS * 24 * 3600 * 1000);
  return prisma.browserProfile.findMany({
    where: { deletedAt: { lt: cutoff }, purgedAt: null },
    select: { id: true, workspaceId: true, node: { select: { name: true, status: true } } },
    orderBy: { deletedAt: 'asc' },
    take,
  });
}
