import { BreakdownTable } from '@/components/analytics/BreakdownTable';
import { ClicksSignupsChart } from '@/components/analytics/ClicksSignupsChart';
import { IntegrationStrip } from '@/components/analytics/IntegrationStrip';
import { KpiRow } from '@/components/analytics/KpiRow';
import { RevenueFlow } from '@/components/analytics/RevenueFlow';
import { TrackedLinksPanel } from '@/components/analytics/TrackedLinksPanel';
import { PageHeader } from '@/components/ui/page-header';
import { parseRange } from '@/lib/range';
import { requireMember } from '@/lib/session';
import { analytics, members } from '@threadline/db';
import { BREAKDOWNS, type BreakdownBy } from '@threadline/db/repos/analytics';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Analytics' };

const PERIOD: Record<string, string> = { '24h': '24h', '7d': '7d', '30d': '30d', '90d': '90d' };

export default async function AnalyticsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireMember();
  const sp = await searchParams;
  const range = parseRange(sp.range);
  const by = (BREAKDOWNS.some((b) => b.key === sp.by) ? sp.by : 'subreddit') as BreakdownBy;
  const ws = me.workspaceId;
  const now = new Date();

  const [kpis, daily, flow, rows, links, options, integrations] = await Promise.all([
    analytics.kpis(ws, range.since, now),
    analytics.dailyBySubreddit(ws, range.since, now),
    analytics.revenueFlow(ws, range.since, now),
    analytics.breakdown(ws, by, range.since, now),
    analytics.trackedLinks(ws),
    analytics.utmOptions(ws),
    analytics.integrations(ws),
  ]);

  const hrefFor = (b: BreakdownBy) => `/analytics?range=${range.key}&by=${b}`;

  return (
    <>
      <PageHeader
        title="Analytics"
        sub={`Traffic and revenue attributed to Reddit · ${range.label.toLowerCase()}`}
        actions={
          <a className="btn" href={`/analytics/export?range=${range.key}&by=${by}`} download>
            Export CSV
          </a>
        }
      />
      <KpiRow kpis={kpis} periodLabel={PERIOD[range.key] ?? range.key} />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <ClicksSignupsChart days={daily.days} clicks={daily.clicks} signups={daily.signups} />
        <RevenueFlow rows={flow} />
      </div>
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <BreakdownTable by={by} rows={rows} hrefFor={hrefFor} />
        <TrackedLinksPanel links={links} options={options} canEdit={members.roleAtLeast(me.role, 'editor')}>
          <IntegrationStrip items={integrations} />
        </TrackedLinksPanel>
      </div>
    </>
  );
}
