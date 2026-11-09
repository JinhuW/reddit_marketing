import { AutoRefresh } from '@/components/browsers/AutoRefresh';
import { ProfileEditor } from '@/components/browsers/ProfileEditor';
import { Dot, ProfileTable } from '@/components/browsers/ProfileTable';
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

export default async function BrowsersPage({ searchParams }: { searchParams: Promise<{ id?: string }> }) {
  const me = await requireMember();
  const sp = await searchParams;
  const [rows, online, proxies] = await Promise.all([
    browsers.listProfiles(me.workspaceId),
    nodes.listOnline(me.workspaceId),
    browsers.listProxies(me.workspaceId),
  ]);
  const nodeIds = [...new Set(rows.map((r) => r.nodeId).filter((v): v is string => Boolean(v)))];
  const nodeById = new Map<string, NodeInfo>();
  for (const n of await Promise.all(nodeIds.map((id) => nodes.getById(id))))
    if (n && n.workspaceId === me.workspaceId) nodeById.set(n.id, n);
  const now = new Date();
  const profiles = rows.map((r) => profileView(r, now, r.nodeId ? (nodeById.get(r.nodeId) ?? null) : null));
  // The editor drawer opens only when a browser is picked (?id=); otherwise the table takes the full width.
  const sel = profiles.find((p) => p.id === sp.id) ?? null;
  const selRow = rows.find((r) => r.id === sel?.id);
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

  return (
    <>
      <PageHeader
        title="Browsers and proxies"
        sub="One dedicated browser profile per connected account. Agents draft and post only inside that profile, so each account always logs in from the same device and place."
        actions={
          canCreate ? (
            <Link href="/browsers/new" className="btn btn-primary">
              New browser
            </Link>
          ) : null
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
      {profiles.length === 0 ? (
        <div className="panel muted p-6 text-[13px]">
          No browser profiles yet. Create one with New browser, or connect a Reddit account.
        </div>
      ) : sel && selRow ? (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.55fr)_420px]">
          <ProfileTable profiles={profiles} selectedId={sel.id} />
          <ProfileEditor
            key={sel.id}
            p={sel}
            canEdit={browsers.canControlProfile(me, selRow)}
            isAdmin={isAdmin}
            nodeOptions={nodeOptions(online, selRow.nodeId ? (nodeById.get(selRow.nodeId) ?? null) : null)}
            savedProxies={savedProxies}
            currentProxyId={selRow.proxyId}
            assignable={assignable}
          />
        </div>
      ) : (
        <ProfileTable profiles={profiles} selectedId={null} />
      )}
    </>
  );
}
