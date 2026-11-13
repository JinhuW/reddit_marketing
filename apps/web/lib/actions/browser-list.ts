'use server';

// Plan 0004 phase 1: actions behind the profile list of the Browsers screen (bulk bar, groups, tags, notes, trash).
import type { ActionState } from '@/components/browsers/action-state';
import { BULK_OPS, type BulkOp } from '@/components/browsers/list-params';
import { enqueueProfileJob, enqueueRemoveJob } from '@/lib/browser-jobs';
import { ForbiddenError, requireMember, requireRole } from '@/lib/session';
import { browsers } from '@threadline/db';
import { CPU_OPTIONS, FingerprintSettings, MEMORY_OPTIONS } from '@threadline/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';

type Me = Awaited<ReturnType<typeof requireMember>>;

const DONE: Record<BulkOp, (n: number) => string> = {
  start: (n) => `Start queued for ${count(n)}.`,
  stop: (n) => `Stop queued for ${count(n)}.`,
  group: (n) => `Moved ${count(n)}.`,
  tag_add: (n) => `Tagged ${count(n)}.`,
  tag_remove: (n) => `Removed the tag from ${count(n)}.`,
  proxy: (n) => `Proxy set on ${count(n)}.`,
  clone: (n) => `Cloned ${count(n)}.`,
  trash: (n) => `Moved ${count(n)} to the trash. Restore within ${browsers.TRASH_DAYS} days.`,
  restore: (n) => `Restored ${count(n)}.`,
  purge: (n) => `Deleting ${count(n)} for good.`,
};
const count = (n: number) => `${n} browser${n === 1 ? '' : 's'}`;

const str = (form: FormData, k: string) => String(form.get(k) ?? '').trim();
/** Errors a person can act on; anything else is a bug and is thrown. */
const say = (e: unknown): string | null =>
  e instanceof ForbiddenError ||
  e instanceof browsers.BrowserManageError ||
  e instanceof browsers.BrowserAssignError
    ? e.message
    : null;

/** One browser of a bulk action. Returns null when done, or why it was skipped. */
async function applyOne(me: Me, op: BulkOp, id: string, form: FormData): Promise<string | null> {
  const inTrash = op === 'restore' || op === 'purge';
  const p = await browsers.getProfile(me.workspaceId, id, { trashed: inTrash });
  if (!p) return 'not found';
  if (!browsers.canControlProfile(me, p)) return 'not yours to change';
  switch (op) {
    case 'start':
    case 'stop': {
      const r = await enqueueProfileJob(
        me.workspaceId,
        id,
        op === 'start' ? 'profile.start' : 'profile.stop',
      );
      return r.queued ? null : r.reason;
    }
    case 'group':
      await browsers.updateProfileMeta(me.workspaceId, id, me.id, { groupId: str(form, 'groupId') || null });
      return null;
    case 'tag_add':
    case 'tag_remove': {
      const tagId = str(form, 'tagId');
      if (!tagId) return 'no tag picked';
      await browsers.updateProfileMeta(
        me.workspaceId,
        id,
        me.id,
        op === 'tag_add' ? { addTagIds: [tagId] } : { removeTagIds: [tagId] },
      );
      return null;
    }
    case 'proxy': {
      const proxyId = str(form, 'proxyId');
      if (!proxyId) return 'no proxy picked';
      await browsers.attachProxy(me.workspaceId, id, proxyId, me.id);
      return null;
    }
    case 'clone':
      await browsers.cloneProfile(me.workspaceId, id, me.id);
      return null;
    case 'trash':
      // Stop first, while the browser can still be found; a node that is offline just has nothing to stop.
      await enqueueProfileJob(me.workspaceId, id, 'profile.stop');
      await browsers.trashProfile(me.workspaceId, id, me.id);
      return null;
    case 'restore':
      await browsers.restoreProfile(me.workspaceId, id, me.id);
      return null;
    case 'purge': {
      const r = await enqueueRemoveJob(me.workspaceId, id, 'purge');
      if (r.queued) return null;
      // No node ever held data for it: nothing to delete there.
      if ('node' in r && r.node === false) {
        await browsers.purgeProfile(me.workspaceId, id, me.id);
        return null;
      }
      return r.reason;
    }
  }
}

/**
 * The bulk bar: one operation on every ticked browser. Each browser is checked on its own (admin, account
 * owner or creator), so a mixed selection does what it may and names what it skipped.
 */
export async function bulkAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const op = str(form, 'op') as BulkOp;
  if (!BULK_OPS.includes(op)) return { ok: false, message: 'Unknown action.' };
  const ids = [...new Set(form.getAll('ids').map(String).filter(Boolean))];
  if (ids.length === 0) return { ok: false, message: 'Tick at least one browser first.' };
  if (ids.length > browsers.BULK_MAX)
    return { ok: false, message: `Pick at most ${browsers.BULK_MAX} browsers at a time.` };
  let me: Me;
  try {
    // Viewers change nothing; cloning makes a browser, which is an editor's job like New browser.
    me = await requireRole(op === 'clone' ? 'editor' : 'viewer');
  } catch (e) {
    const m = say(e);
    if (m) return { ok: false, message: m };
    throw e;
  }
  let done = 0;
  const skipped: string[] = [];
  for (const id of ids) {
    try {
      const why = await applyOne(me, op, id, form);
      if (why) skipped.push(why);
      else done++;
    } catch (e) {
      const m = say(e) ?? (e instanceof Error && /not found/i.test(e.message) ? e.message : null);
      if (!m) throw e;
      skipped.push(m);
    }
  }
  revalidatePath('/browsers');
  const reasons = [...new Set(skipped)].slice(0, 3).join('; ');
  if (done === 0) return { ok: false, message: `Nothing changed: ${reasons}.` };
  return {
    ok: true,
    message: skipped.length ? `${DONE[op](done)} ${skipped.length} skipped: ${reasons}.` : DONE[op](done),
  };
}

async function controllable(profileId: string) {
  const me = await requireMember();
  const profile = await browsers.getProfile(me.workspaceId, profileId);
  if (!profile) throw new ForbiddenError('Browser not found.');
  if (!browsers.canControlProfile(me, profile))
    throw new ForbiddenError(
      profile.account
        ? 'Only an admin or the account owner can change this browser.'
        : 'Only an admin or the member who created this browser can change it.',
    );
  return { me, profile };
}

async function guarded(fn: () => Promise<ActionState>): Promise<ActionState> {
  try {
    return await fn();
  } catch (e) {
    const m = say(e);
    if (m) return { ok: false, message: m };
    throw e;
  }
}

/** Drawer "Details": group, tags and notes of one browser. */
export async function saveDetailsAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const { me, profile } = await controllable(str(form, 'profileId'));
    const r = await browsers.updateProfileMeta(me.workspaceId, profile.id, me.id, {
      groupId: str(form, 'groupId') || null,
      tagIds: form.getAll('tagIds').map(String).filter(Boolean),
      notes: String(form.get('notes') ?? ''),
    });
    revalidatePath('/browsers');
    return { ok: true, message: r.changed.length ? 'Details saved.' : 'Nothing to change.' };
  });
}

/** Quick edit in the list: the notes of one browser. */
export async function saveNotesAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const { me, profile } = await controllable(str(form, 'profileId'));
    await browsers.updateProfileMeta(me.workspaceId, profile.id, me.id, {
      notes: String(form.get('notes') ?? ''),
    });
    revalidatePath('/browsers');
    return { ok: true, message: 'Saved.' };
  });
}

/** Drawer "Delete profile": to the trash, then back to the list. */
export async function trashProfileAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const r = await guarded(async () => {
    const { me, profile } = await controllable(str(form, 'profileId'));
    await enqueueProfileJob(me.workspaceId, profile.id, 'profile.stop');
    await browsers.trashProfile(me.workspaceId, profile.id, me.id);
    revalidatePath('/browsers');
    return { ok: true, message: 'Moved to the trash.' };
  });
  if (r.ok) redirect('/browsers?trashed=1');
  return r;
}

// ── groups and tags: any editor ──

export async function createGroupAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const me = await requireRole('editor');
    const g = await browsers.createGroup(me.workspaceId, me.id, str(form, 'name'));
    revalidatePath('/browsers');
    return { ok: true, message: `Group ${g.name} created.` };
  });
}

export async function renameGroupAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const me = await requireRole('editor');
    await browsers.renameGroup(me.workspaceId, me.id, str(form, 'id'), str(form, 'name'));
    revalidatePath('/browsers');
    return { ok: true, message: 'Group renamed.' };
  });
}

export async function deleteGroupAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const me = await requireRole('editor');
    const r = await browsers.deleteGroup(me.workspaceId, me.id, str(form, 'id'));
    revalidatePath('/browsers');
    return {
      ok: true,
      message: r.browsers ? `Group deleted. ${count(r.browsers)} now in no group.` : 'Group deleted.',
    };
  });
}

export async function createTagAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const me = await requireRole('editor');
    const t = await browsers.createTag(
      me.workspaceId,
      me.id,
      str(form, 'name'),
      str(form, 'color') || 'gray',
    );
    revalidatePath('/browsers');
    return { ok: true, message: `Tag ${t.name} created.` };
  });
}

export async function deleteTagAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const me = await requireRole('editor');
    await browsers.deleteTag(me.workspaceId, me.id, str(form, 'id'));
    revalidatePath('/browsers');
    return { ok: true, message: 'Tag deleted.' };
  });
}

// ── fingerprint (phase 2) ──

const pick = (raw: string, options: readonly number[]) => {
  const n = Number(raw);
  return raw && options.includes(n) ? n : null;
};

/** Drawer "Fingerprint": screen, time zone, language, CPU, memory, WebRTC and noise. Applies at the next start. */
export async function saveFingerprintAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const { me, profile } = await controllable(str(form, 'profileId'));
    const parsed = FingerprintSettings.safeParse({
      screen: str(form, 'screen').replace(/\s*[×xX]\s*/, 'x'),
      tzMode: str(form, 'tzMode'),
      tz: str(form, 'tz'),
      localeMode: str(form, 'localeMode'),
      locale: str(form, 'locale'),
      cpu: pick(str(form, 'cpu'), CPU_OPTIONS),
      memoryGb: pick(str(form, 'memoryGb'), MEMORY_OPTIONS),
      webrtc: str(form, 'webrtc'),
      noise: form.get('noise') === 'on',
    });
    if (!parsed.success)
      return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the fingerprint fields.' };
    const r = await browsers.updateFingerprint(me.workspaceId, profile.id, me.id, parsed.data);
    revalidatePath('/browsers');
    if (r.changed.length === 0) return { ok: true, message: 'Nothing to change.' };
    return {
      ok: true,
      message:
        profile.status === 'running'
          ? 'Saved. It applies the next time this browser starts: stop and start it.'
          : 'Saved. It applies the next time this browser starts.',
    };
  });
}

/**
 * Drawer "New fingerprint": the browser becomes a new device. Its data (cookies, cache, sign-in) is deleted on
 * the node first, because the volume is locked to the old fingerprint; then it gets a new seed.
 */
export async function newFingerprintAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const { me, profile } = await controllable(str(form, 'profileId'));
    if (form.get('confirm') !== 'on')
      return { ok: false, message: 'Tick the box first: this deletes the browser’s cookies and sign-in.' };
    if (profile.sessions.some((s) => s.driver === 'human'))
      return { ok: false, message: 'Someone is controlling this browser. Hand it back first.' };
    const gpu = str(form, 'gpu');
    if (gpu) await browsers.setNextGpu(me.workspaceId, profile.id, gpu);
    const r = await enqueueRemoveJob(me.workspaceId, profile.id, 'reset');
    revalidatePath('/browsers');
    if (r.queued)
      return {
        ok: true,
        message: 'Clearing the browser’s data. The new fingerprint is ready in a few seconds.',
      };
    if ('node' in r && r.node === false) {
      // Never ran anywhere: there is no data to delete.
      await browsers.resetProfileData(me.workspaceId, profile.id, me.id);
      return { ok: true, message: 'New fingerprint assigned.' };
    }
    return { ok: false, message: r.reason };
  });
}
