import { ProfileEditor } from '@/components/browsers/ProfileEditor';
import { Dot, ProfileTable } from '@/components/browsers/ProfileTable';
import { profileView } from '@/components/browsers/view';
import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';
import { browsers, shell } from '@threadline/db';
import type { Metadata } from 'next';

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
  const rows = await browsers.listProfiles(me.workspaceId);
  const profiles = rows.map((r) => profileView(r));
  const sel = profiles.find((p) => p.id === sp.id) ?? profiles[0] ?? null;
  const selRow = rows.find((r) => r.id === sel?.id);
  const running = profiles.filter((p) => p.status.key === 'running');
  const attention = profiles.filter((p) => p.needsAttention);
  const latencies = profiles
    .map((p) => p.test?.latencyMs)
    .filter((v): v is number => v != null)
    .sort((a, b) => a - b);
  const median = latencies.length ? latencies[Math.floor(latencies.length / 2)] : null;
  const limit = shell.PLAN_LIMITS[me.workspace.plan].accounts;

  return (
    <>
      <PageHeader
        title="Browsers and proxies"
        sub="One dedicated browser profile per connected account. Agents draft and post only inside that profile, so each account always logs in from the same device and place."
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
              {p.ownerFirst} · {p.region.mismatch ? 'proxy region mismatch' : p.status.label.toLowerCase()}
            </span>
          ))}
        </Kpi>
      </div>
      {sel && selRow ? (
        <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.55fr)_420px]">
          <ProfileTable profiles={profiles} selectedId={sel.id} />
          <ProfileEditor key={sel.id} p={sel} canEdit={browsers.canControlProfile(me, selRow)} />
        </div>
      ) : (
        <div className="panel muted p-6 text-[13px]">
          No browser profiles yet. A profile is created when a Reddit account is connected.
        </div>
      )}
    </>
  );
}
