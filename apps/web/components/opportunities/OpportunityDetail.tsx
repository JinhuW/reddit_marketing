import { Avatar } from '@/components/ui/avatar';
import type { OpportunityDetail as Detail } from '@threadline/db/repos/opportunities';
import { ago, fmtPct } from '@threadline/shared';
import Link from 'next/link';
import { GenerateDraftButton } from './GenerateDraftButton';

const ROLE = { founder: 'Founder', support: 'Support', brand: 'Brand' } as const;

export function OpportunityDetail({ o, canEdit }: { o: Detail | null; canEdit: boolean }) {
  if (!o)
    return (
      <aside className="panel muted px-5 py-10 text-center text-[13px] xl:sticky xl:top-20">
        Select a post to see the thread.
      </aside>
    );
  const { post, agent } = o;
  return (
    <aside className="panel flex min-w-0 flex-col xl:sticky xl:top-20" aria-labelledby="sel-h">
      <div className="sect-h">
        <h2 id="sel-h">Selected post</h2>
        <div className="flex-1" />
        <a href={post.url} target="_blank" rel="noreferrer" className="btn btn-ghost !h-7 !px-2">
          Open on Reddit
        </a>
      </div>
      <div className="flex flex-col gap-3.5 px-[18px] py-4 text-[13px] leading-normal">
        <div>
          <div className="muted text-xs">
            r/{post.subreddit} · u/{post.author} · {ago(post.postedAt)} ·{' '}
            <span className="num">{post.upvotes}</span> upvotes · <span className="num">{post.comments}</span>{' '}
            comments
          </div>
          <div className="mt-1 text-[15px] leading-snug font-semibold">{post.title}</div>
          {post.body ? <p className="m-0 mt-2 text-ink-2">{post.body}</p> : null}
        </div>
        {o.competitors.length ? (
          <div className="flex flex-col gap-1.5">
            <div className="text-xs font-semibold">Competitors mentioned</div>
            <div className="flex flex-wrap gap-1.5">
              {o.competitors.map((c) => (
                <span key={c} className="chip chip-line">
                  {c}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        {post.topComments.length ? (
          <div className="flex flex-col gap-2">
            <div className="text-xs font-semibold">Top comments</div>
            {post.topComments.map((c) => (
              <div key={c.author + c.body} className="border-l-2 border-line pl-2.5 text-ink-2">
                <span className="font-medium text-ink">u/{c.author}</span> · {c.body}{' '}
                <span className="muted num">↑ {c.score}</span>
              </div>
            ))}
          </div>
        ) : null}
        {agent ? (
          <div className="flex items-center gap-2.5 rounded-[12px] border border-line bg-surface-2 px-3.5 py-3">
            <Avatar name={agent.name} label={agent.name[0]} color={agent.color} size={30} />
            <div className="min-w-0 flex-1 leading-tight">
              <div className="font-semibold">Suggested agent: {agent.name}</div>
              <div className="muted text-xs">
                {agent.role}
                {agent.coversSub ? ` · covers r/${post.subreddit}` : ''}
                {agent.approvalRate !== null ? ` · ${fmtPct(agent.approvalRate)} approved` : ''}
              </div>
            </div>
            <Link href={`/agents/${agent.id}/assignment`} className="btn btn-ghost !h-7 !px-2">
              Change
            </Link>
          </div>
        ) : (
          <div className="muted rounded-[12px] border border-line bg-surface-2 px-3.5 py-3 text-xs">
            No agent assigned. Select this card and use “Assign to agent”.
          </div>
        )}
        {agent?.account ? (
          <div className="muted text-xs">
            Draft will post from <b className="font-medium text-ink">u/{agent.account.username}</b> (
            {ROLE[agent.account.roleLabel]}, disclosed) after {agent.approver?.split(' ')[0] ?? 'an approver'}{' '}
            approves it.
          </div>
        ) : null}
        {canEdit ? <GenerateDraftButton id={o.id} disabled={!agent || o.status === 'replied'} /> : null}
      </div>
    </aside>
  );
}
