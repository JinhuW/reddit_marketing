// Plan 0004 phase 1: the Browsers list keeps its state in the URL, so a filtered view can be linked and survives
// the 10 s refresh. Pure functions; no React, no database.

/** Operations of the bulk bar (lib/actions/browser-list.ts `bulkAction`). */
export const BULK_OPS = [
  'start',
  'stop',
  'group',
  'tag_add',
  'tag_remove',
  'proxy',
  'clone',
  'trash',
  'restore',
  'purge',
] as const;
export type BulkOp = (typeof BULK_OPS)[number];

export const SORTS = ['serial', 'name', 'status', 'lastSession', 'group'] as const;
export type Sort = (typeof SORTS)[number];

export interface ListParams {
  q: string;
  group: string;
  tag: string;
  status: string;
  sort: Sort;
  dir: 'asc' | 'desc';
  page: number;
  /** the trash instead of the live list */
  trash: boolean;
  /** the browser open in the drawer */
  id: string;
  /** the groups and tags panel is open */
  manage: boolean;
}

type Raw = Record<string, string | string[] | undefined>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? (v[0] ?? '') : (v ?? '')).trim();

export function parseListParams(sp: Raw): ListParams {
  const sort = one(sp.sort);
  const page = Number.parseInt(one(sp.page), 10);
  return {
    q: one(sp.q).slice(0, 100),
    group: one(sp.group),
    tag: one(sp.tag),
    status: one(sp.status),
    sort: (SORTS as readonly string[]).includes(sort) ? (sort as Sort) : 'serial',
    dir: one(sp.dir) === 'desc' ? 'desc' : 'asc',
    page: Number.isFinite(page) && page > 0 ? page : 1,
    trash: one(sp.view) === 'trash',
    id: one(sp.id),
    manage: one(sp.manage) === '1',
  };
}

/** `/browsers?…` for the current view with `patch` applied. Defaults are left out, so plain views stay short. */
export function listHref(p: ListParams, patch: Partial<ListParams> = {}): string {
  const n = { ...p, ...patch };
  const out = new URLSearchParams();
  if (n.trash) out.set('view', 'trash');
  if (n.q) out.set('q', n.q);
  if (n.group) out.set('group', n.group);
  if (n.tag) out.set('tag', n.tag);
  if (n.status) out.set('status', n.status);
  if (n.sort !== 'serial') out.set('sort', n.sort);
  if (n.dir !== 'asc') out.set('dir', n.dir);
  if (n.page > 1) out.set('page', String(n.page));
  if (n.manage) out.set('manage', '1');
  if (n.id) out.set('id', n.id);
  const qs = out.toString();
  return qs ? `/browsers?${qs}` : '/browsers';
}

/** Header link of a sortable column: first click ascending, a second click on the same column flips it. */
export function sortHref(p: ListParams, sort: Sort): string {
  const dir = p.sort === sort && p.dir === 'asc' ? 'desc' : 'asc';
  return listHref(p, { sort, dir, page: 1 });
}

export const isFiltered = (p: ListParams) => Boolean(p.q || p.group || p.tag || p.status);

/** Tag color → chip class. Colors are BrowserTagColor (packages/shared/src/enums.ts). */
export const TAG_CHIP: Record<string, string> = {
  gray: 'chip-mid',
  green: 'chip-ok',
  amber: 'chip-warn',
  red: 'chip-bad',
  accent: 'chip-hot',
};
export const tagChip = (color: string) => TAG_CHIP[color] ?? 'chip-mid';
