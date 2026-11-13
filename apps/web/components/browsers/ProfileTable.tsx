import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import Link from 'next/link';
import { BULK_FORM, SelectAll } from './BulkBar';
import { ColumnChooser } from './ColumnChooser';
import { NotesCell } from './NotesCell';
import { ProfileRow } from './ProfileRow';
import { RowPower } from './RowPower';
import { type ListParams, type Sort, listHref, sortHref, tagChip } from './list-params';
import type { ProfileView } from './view';

export function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
      style={{ background: color }}
    />
  );
}

export interface Paging {
  total: number;
  page: number;
  pages: number;
  pageSize: number;
}

function SortTh({
  params,
  sort,
  children,
  col,
}: { params: ListParams; sort: Sort; children: string; col?: string }) {
  const active = params.sort === sort;
  return (
    <th data-col={col} aria-sort={active ? (params.dir === 'asc' ? 'ascending' : 'descending') : undefined}>
      <Link href={sortHref(params, sort)} className={active ? 'text-ink' : undefined}>
        {children}
        {active ? <span aria-hidden="true">{params.dir === 'asc' ? ' ↑' : ' ↓'}</span> : null}
      </Link>
    </th>
  );
}

function Pager({ params, paging }: { params: ListParams; paging: Paging }) {
  if (paging.pages <= 1) return null;
  const from = (paging.page - 1) * paging.pageSize + 1;
  const to = Math.min(paging.total, paging.page * paging.pageSize);
  return (
    <nav
      className="flex items-center gap-2 border-t border-line-soft px-[18px] py-2.5 text-xs"
      aria-label="Pages"
    >
      <span className="muted num">
        {from}–{to} of {paging.total}
      </span>
      <div className="flex-1" />
      {paging.page > 1 ? (
        <Link href={listHref(params, { page: paging.page - 1, id: '' })} className="btn !h-[26px] !px-2">
          Previous
        </Link>
      ) : null}
      {paging.page < paging.pages ? (
        <Link href={listHref(params, { page: paging.page + 1, id: '' })} className="btn !h-[26px] !px-2">
          Next
        </Link>
      ) : null}
    </nav>
  );
}

/**
 * The profile list (9b). Plan 0004 adds what the artboard does not show yet: the checkbox, #, Group, Tags and
 * Notes columns, sortable headers, per-row Start / Stop and paging. `toolbar` and `bulk` are rendered between
 * the heading and the table.
 */
export function ProfileTable({
  profiles,
  selectedId,
  params,
  paging,
  controllable,
  toolbar,
  bulk,
}: {
  profiles: ProfileView[];
  selectedId: string | null;
  params: ListParams;
  paging: Paging;
  /** ids the viewer may change (admin, account owner or creator) */
  controllable: Set<string>;
  toolbar?: React.ReactNode;
  bulk?: React.ReactNode;
}) {
  const open = (id: string) => listHref(params, { id });
  return (
    <section className="panel min-w-0" aria-labelledby="profiles-h">
      <div className="sect-h">
        <h2 id="profiles-h">{params.trash ? 'Trash' : 'Browser profiles'}</h2>
        <span className="muted text-xs">
          {params.trash
            ? 'Deleted browsers can be restored for 30 days; then their data is removed for good'
            : 'Each profile holds at most one account; each account has one agent'}
        </span>
        <div className="flex-1" />
        {params.trash ? null : <ColumnChooser />}
      </div>
      {toolbar}
      {bulk}
      {profiles.length === 0 ? (
        <p className="muted m-0 px-[18px] py-6 text-[13px]" data-testid="list-empty">
          {params.trash ? 'The trash is empty.' : 'No browser matches this search.'}
        </p>
      ) : (
        <div className="overflow-x-auto px-2 py-1">
          <table className="tbl [&_td]:whitespace-nowrap" data-testid="profile-table">
            <thead>
              <tr>
                <th className="w-[28px]">
                  <SelectAll />
                </th>
                <SortTh params={params} sort="serial">
                  #
                </SortTh>
                <SortTh params={params} sort="name">
                  Profile
                </SortTh>
                <SortTh params={params} sort="group" col="group">
                  Group
                </SortTh>
                <th data-col="tags">Tags</th>
                <th data-col="notes">Notes</th>
                <th data-col="account">Account · owner</th>
                {params.trash ? (
                  <th>Deleted</th>
                ) : (
                  <>
                    <th data-col="agent">Agent</th>
                    <th data-col="proxy">Proxy</th>
                    <th data-col="region">Region</th>
                    <SortTh params={params} sort="status">
                      Status
                    </SortTh>
                    <th data-col="node">Node</th>
                    <SortTh params={params} sort="lastSession" col="last">
                      Last session
                    </SortTh>
                  </>
                )}
                <th>
                  <span className="sr-only">Action</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {profiles.map((p) => {
                const mine = controllable.has(p.id);
                const lead = (
                  <>
                    <td>
                      <input
                        type="checkbox"
                        name="ids"
                        value={p.id}
                        form={BULK_FORM}
                        disabled={!mine}
                        aria-label={`Select ${p.name}`}
                        className="m-0 h-[15px] w-[15px] accent-[var(--ink)]"
                      />
                    </td>
                    <td className="muted num">#{p.serial}</td>
                  </>
                );
                const meta = (
                  <>
                    <td data-col="group">{p.group ? p.group.name : <span className="muted">—</span>}</td>
                    <td data-col="tags">
                      {p.tags.length ? (
                        <span className="flex flex-wrap gap-1">
                          {p.tags.map((t) => (
                            <span key={t.id} className={`chip ${tagChip(t.color)}`}>
                              {t.name}
                            </span>
                          ))}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                  </>
                );
                const account = (
                  <td data-col="account">
                    <div className="leading-tight">
                      <div className="font-medium">{p.account}</div>
                      <div className="muted text-[11.5px]">{p.owner}</div>
                    </div>
                  </td>
                );
                if (params.trash)
                  return (
                    <tr key={p.id} data-profile={p.name}>
                      {lead}
                      <td>
                        <span className="block font-semibold">{p.name}</span>
                        <span className="muted block text-[11.5px]">{p.device}</span>
                      </td>
                      {meta}
                      <td data-col="notes" className="max-w-[220px] truncate">
                        {p.notes || <span className="muted">—</span>}
                      </td>
                      {account}
                      <td className="muted">
                        {p.trash?.ago} · {p.trash?.daysLeft} {p.trash?.daysLeft === 1 ? 'day' : 'days'} left
                      </td>
                      <td />
                    </tr>
                  );
                return (
                  <ProfileRow key={p.id} href={open(p.id)} selected={p.id === selectedId} name={p.name}>
                    {lead}
                    <td>
                      <Link
                        href={open(p.id)}
                        className="flex items-center gap-2"
                        aria-current={p.id === selectedId ? 'true' : undefined}
                      >
                        <span className="grid h-[26px] w-[26px] place-items-center rounded-lg bg-surface-3 text-ink-2">
                          <Icon name="browser" size={14} />
                        </span>
                        <span className="leading-tight">
                          <span className="block font-semibold">{p.name}</span>
                          <span className="muted block text-[11.5px]">{p.device}</span>
                        </span>
                      </Link>
                    </td>
                    {meta}
                    <td data-col="notes">
                      <NotesCell id={p.id} notes={p.notes} canEdit={mine} />
                    </td>
                    {account}
                    <td data-col="agent">
                      {p.agent ? (
                        <span className="inline-flex items-center gap-1.5">
                          <Avatar
                            name={p.agent.name}
                            color={p.agent.color}
                            label={p.agent.name[0]}
                            size={20}
                          />
                          {p.agent.name}
                        </span>
                      ) : (
                        <span className="muted">—</span>
                      )}
                    </td>
                    <td data-col="proxy">
                      <div className="leading-tight">
                        <div className="font-medium">{p.proxyLabel}</div>
                        <div className="muted text-[11.5px]">{p.proxyType}</div>
                      </div>
                    </td>
                    <td data-col="region">
                      <span
                        className={`chip ${p.region.mismatch ? 'chip-warn' : 'chip-ok'}`}
                        title={p.region.reason ?? 'Matches the owner'}
                      >
                        {p.region.label}
                        {p.region.mismatch ? <span className="sr-only"> · region mismatch</span> : null}
                      </span>
                    </td>
                    <td>
                      <div className="flex flex-col items-start gap-1">
                        <span className={`chip ${p.status.chip}`}>
                          <Dot color={p.status.dot} />
                          {p.status.label}
                        </span>
                        {p.paused ? (
                          <span className="chip chip-warn" data-testid="pause-reason">
                            Paused · {p.paused.label}
                          </span>
                        ) : null}
                      </div>
                    </td>
                    <td data-testid="node-cell" data-col="node">
                      <div className="leading-tight">
                        <div className="font-medium">{p.node.name}</div>
                        <div className={`text-[11.5px] ${p.node.online ? 'text-ok' : 'text-muted'}`}>
                          {p.node.label}
                        </div>
                      </div>
                    </td>
                    <td className="muted whitespace-nowrap" data-col="last">
                      {p.lastSession}
                    </td>
                    <td className="text-right">
                      <span className="inline-flex items-center gap-1">
                        {mine ? <RowPower id={p.id} running={p.status.key === 'running'} /> : null}
                        <Link href={open(p.id)} className="btn btn-ghost !h-[26px] !px-2">
                          {p.action}
                        </Link>
                      </span>
                    </td>
                  </ProfileRow>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <Pager params={params} paging={paging} />
      {params.trash ? null : (
        <div className="muted flex flex-wrap gap-4 border-t border-line-soft px-[18px] py-3 text-xs">
          <span>
            <Dot color="var(--ok)" />
            Running — the browser is open on its node
          </span>
          <span>
            <Dot color="var(--faint)" />
            Idle — session saved, nothing open
          </span>
          <span>
            <Dot color="var(--warn)" />
            Check — a setting no longer matches the account owner
          </span>
        </div>
      )}
    </section>
  );
}
