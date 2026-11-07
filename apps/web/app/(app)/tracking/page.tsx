import { KeywordGroups } from '@/components/tracking/KeywordGroups';
import { ShareOfVoiceChart } from '@/components/tracking/ShareOfVoiceChart';
import { SubredditWatchlist } from '@/components/tracking/SubredditWatchlist';
import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';
import { members, tracking } from '@threadline/db';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Tracking' };

export default async function TrackingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireMember();
  const sp = await searchParams;
  const ws = me.workspaceId;
  const canEdit = members.roleAtLeast(me.role, 'editor');
  const [groups, subs, sov, agents] = await Promise.all([
    tracking.listKeywordGroups(ws),
    tracking.listSubreddits(ws),
    tracking.shareOfVoice(ws),
    tracking.agentOptions(ws),
  ]);
  const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
  return (
    <>
      <PageHeader
        title="Tracking"
        sub={`${plural(groups.length, 'keyword group')} · ${plural(subs.length, 'subreddit')} watched · checked every 10 minutes`}
        actions={
          canEdit ? (
            <div className="flex gap-2">
              <Link href="/tracking?new=sub" scroll={false} className="btn">
                Add subreddit
              </Link>
              <Link href="/tracking?new=group" scroll={false} className="btn btn-primary">
                New keyword group
              </Link>
            </div>
          ) : null
        }
      />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-2">
        <KeywordGroups groups={groups} agents={agents} canEdit={canEdit} openNew={sp.new === 'group'} />
        <div className="flex min-w-0 flex-col gap-5">
          <ShareOfVoiceChart data={sov} />
          <SubredditWatchlist subs={subs} canEdit={canEdit} openNew={sp.new === 'sub'} />
        </div>
      </div>
    </>
  );
}
