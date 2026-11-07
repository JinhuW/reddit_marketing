import { FilterBar } from '@/components/opportunities/FilterBar';
import { OpportunityDetail } from '@/components/opportunities/OpportunityDetail';
import { OpportunityList } from '@/components/opportunities/OpportunityList';
import { type SP, parseFilters } from '@/components/opportunities/params';
import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';
import { members, opportunities } from '@threadline/db';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Opportunities' };

export default async function OpportunitiesPage({ searchParams }: { searchParams: Promise<SP> }) {
  const me = await requireMember();
  const f = parseFilters(await searchParams);
  const ws = me.workspaceId;
  const [res, opts, sum] = await Promise.all([
    opportunities.list(ws, f, f.limit),
    opportunities.filterOptions(ws),
    opportunities.summary(ws),
  ]);
  const selectedId = f.id ?? res.items[0]?.id ?? null;
  const detail = selectedId ? await opportunities.get(ws, selectedId) : null;
  const canEdit = members.roleAtLeast(me.role, 'editor');

  return (
    <>
      <PageHeader
        title="Opportunities"
        sub={`${sum.newToday} new today across ${sum.subs} subreddits · ${sum.groups} keyword groups watching · ${res.total} matching`}
      />
      <FilterBar groups={opts.groups} subreddits={opts.subreddits} value={f} />
      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1fr)_420px]">
        <OpportunityList
          items={res.items}
          total={res.total}
          selectedId={selectedId}
          agents={opts.agents}
          canEdit={canEdit}
          limit={f.limit}
        />
        <OpportunityDetail o={detail} canEdit={canEdit} />
      </div>
    </>
  );
}
