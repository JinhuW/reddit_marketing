import { AutoRefresh } from '@/components/browsers/AutoRefresh';
import {
  AddProxies,
  EditProxy,
  PROXY_FORM,
  ProxyBulkBar,
  SelectAllProxies,
} from '@/components/browsers/ProxyPool';
import { proxyRow } from '@/components/browsers/proxy-view';
import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';
import { browsers, members, nodes } from '@threadline/db';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Proxy pool' };

/**
 * The proxy pool (plan 0004 phase 3; the Browsers artboard's "Proxy pool" button). Every proxy of the workspace,
 * with its last check. Checks and change-IP calls run from a browser node, never from the web app.
 */
export default async function ProxyPoolPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireMember();
  const sp = await searchParams;
  const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? '';
  const q = one(sp.q).trim().toLowerCase().slice(0, 100);
  const [list, online] = await Promise.all([
    browsers.listProxies(me.workspaceId),
    nodes.listOnline(me.workspaceId),
  ]);
  const now = new Date();
  const all = list.map((x) => proxyRow(x, now));
  const rows = q
    ? all.filter((r) =>
        `${r.title} ${r.address} ${r.notes} ${r.place} ${r.provider}`.toLowerCase().includes(q),
      )
    : all;
  const canEdit = members.roleAtLeast(me.role, 'editor');
  const editing = canEdit ? all.find((r) => r.id === one(sp.edit)) : undefined;
  const working = all.filter((r) => r.status.chip === 'chip-ok').length;
  const failing = all.filter((r) => r.status.chip === 'chip-bad').length;
  const free = all.filter((r) => r.browsers === 0).length;

  return (
    <>
      <PageHeader
        title="Proxy pool"
        sub="Every proxy of this workspace. A browser uses one proxy; several browsers can share one."
        actions={
          <Link href="/browsers" className="btn">
            Back to browsers
          </Link>
        }
      />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4 text-[13px]">
        {(
          [
            ['Proxies', all.length],
            ['Working at last check', working],
            ['Failed at last check', failing],
            ['Not used by a browser', free],
          ] as const
        ).map(([label, value]) => (
          <div key={label} className="panel flex flex-col gap-1 px-4 py-3.5">
            <span className="muted text-xs">{label}</span>
            <span className="num text-[22px] font-semibold tracking-[-0.02em]">{value}</span>
          </div>
        ))}
      </div>
      <AutoRefresh />
      {one(sp.saved) === '1' ? (
        <output className="m-0 block rounded-[9px] bg-ok-soft px-3 py-2 text-[12.5px] text-ok">
          Proxy saved.
        </output>
      ) : null}
      {online.length === 0 ? (
        <p role="note" className="m-0 rounded-[9px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          No browser node is online. Check and Change IP run from a node, so they wait until one is back.
        </p>
      ) : null}
      {editing ? <EditProxy key={editing.id} row={editing} /> : canEdit ? <AddProxies /> : null}
      <section className="panel min-w-0" aria-labelledby="pool-h">
        <div className="sect-h">
          <h2 id="pool-h">Proxies</h2>
          <span className="muted text-xs">
            Logins and change-IP links are stored encrypted and never shown
          </span>
        </div>
        <form
          method="get"
          action="/browsers/proxies"
          className="flex flex-wrap items-center gap-2 border-b border-line-soft px-[18px] py-3"
        >
          <label className="sr-only" htmlFor="pool-q">
            Search proxies
          </label>
          <input
            id="pool-q"
            name="q"
            type="search"
            className="field !h-[30px] min-w-[180px] max-w-[280px] flex-1"
            placeholder="Search name, host, notes, place"
            defaultValue={q}
          />
          <button type="submit" className="btn !h-[30px]">
            Search
          </button>
          {q ? (
            <Link href="/browsers/proxies" className="btn btn-ghost !h-[30px]">
              Clear
            </Link>
          ) : null}
          <span className="muted num text-xs" data-testid="pool-total">
            {rows.length} {rows.length === 1 ? 'proxy' : 'proxies'}
          </span>
        </form>
        {canEdit ? <ProxyBulkBar isAdmin={me.role === 'admin'} /> : null}
        {rows.length === 0 ? (
          <p className="muted m-0 px-[18px] py-6 text-[13px]">
            {q ? 'No proxy matches this search.' : 'No proxies yet. Add one above, or paste a list.'}
          </p>
        ) : (
          <div className="overflow-x-auto px-2 py-1">
            <table className="tbl [&_td]:whitespace-nowrap" data-testid="proxy-table">
              <thead>
                <tr>
                  <th className="w-[28px]">{canEdit ? <SelectAllProxies /> : null}</th>
                  <th>Proxy</th>
                  <th>Type</th>
                  <th>Login</th>
                  <th>Exit IP</th>
                  <th>Location</th>
                  <th>Latency</th>
                  <th>Status</th>
                  <th>Last check</th>
                  <th>Browsers</th>
                  <th>Notes</th>
                  <th>
                    <span className="sr-only">Action</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.id} data-proxy={r.address} className="row-hover">
                    <td>
                      {canEdit ? (
                        <input
                          type="checkbox"
                          name="ids"
                          value={r.id}
                          form={PROXY_FORM}
                          aria-label={`Select ${r.title}`}
                          className="m-0 h-[15px] w-[15px] accent-[var(--ink)]"
                        />
                      ) : null}
                    </td>
                    <td>
                      <div className="leading-tight">
                        <div className="font-semibold">{r.title}</div>
                        <div className="muted num text-[11.5px]">{r.address}</div>
                      </div>
                    </td>
                    <td>{r.type}</td>
                    <td>
                      <span className={`chip ${r.hasLogin ? 'chip-ok' : 'chip-mid'}`}>
                        {r.hasLogin ? 'Saved' : 'None'}
                      </span>
                      {r.hasRefreshUrl ? <span className="chip chip-line ml-1">Change-IP link</span> : null}
                    </td>
                    <td className="num">{r.ip}</td>
                    <td>{r.place}</td>
                    <td className="num">{r.latency}</td>
                    <td>
                      <span className={`chip ${r.status.chip}`}>{r.status.label}</span>
                    </td>
                    <td className="muted">{r.checked}</td>
                    <td className="num">{r.browsers}</td>
                    <td className="max-w-[220px] truncate" title={r.notes || undefined}>
                      {r.notes || <span className="muted">—</span>}
                    </td>
                    <td className="text-right">
                      {canEdit ? (
                        <Link
                          href={`/browsers/proxies?edit=${r.id}`}
                          className="btn btn-ghost !h-[26px] !px-2"
                        >
                          Edit
                        </Link>
                      ) : null}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </>
  );
}
