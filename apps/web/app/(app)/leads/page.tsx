import { KanbanBoard } from '@/components/leads/KanbanBoard';
import { LeadsTable } from '@/components/leads/LeadsTable';
import { Seg } from '@/components/leads/Seg';
import { money } from '@/components/leads/format';
import { leadsHref, parseLeadParams } from '@/components/leads/params';
import { requireMember } from '@/lib/session';
import { leads } from '@threadline/db';
import { ago, fmtInt } from '@threadline/shared';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Leads' };

export default async function LeadsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireMember();
  const p = parseLeadParams(await searchParams);
  const summary = await leads.pipelineSummary(me.workspaceId);

  const sub = [
    `${fmtInt(summary.count)} people who engaged`,
    `${money(summary.openPipelineCents)} open pipeline`,
    summary.lastSyncedAt ? `synced to HubSpot ${ago(summary.lastSyncedAt)} ago` : 'not synced to HubSpot',
  ].join(' · ');

  const exportHref = leadsHref({ saved: p.saved, sort: p.sort, dir: p.dir }, '/leads/export');

  return (
    <>
      <div className="flex flex-wrap items-end gap-3">
        <div className="min-w-[240px] flex-1">
          <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">Leads</h1>
          <div className="muted mt-1 text-[13px]">{sub}</div>
        </div>
        <Seg
          label="View"
          items={[
            {
              label: 'Kanban',
              href: leadsHref({ ...p, view: 'kanban', sort: undefined, dir: undefined }),
              active: p.view === 'kanban',
            },
            { label: 'Table', href: leadsHref({ ...p, view: 'table' }), active: p.view === 'table' },
          ]}
        />
        <a className="btn" href={exportHref} download>
          Export CSV
        </a>
      </div>

      {p.view === 'kanban' ? (
        <Kanban workspaceId={me.workspaceId} />
      ) : (
        <>
          <Seg
            label="Saved views"
            className="self-start"
            items={(Object.keys(leads.SAVED_VIEWS) as leads.SavedView[]).map((k) => ({
              label: leads.SAVED_VIEWS[k].label,
              href: leadsHref({ ...p, saved: k }),
              active: p.saved === k,
            }))}
          />
          <Table workspaceId={me.workspaceId} memberId={me.id} p={p} total={summary.count} />
        </>
      )}
    </>
  );
}

async function Kanban({ workspaceId }: { workspaceId: string }) {
  const cols = await leads.listByStage(workspaceId);
  const cards = cols.flatMap((c) =>
    c.leads.map((l) => ({
      id: l.id,
      username: l.username,
      sub: l.subreddits[0] ?? null,
      score: l.intentScore,
      lastActivityAt: l.lastActivityAt.toISOString(),
      owner: l.owner?.name ?? null,
      dealValueCents: l.dealValueCents,
      stage: l.stage,
    })),
  );
  return <KanbanBoard stages={cols.map((c) => c.stage)} cards={cards} />;
}

async function Table({
  workspaceId,
  memberId,
  p,
  total,
}: {
  workspaceId: string;
  memberId: string;
  p: ReturnType<typeof parseLeadParams>;
  total: number;
}) {
  const rows = await leads.table(workspaceId, {
    view: p.saved,
    sort: p.sort,
    dir: p.dir,
    meMemberId: memberId,
  });
  return (
    <LeadsTable
      rows={rows}
      sort={p.sort}
      dir={p.dir}
      total={total}
      viewLabel={leads.SAVED_VIEWS[p.saved].label}
      hrefFor={(sort, dir) => leadsHref({ ...p, sort, dir })}
    />
  );
}
