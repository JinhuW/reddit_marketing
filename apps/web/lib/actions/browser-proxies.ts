'use server';

// Plan 0004 phase 3: actions of the proxy pool page (/browsers/proxies). Editors manage the pool; taking a proxy
// away from browsers that use it is an admin's call. Logins and change-IP links are encrypted here and never
// sent back to the page.
import type { ActionState } from '@/components/browsers/action-state';
import { enqueueProxyJob } from '@/lib/browser-jobs';
import { ForbiddenError, requireRole } from '@/lib/session';
import { browsers } from '@threadline/db';
import { parseProxyLines } from '@threadline/shared';
import { encrypt } from '@threadline/shared/crypto';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

const str = (form: FormData, k: string) => String(form.get(k) ?? '').trim();
const n = (count: number, one = 'proxy', many = 'proxies') => `${count} ${count === 1 ? one : many}`;
const say = (e: unknown): string | null =>
  e instanceof ForbiddenError || e instanceof browsers.BrowserManageError ? e.message : null;

async function guarded(fn: () => Promise<ActionState>): Promise<ActionState> {
  try {
    return await fn();
  } catch (e) {
    const m = say(e);
    if (m) return { ok: false, message: m };
    throw e;
  }
}

const Host = z
  .string()
  .trim()
  .min(1, 'Enter the proxy host.')
  .max(253)
  .regex(
    /^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$|^[0-9A-Fa-f:]+$/,
    'Host must be a hostname or an IP address.',
  );
const Port = z.coerce
  .number()
  .int()
  .min(1, 'Port must be 1 to 65535.')
  .max(65535, 'Port must be 1 to 65535.');
/** A change-IP link: http(s) only. Whether it may be called is decided on the node (public addresses only). */
function refreshUrl(raw: string): string | null {
  if (!raw) return null;
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    throw new browsers.BrowserManageError('The change-IP link is not a web address.');
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:')
    throw new browsers.BrowserManageError('The change-IP link must start with http:// or https://.');
  return u.toString();
}

/** "Add a proxy": one proxy, typed in. */
export async function addProxyAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const me = await requireRole('editor');
    const parsed = z
      .object({ protocol: z.enum(['http', 'https', 'socks5']), host: Host, port: Port })
      .safeParse({ protocol: str(form, 'protocol'), host: str(form, 'host'), port: str(form, 'port') });
    if (!parsed.success)
      return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the fields.' };
    const username = str(form, 'username') || null;
    const password = String(form.get('password') ?? '') || null;
    const link = refreshUrl(str(form, 'refreshUrl'));
    const r = await browsers.addProxies(me.workspaceId, me.id, [
      {
        ...parsed.data,
        username,
        usernameEnc: username ? encrypt(username) : null,
        passwordEnc: password ? encrypt(password) : null,
        label: str(form, 'label'),
        notes: str(form, 'notes'),
        provider: str(form, 'provider'),
        region: str(form, 'region'),
        sticky: str(form, 'sticky') !== 'rotate',
        refreshUrlEnc: link ? encrypt(link) : null,
      },
    ]);
    revalidatePath('/browsers/proxies');
    return r.added
      ? { ok: true, message: 'Proxy added. Tick it and press Check to test it.' }
      : { ok: false, message: 'That proxy (same host, port and username) is already in the pool.' };
  });
}

/** "Bulk add": a pasted list, one proxy per line. */
export async function bulkAddProxiesAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const me = await requireRole('editor');
    const picked = str(form, 'protocol');
    const fallback = picked === 'socks5' || picked === 'https' ? picked : 'http';
    const { proxies, errors } = parseProxyLines(String(form.get('lines') ?? ''), fallback);
    // The parser reports line numbers and reasons only, so nothing pasted is echoed back.
    const bad = errors.length
      ? ` Not read: ${errors
          .slice(0, 5)
          .map((e) => `line ${e.line} (${e.reason})`)
          .join('; ')}${errors.length > 5 ? `; and ${errors.length - 5} more` : ''}.`
      : '';
    if (proxies.length === 0)
      return { ok: false, message: errors.length ? `Nothing added.${bad}` : 'Paste at least one proxy.' };
    let items: browsers.NewProxy[];
    try {
      items = proxies.map((p) => {
        const link = refreshUrl(p.refreshUrl ?? '');
        return {
          protocol: p.protocol,
          host: p.host,
          port: p.port,
          username: p.username,
          usernameEnc: p.username ? encrypt(p.username) : null,
          passwordEnc: p.password ? encrypt(p.password) : null,
          notes: p.note,
          refreshUrlEnc: link ? encrypt(link) : null,
        };
      });
    } catch (e) {
      const m = say(e);
      if (m) return { ok: false, message: m };
      throw e;
    }
    const r = await browsers.addProxies(me.workspaceId, me.id, items);
    revalidatePath('/browsers/proxies');
    const skipped = r.skipped ? ` ${n(r.skipped)} already in the pool.` : '';
    return { ok: r.added > 0 || errors.length === 0, message: `Added ${n(r.added)}.${skipped}${bad}` };
  });
}

/** The edit panel: fields left empty keep what is stored. */
export async function updateProxyAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  const r = await guarded(async () => {
    const me = await requireRole('editor');
    const parsed = z
      .object({ protocol: z.enum(['http', 'https', 'socks5']), host: Host, port: Port })
      .safeParse({ protocol: str(form, 'protocol'), host: str(form, 'host'), port: str(form, 'port') });
    if (!parsed.success)
      return { ok: false, message: parsed.error.issues[0]?.message ?? 'Check the fields.' };
    const username = str(form, 'username');
    const password = String(form.get('password') ?? '');
    const clearLogin = form.get('clearLogin') === 'on';
    const link = refreshUrl(str(form, 'refreshUrl'));
    const res = await browsers.updateProxy(me.workspaceId, str(form, 'id'), me.id, {
      ...parsed.data,
      label: str(form, 'label'),
      notes: str(form, 'notes'),
      provider: str(form, 'provider') || undefined,
      region: str(form, 'region'),
      sticky: str(form, 'sticky') !== 'rotate',
      usernameEnc: clearLogin ? null : username ? encrypt(username) : undefined,
      passwordEnc: clearLogin ? null : password ? encrypt(password) : undefined,
      refreshUrlEnc: form.get('clearRefresh') === 'on' ? null : link ? encrypt(link) : undefined,
    });
    revalidatePath('/browsers/proxies');
    revalidatePath('/browsers');
    return { ok: true, message: res.changed.length ? 'Proxy saved.' : 'Nothing to change.' };
  });
  if (r.ok) redirect('/browsers/proxies?saved=1');
  return r;
}

/** The pool's bulk bar: Check, Change IP, Delete on every ticked proxy. */
export async function proxyBulkAction(_prev: ActionState | null, form: FormData): Promise<ActionState> {
  return guarded(async () => {
    const op = str(form, 'op');
    const ids = [...new Set(form.getAll('ids').map(String).filter(Boolean))];
    if (ids.length === 0) return { ok: false, message: 'Tick at least one proxy first.' };
    if (ids.length > browsers.BULK_MAX)
      return { ok: false, message: `Pick at most ${browsers.BULK_MAX} proxies at a time.` };
    // Taking a proxy away from browsers that use it changes those browsers: admins only.
    const me = await requireRole(op === 'delete_detach' ? 'admin' : 'editor');
    const mine = new Map((await browsers.listProxies(me.workspaceId)).map((x) => [x.id, x]));
    const own = ids.filter((id) => mine.has(id));
    if (own.length === 0) return { ok: false, message: 'Proxy not found.' };

    if (op === 'delete' || op === 'delete_detach') {
      const r = await browsers.deleteProxies(me.workspaceId, me.id, own, { detach: op === 'delete_detach' });
      revalidatePath('/browsers/proxies');
      revalidatePath('/browsers');
      const kept = r.inUse
        ? ` ${n(r.inUse)} still used by browsers ${r.inUse === 1 ? 'was' : 'were'} kept.`
        : '';
      const freed = r.detached ? ` ${n(r.detached, 'browser', 'browsers')} now have no proxy.` : '';
      return { ok: r.deleted > 0, message: `Deleted ${n(r.deleted)}.${kept}${freed}` };
    }
    if (op === 'check' || op === 'rotate') {
      let queued = 0;
      const skipped: string[] = [];
      for (const id of own) {
        const x = mine.get(id);
        if (op === 'rotate' && !x?.hasRefreshUrl) {
          skipped.push('no change-IP link');
          continue;
        }
        if (op === 'check' && (!x?.host || x.protocol === 'none')) {
          skipped.push('no host to check');
          continue;
        }
        const r = await enqueueProxyJob(me.workspaceId, id, op === 'check' ? 'proxy.check' : 'proxy.rotate');
        if (r.queued) queued++;
        else skipped.push(r.reason);
      }
      revalidatePath('/browsers/proxies');
      const why = skipped.length
        ? ` ${skipped.length} skipped: ${[...new Set(skipped)].slice(0, 2).join('; ')}.`
        : '';
      if (queued === 0) return { ok: false, message: `Nothing started.${why}` };
      return {
        ok: true,
        message:
          op === 'check'
            ? `Checking ${n(queued)}. Results show here in a few seconds.${why}`
            : `Asked ${n(queued)} for a new IP. Check ${queued === 1 ? 'it' : 'them'} in a minute.${why}`,
      };
    }
    return { ok: false, message: 'Unknown action.' };
  });
}
