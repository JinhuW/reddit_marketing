import { AutoRefresh } from '@/components/browsers/AutoRefresh';
import { BulkBar } from '@/components/browsers/BulkBar';
import { GroupsTagsPanel } from '@/components/browsers/GroupsTagsPanel';
import { ListToolbar } from '@/components/browsers/ListToolbar';
import { ProfileEditor } from '@/components/browsers/ProfileEditor';
import { Dot, ProfileTable } from '@/components/browsers/ProfileTable';
import { listHref, parseListParams } from '@/components/browsers/list-params';
import { type NodeInfo, nodeOptions, profileView, savedProxyLabel } from '@/components/browsers/view';
import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';
import { browsers, members, nodes, shell } from '@threadline/db';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Browsers and proxies' };

function Kpi({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="panel flex flex-col gap-1 px-4 py-3.5">
      <span className="muted text-xs">{label}</span>
      <span className="num flex flex-wrap items-center gap-2 text-[22px] font-semibold tracking-[-0.02em]">
        {children}
      </span>
    </div>
  );
}

export default async function BrowsersPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireMember();
  const sp = await searchParams;
  const params = parseListParams(sp);
  // `all` feeds the KPI tiles (every live browser); `found` is the filtered, sorted page the table shows.
  const [all, found, online, proxies, groups, tags, trash] = await Promise.all([
    browsers.listProfiles(me.workspaceId),
    browsers.searchProfiles(me.workspaceId, {
      q: params.q,
      groupId: params.group,
      tagId: params.tag,
      status: params.status,
      sort: params.sort,
      dir: params.dir,
      page: params.page,
      trashed: params.trash,
    }),
    nodes.listOnline(me.workspaceId),
    browsers.listProxies(me.workspaceId),
    browsers.listGroups(me.workspaceId),
    browsers.listTags(me.workspaceId),
    browsers.searchProfiles(me.workspaceId, { trashed: true, pageSize: 1 }),
  ]);
  const nodeIds = [
    ...new Set([...all, ...found.rows].map((r) => r.nodeId).filter((v): v is string => Boolean(v))),
  ];
  const nodeById = new Map<string, NodeInfo>();
  for (const n of await Promise.all(nodeIds.map((id) => nodes.getById(id))))
    if (n && n.workspaceId === me.workspaceId) nodeById.set(n.id, n);
  const now = new Date();
  const view = (r: (typeof all)[number]) =>
    profileView(r, now, r.nodeId ? (nodeById.get(r.nodeId) ?? null) : null);
  const profiles = all.map(view);
  const shown = found.rows.map(view);
  // Rows the viewer may tick: in the trash that takes control (restore, delete); in the live list, managing
  // (which includes members an admin gave access to the browser's group).
  const controllable = new Set(
    found.rows
      .filter((r) => (params.trash ? browsers.canControlProfile(me, r) : browsers.canManageProfile(me, r)))
      .map((r) => r.id),
  );
  // The editor drawer opens only when a live browser is picked (?id=); otherwise the table takes the full width.
  const selRow = params.trash ? undefined : all.find((r) => r.id === params.id);
  const sel = selRow ? view(selRow) : null;
  const isAdmin = me.role === 'admin';
  const savedProxies = proxies.map((x) => ({ id: x.id, label: savedProxyLabel(x) }));
  const running = profiles.filter((p) => p.status.key === 'running');
  const attention = profiles.filter((p) => p.needsAttention);
  const latencies = profiles
    .map((p) => p.test?.latencyMs)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
  const limit = shell.PLAN_LIMITS[me.workspace.plan].accounts;
  const canCreate = members.roleAtLeast(me.role, 'editor');
  // Only for a selected browser with no account: accounts in no browser this member may move (admin: any).
  const assignable =
    selRow && !selRow.accountId && browsers.canControlProfile(me, selRow)
      ? (await browsers.listAssignableAccounts(me.workspaceId))
          .filter((a) => isAdmin || a.ownerMemberId === me.id)
          .map((a) => ({
            id: a.id,
            label: a.username.startsWith('pending-')
              ? `Unfinished sign-in · ${a.owner.user.name ?? a.owner.user.email}`
              : `u/${a.username} · ${a.owner.user.name ?? a.owner.user.email}`,
          }))
      : [];
  const table = (
    <ProfileTable
      profiles={shown}
      selectedId={sel?.id ?? null}
      params={params}
      paging={found}
      controllable={controllable}
      toolbar={
        <ListToolbar
          params={params}
          groups={groups}
          tags={tags}
          total={found.total}
          trashCount={trash.total}
        />
      }
      bulk={
        // Kept while the list is empty too, so the result of the last action ("Restored 1 browser") stays up.
        controllable.size || canCreate ? (
          <BulkBar
            // The live list and the trash are different bars: never carry a result message across.
            key={params.trash ? 'trash' : 'live'}
            trash={params.trash}
            canClone={canCreate}
            groups={groups.map((g) => ({ id: g.id, label: g.name }))}
            tags={tags.map((t) => ({ id: t.id, label: t.name }))}
            proxies={savedProxies}
          />
        ) : null
      }
    />
  );

  return (
    <>
      <PageHeader
        title="Browsers and proxies"
        sub="One dedicated browser profile per connected account. Agents draft and post only inside that profile, so each account always logs in from the same device and place."
        actions={
          <div className="flex items-center gap-2">
            <Link href="/browsers/proxies" className="btn">
              Proxy pool
            </Link>
            <Link href="/browsers/api" className="btn">
              API
            </Link>
            {canCreate ? (
              <Link href="/browsers/new" className="btn btn-primary">
                New browser
              </Link>
            ) : null}
          </div>
        }
      />
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Kpi label="Profiles">
          {profiles.length}{' '}
          <span className="muted text-xs font-normal">
            of {limit} on {me.workspace.plan === 'pro' ? 'Pro' : me.workspace.plan}
          </span>
        </Kpi>
        <Kpi label="Running now">
          {running.length}
          {running.length ? (
            <span className="chip chip-ok">
              <Dot color="var(--ok)" />
              {running.map((p) => p.agent?.name ?? p.name).join(', ')}
            </span>
          ) : null}
        </Kpi>
        <Kpi label="Proxy latency · last tests">
          {median != null ? `${median} ms` : '—'}{' '}
          <span className="muted text-xs font-normal">median across {latencies.length} proxies</span>
        </Kpi>
        <Kpi label="Needs attention">
          {attention.length}
          {attention.map((p) => (
            <span key={p.id} className="chip chip-warn">
              {p.ownerFirst} ·{' '}
              {p.region.mismatch
                ? 'proxy region mismatch'
                : p.paused
                  ? p.paused.label.toLowerCase()
                  : !p.signedIn
                    ? 'waiting for sign-in'
                    : p.status.label.toLowerCase()}
            </span>
          ))}
        </Kpi>
      </div>
      <AutoRefresh />
      {one(sp.trashed) === '1' ? (
        <output className="m-0 block rounded-[9px] bg-ok-soft px-3 py-2 text-[12.5px] text-ok">
          Browser moved to the trash. <Link href="/browsers?view=trash">Open the trash</Link> to restore it.
        </output>
      ) : null}
      {params.manage ? (
        <GroupsTagsPanel
          groups={groups}
          tags={tags}
          canEdit={canCreate}
          // Only admins see and change who has access to a group.
          members={
            isAdmin
              ? (await members.listMembers(me.workspaceId))
                  .filter((m) => m.role !== 'admin' && m.role !== 'viewer')
                  .map((m) => ({ id: m.id, name: m.user.name ?? m.user.email }))
              : null
          }
        />
      ) : null}
      {profiles.length === 0 && !params.trash ? (
        <div className="panel muted p-6 text-[13px]">
          No browser profiles yet. Create one with New browser, or connect a Reddit account.
          {trash.total ? (
            <>
              {' '}
              <Link href="/browsers?view=trash">Trash ({trash.total})</Link>
            </>
          ) : null}
        </div>
      ) : sel && selRow ? (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.55fr)_420px]">
          {table}
          <ProfileEditor
            key={sel.id}
            p={sel}
            canEdit={browsers.canControlProfile(me, selRow)}
            canManage={browsers.canManageProfile(me, selRow)}
            isAdmin={isAdmin}
            nodeOptions={nodeOptions(online, selRow.nodeId ? (nodeById.get(selRow.nodeId) ?? null) : null)}
            savedProxies={savedProxies}
            currentProxyId={selRow.proxyId}
            assignable={assignable}
            groups={groups}
            tags={tags}
            closeHref={listHref(params, { id: '' })}
          />
        </div>
      ) : (
        table
      )}
    </>
  );
}

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);
