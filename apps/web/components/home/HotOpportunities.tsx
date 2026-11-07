import { Avatar } from '@/components/ui/avatar';
import type { dashboard } from '@threadline/db';
import { ago } from '@threadline/shared';
import Link from 'next/link';

type Hot = Awaited<ReturnType<typeof dashboard.hotOpportunities>>;

export function HotOpportunities({ hot }: { hot: Hot }) {
  return (
    <section className="panel" aria-labelledby="hot-h">
      <div className="sect-h">
        <h2 id="hot-h">Hot opportunities</h2>
        <span className="muted text-xs">Top 5 by intent score · {hot.newToday} new today</span>
        <div className="flex-1" />
        <Link href="/opportunities" className="btn btn-ghost !h-7">
          View all
        </Link>
      </div>
      {hot.items.length === 0 ? (
        <p className="muted m-0 px-[18px] py-6 text-[13px]">
          No open opportunities. New matches appear here as they are scored.
        </p>
      ) : null}
      {hot.items.map((o) => (
        <div
          key={o.id}
          className="row-hover grid grid-cols-[56px_minmax(0,1fr)_auto_auto] items-center gap-3.5 border-b border-line-soft px-[18px] py-3 last:border-b-0"
        >
          <div className="flex flex-col items-start gap-1">
            <span className="num text-xl leading-none font-semibold tracking-[-0.02em]">{o.score}</span>
            <span className={`chip ${o.level === 'high' ? 'chip-hot' : 'chip-mid'}`}>
              {o.level === 'high' ? 'High' : o.level === 'medium' ? 'Medium' : 'Low'}
            </span>
          </div>
          <div className="min-w-0">
            <div className="text-sm leading-snug font-medium [text-wrap:pretty]">{o.title}</div>
            <div className="muted mt-0.5 flex flex-wrap gap-2.5 text-xs">
              <span className="font-medium text-ink-2">r/{o.subreddit}</span>
              <span>{ago(o.postedAt)}</span>
              <span className="num">{o.upvotes} upvotes</span>
              <span className="num">{o.comments} comments</span>
            </div>
          </div>
          {o.agent ? (
            <Avatar name={o.agent.name} label={o.agent.name[0]} color={o.agent.color} title={o.agent.name} />
          ) : (
            <span />
          )}
          <Link href={`/opportunities?id=${o.id}`} className="btn">
            Draft reply
          </Link>
        </div>
      ))}
    </section>
  );
}
