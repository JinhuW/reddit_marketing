'use client';

import Link from 'next/link';
import type { FormEvent } from 'react';
import { type ListParams, isFiltered, listHref } from './list-params';

interface Option {
  id: string;
  name: string;
  profileCount: number;
}

/**
 * Search and filters of the profile list (plan 0004). A plain GET form: the view lives in the URL. Selects apply
 * at once; the search box applies on Enter.
 */
export function ListToolbar({
  params,
  groups,
  tags,
  total,
  trashCount,
}: { params: ListParams; groups: Option[]; tags: Option[]; total: number; trashCount: number }) {
  const apply = (e: FormEvent<HTMLSelectElement>) => e.currentTarget.form?.requestSubmit();
  return (
    <form
      method="get"
      action="/browsers"
      className="flex flex-wrap items-center gap-2 border-b border-line-soft px-[18px] py-3"
      data-testid="list-toolbar"
    >
      {params.trash ? <input type="hidden" name="view" value="trash" /> : null}
      {params.sort !== 'serial' ? <input type="hidden" name="sort" value={params.sort} /> : null}
      {params.dir !== 'asc' ? <input type="hidden" name="dir" value={params.dir} /> : null}
      <label className="sr-only" htmlFor="list-q">
        Search browsers
      </label>
      <input
        id="list-q"
        name="q"
        type="search"
        className="field !h-[30px] min-w-[180px] max-w-[260px] flex-1"
        placeholder="Search name, notes, account, proxy, #number"
        defaultValue={params.q}
      />
      <label className="sr-only" htmlFor="list-group">
        Group
      </label>
      <select
        id="list-group"
        name="group"
        className="field !h-[30px] !w-auto"
        defaultValue={params.group}
        onChange={apply}
      >
        <option value="">All groups</option>
        <option value="none">No group</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name} ({g.profileCount})
          </option>
        ))}
      </select>
      <label className="sr-only" htmlFor="list-tag">
        Tag
      </label>
      <select
        id="list-tag"
        name="tag"
        className="field !h-[30px] !w-auto"
        defaultValue={params.tag}
        onChange={apply}
      >
        <option value="">All tags</option>
        {tags.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name} ({t.profileCount})
          </option>
        ))}
      </select>
      {params.trash ? null : (
        <>
          <label className="sr-only" htmlFor="list-status">
            Status
          </label>
          <select
            id="list-status"
            name="status"
            className="field !h-[30px] !w-auto"
            defaultValue={params.status}
            onChange={apply}
          >
            <option value="">Any status</option>
            <option value="running">Running</option>
            <option value="idle">Idle</option>
            <option value="check">Check</option>
            <option value="error">Error</option>
          </select>
        </>
      )}
      <button type="submit" className="btn !h-[30px]">
        Search
      </button>
      {isFiltered(params) ? (
        <Link
          href={listHref(params, { q: '', group: '', tag: '', status: '', page: 1, id: '' })}
          className="btn btn-ghost !h-[30px]"
        >
          Clear
        </Link>
      ) : null}
      <span className="muted num text-xs" data-testid="list-total">
        {total} {total === 1 ? 'browser' : 'browsers'}
      </span>
      <div className="flex-1" />
      <a
        href={listHref(params, { id: '', manage: false, page: 1 }).replace('/browsers', '/browsers/export')}
        className="btn btn-ghost !h-[30px]"
        download
      >
        Export CSV
      </a>
      <Link
        href={listHref(params, { manage: !params.manage, id: '' })}
        className="btn btn-ghost !h-[30px]"
        aria-expanded={params.manage}
      >
        Groups and tags
      </Link>
      {params.trash ? (
        <Link href="/browsers" className="btn !h-[30px]">
          Back to browsers
        </Link>
      ) : (
        <Link href="/browsers?view=trash" className="btn btn-ghost !h-[30px]" data-testid="trash-link">
          Trash{trashCount ? ` (${trashCount})` : ''}
        </Link>
      )}
    </form>
  );
}
