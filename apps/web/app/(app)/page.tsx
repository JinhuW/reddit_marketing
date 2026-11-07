import { ActivityFeed } from '@/components/home/ActivityFeed';
import { AgentLeaderboard } from '@/components/home/AgentLeaderboard';
import { Funnel } from '@/components/home/Funnel';
import { HotOpportunities } from '@/components/home/HotOpportunities';
import { KpiTile } from '@/components/home/KpiTile';
import { parseRange } from '@/lib/range';
import { requireMember } from '@/lib/session';
import { dashboard } from '@threadline/db';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Home' };

function greeting(now: Date, timeZone?: string) {
  const h = Number(
    new Intl.DateTimeFormat('en-US', { hour: 'numeric', hourCycle: 'h23', timeZone }).format(now),
  );
  return h < 12 ? 'Good morning' : h < 18 ? 'Good afternoon' : 'Good evening';
}

export default async function Home({
  searchParams,
}: { searchParams: Promise<Record<string, string | string[] | undefined>> }) {
  const me = await requireMember();
  const range = parseRange((await searchParams).range);
  const ws = me.workspaceId;
  const tz = (me.workspace.settings as { timeZone?: string } | null)?.timeZone;
  const [kpis, hot, funnel, leaderboard, feed] = await Promise.all([
    dashboard.kpis(ws, range.days, range.label),
    dashboard.hotOpportunities(ws),
    dashboard.funnel(ws),
    dashboard.agentLeaderboard(ws),
    dashboard.activity(ws),
  ]);
  const now = new Date();
  const pending = kpis.find((k) => k.key === 'pending')?.value ?? 0;
  const date = new Intl.DateTimeFormat('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
    timeZone: tz,
  }).format(now);

  return (
    <>
      <div className="flex flex-wrap items-end gap-4">
        <div className="min-w-[240px] flex-1">
          <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">
            {greeting(now, tz)}, {(me.user.name ?? '').split(' ')[0]}
          </h1>
          <div className="muted mt-1 text-[13px]">
            {date} ·{' '}
            {pending === 0
              ? 'No drafts are waiting'
              : `${pending} draft${pending === 1 ? ' is' : 's are'} waiting for you`}
          </div>
        </div>
        <Link href="/approvals" className="btn btn-primary">
          Review approvals
        </Link>
      </div>

      <div className="grid grid-cols-3 gap-3 xl:grid-cols-6">
        {kpis.map((k) => (
          <KpiTile key={k.key} k={k} />
        ))}
      </div>

      <div className="grid items-start gap-5 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <div className="flex min-w-0 flex-col gap-5">
          <HotOpportunities hot={hot} />
          <Funnel steps={funnel} />
        </div>
        <div className="flex min-w-0 flex-col gap-5">
          <AgentLeaderboard rows={leaderboard} />
          <ActivityFeed items={feed} />
        </div>
      </div>
    </>
  );
}
