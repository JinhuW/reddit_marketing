import { leads } from '@threadline/db';

type SP = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (typeof v === 'string' ? v : undefined);

export function parseLeadParams(sp: SP) {
  const view: 'kanban' | 'table' = one(sp.view) === 'table' ? 'table' : 'kanban';
  const v = one(sp.v);
  const saved = (v && v in leads.SAVED_VIEWS ? v : 'all') as leads.SavedView;
  const s = one(sp.sort);
  const sort = (
    (leads.SORT_KEYS as readonly string[]).includes(s ?? '') ? s : 'lastActivityAt'
  ) as leads.SortKey;
  const dir: 'asc' | 'desc' =
    one(sp.dir) === 'asc'
      ? 'asc'
      : one(sp.dir) === 'desc'
        ? 'desc'
        : sort === 'lastActivityAt' || sort === 'intentScore'
          ? 'desc'
          : 'asc';
  return { view, saved, sort, dir };
}

export function leadsHref(p: Partial<ReturnType<typeof parseLeadParams>>, base = '/leads') {
  const q = new URLSearchParams();
  if (p.view && p.view !== 'kanban') q.set('view', p.view);
  if (p.saved && p.saved !== 'all') q.set('v', p.saved);
  if (p.sort) q.set('sort', p.sort);
  if (p.dir) q.set('dir', p.dir);
  const s = q.toString();
  return s ? `${base}?${s}` : base;
}
