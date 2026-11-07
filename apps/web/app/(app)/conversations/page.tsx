import { MarkRead } from '@/components/conversations/MarkRead';
import { ReplyBox } from '@/components/conversations/ReplyBox';
import { Seg } from '@/components/leads/Seg';
import { lastTouch, money, scoreChip, scoreLevel, shortDate } from '@/components/leads/format';
import { Avatar } from '@/components/ui/avatar';
import { requireMember } from '@/lib/session';
import { conversations, members } from '@threadline/db';
import { LEAD_STAGE_LABEL } from '@threadline/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Conversations' };

const TAB_LABEL: Record<conversations.ConversationTab, string> = {
  all: 'All',
  unread: 'Unread',
  needs_reply: 'Needs reply',
  mine: 'Mine',
};

const cap = (s: string) => s[0]!.toUpperCase() + s.slice(1);

export default async function ConversationsPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const me = await requireMember();
  const sp = await searchParams;
  const tab = (conversations.TABS as readonly string[]).includes(String(sp.tab))
    ? (sp.tab as conversations.ConversationTab)
    : 'all';
  const [list, counts] = await Promise.all([
    conversations.list(me.workspaceId, tab, me.id),
    conversations.counts(me.workspaceId, me.id),
  ]);
  const selectedId = typeof sp.id === 'string' ? sp.id : list[0]?.id;
  const conv = selectedId ? await conversations.get(me.workspaceId, selectedId) : null;
  const href = (p: { tab?: string; id?: string }) => {
    const q = new URLSearchParams();
    const t = p.tab ?? tab;
    if (t !== 'all') q.set('tab', t);
    if (p.id) q.set('id', p.id);
    const s = q.toString();
    return s ? `/conversations?${s}` : '/conversations';
  };

  return (
    <div className="grid min-h-0 items-stretch gap-5 xl:grid-cols-[320px_minmax(0,1fr)_300px] lg:grid-cols-[300px_minmax(0,1fr)]">
      <section className="panel flex min-w-0 flex-col" aria-label="Conversation list">
        <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
          <div className="flex items-baseline gap-2">
            <h1 className="m-0 text-lg font-semibold">Conversations</h1>
            {counts.unread ? (
              <span className="num text-[13px] font-semibold text-accent">{counts.unread} unread</span>
            ) : null}
          </div>
          <Seg
            label="Filter conversations"
            className="w-full"
            items={conversations.TABS.map((t) => ({
              label: TAB_LABEL[t],
              href: href({ tab: t }),
              active: t === tab,
            }))}
          />
        </div>
        <ul className="m-0 list-none border-t border-line-soft p-0">
          {list.length === 0 ? (
            <li className="muted px-4 py-8 text-center text-[13px]">Nothing here.</li>
          ) : null}
          {list.map((c) => {
            const on = c.id === conv?.id;
            return (
              <li key={c.id}>
                <Link
                  href={href({ id: c.id })}
                  scroll={false}
                  aria-current={on ? 'true' : undefined}
                  data-conversation={c.username}
                  className={`grid grid-cols-[32px_minmax(0,1fr)] gap-2.5 border-b border-line-soft px-4 py-3 ${on ? 'bg-surface-3' : 'hover:bg-surface-2'}`}
                >
                  <Avatar name={c.username} size={32} />
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <div className="flex items-center gap-2">
                      <span className={`text-[13.5px] ${c.unread ? 'font-semibold' : 'font-medium'}`}>
                        u/{c.username}
                      </span>
                      <span className="chip chip-line !h-[18px] !text-[10.5px]">
                        {c.kind === 'dm' ? 'DM' : 'Comment'}
                      </span>
                      <div className="flex-1" />
                      <span className="muted num text-[11.5px]">{lastTouch(c.lastMessageAt)}</span>
                    </div>
                    <div className="truncate text-[12.5px] text-ink-2">{c.preview}</div>
                    <div className="muted flex items-center gap-1.5 text-[11.5px]">
                      {c.unread ? (
                        <span className="h-1.5 w-1.5 flex-none rounded-full bg-accent" aria-label="Unread" />
                      ) : null}
                      <span className="truncate">{c.where}</span>
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
      </section>

      {conv ? (
        <>
          <MarkRead id={conv.id} unread={conv.unread} />
          <Thread conv={conv} canDraft={members.roleAtLeast(me.role, 'editor')} />
          <LeadPanel conv={conv} />
        </>
      ) : (
        <section className="panel muted grid place-items-center p-10 text-[13px]">
          Select a conversation.
        </section>
      )}
    </div>
  );
}

type Conv = NonNullable<Awaited<ReturnType<typeof conversations.get>>>;

function Thread({ conv, canDraft }: { conv: Conv; canDraft: boolean }) {
  const user = conv.lead.redditUser.username;
  const sub = conv.post?.subreddit.name;
  let lastDay = '';
  const header = (d: Date) =>
    conv.kind === 'dm'
      ? `Direct messages · ${shortDate(d)}`
      : `Comment thread${sub ? ` · r/${sub}` : ''} · ${shortDate(d)}`;
  return (
    <section className="panel flex min-h-[560px] min-w-0 flex-col" aria-label={`Thread with u/${user}`}>
      <div className="sect-h">
        <Avatar name={user} size={28} />
        <div className="leading-tight">
          <h2>u/{user}</h2>
          <div className="muted text-xs">
            {conv.kind === 'dm' ? 'DM' : 'Comment thread'} · {conv.originReason}
          </div>
        </div>
        <div className="flex-1" />
        <span className="chip chip-hot">{LEAD_STAGE_LABEL[conv.lead.stage]}</span>
        <Link className="btn btn-ghost !h-7" href={`/leads/${conv.lead.id}`}>
          Open lead
        </Link>
      </div>
      <ol className="m-0 flex flex-1 list-none flex-col gap-3 overflow-auto px-5 py-[18px]">
        {conv.messages.map((m) => {
          const day = m.sentAt.toDateString();
          const showHeader = day !== lastDay;
          lastDay = day;
          const us = m.direction === 'out';
          const label = us
            ? [
                `u/${m.account?.username ?? m.author}`,
                m.account ? `${cap(m.account.roleLabel)}, disclosed` : null,
                m.draft ? `${m.draft.agent.name} drafted` : null,
                m.draft?.approver ? `approved by ${m.draft.approver.user.name}` : null,
              ]
                .filter(Boolean)
                .join(' · ')
            : `u/${m.author} · ${conv.kind === 'dm' ? lastTouch(m.sentAt) : 'reply'}`;
          return (
            <li key={m.id} className="contents">
              {showHeader ? (
                <div className="muted mt-1 text-center text-[11.5px]">{header(m.sentAt)}</div>
              ) : null}
              <div
                data-direction={m.direction}
                className={`max-w-[78%] px-3.5 py-2.5 text-[13.5px] leading-[1.55] ${
                  us
                    ? 'self-end rounded-[14px] rounded-tr-[4px] bg-inverse text-inverse-ink'
                    : 'self-start rounded-[14px] rounded-tl-[4px] bg-surface-3 text-ink'
                }`}
              >
                <div className={`mb-1 text-[11px] ${us ? 'opacity-70' : 'text-muted'}`}>{label}</div>
                <div className="whitespace-pre-wrap">{m.body}</div>
              </div>
            </li>
          );
        })}
      </ol>
      <ReplyBox
        conversationId={conv.id}
        canDraft={canDraft}
        agent={conv.lead.agent ? { name: conv.lead.agent.name, color: conv.lead.agent.color } : null}
        account={conv.lead.agent?.account?.username ?? null}
      />
    </section>
  );
}

function LeadPanel({ conv }: { conv: Conv }) {
  const l = conv.lead;
  const user = l.redditUser.username;
  const owner = l.owner ? (l.owner.user.name ?? l.owner.user.email) : null;
  return (
    <aside className="panel flex min-w-0 flex-col max-xl:hidden" aria-label="Lead">
      <div className="sect-h">
        <h2>Lead</h2>
        <div className="flex-1" />
        <span className="chip chip-line">{l.hubspotSyncedAt ? 'Synced to HubSpot' : 'Not synced'}</span>
      </div>
      <div className="flex flex-col gap-4 p-4 text-[13px]">
        <div className="flex items-center gap-2.5">
          <Avatar name={user} size={40} />
          <div className="leading-tight">
            <Link href={`/leads/${l.id}`} className="text-[15px] font-semibold hover:text-accent">
              u/{user}
            </Link>
            <div className="muted text-xs">
              first seen {shortDate(l.createdAt)}
              {l.redditUser.firstSeenPost ? ` in r/${l.redditUser.firstSeenPost.subreddit.name}` : ''}
            </div>
          </div>
        </div>
        <dl className="m-0 grid grid-cols-[92px_minmax(0,1fr)] items-center gap-2.5">
          <dt className="muted">Stage</dt>
          <dd className="m-0 font-medium">{LEAD_STAGE_LABEL[l.stage]}</dd>
          <dt className="muted">Intent</dt>
          <dd className="num m-0 font-medium">
            {l.intentScore}{' '}
            <span className={`${scoreChip(l.intentScore)} ml-1`}>{scoreLevel(l.intentScore)}</span>
          </dd>
          <dt className="muted">Owner</dt>
          <dd className="m-0 flex items-center gap-1.5 font-medium">
            {owner ? (
              <>
                <Avatar name={owner} size={18} />
                {owner}
              </>
            ) : (
              'Unassigned'
            )}
          </dd>
          <dt className="muted">Agent</dt>
          <dd className="m-0 flex items-center gap-1.5 font-medium">
            {l.agent ? (
              <>
                <Avatar name={l.agent.name} label={l.agent.name[0]} color={l.agent.color} size={18} />
                {l.agent.name}
              </>
            ) : (
              '—'
            )}
          </dd>
          <dt className="muted">Deal value</dt>
          <dd className="num m-0 font-medium">
            {l.dealValueCents ? `${money(l.dealValueCents)} / mo est.` : '—'}
          </dd>
          <dt className="muted">Signup email</dt>
          <dd className="m-0 truncate font-medium">{l.signupEmail ?? '—'}</dd>
          {l.tags.length ? (
            <>
              <dt className="muted">Tags</dt>
              <dd className="m-0 flex flex-wrap gap-1.5">
                {l.tags.map((t) => (
                  <span key={t} className="chip chip-mid">
                    {t}
                  </span>
                ))}
              </dd>
            </>
          ) : null}
        </dl>
        {l.conversations.length > 1 ? (
          <div>
            <div className="mb-1.5 text-[12.5px] font-semibold">Previous threads</div>
            <div className="flex flex-col gap-1.5 text-ink-2">
              {l.conversations
                .filter((c) => c.id !== conv.id)
                .map((c) => (
                  <div key={c.id} className="flex gap-2">
                    <span className="muted flex-none">{shortDate(c.createdAt)}</span>
                    <span>{c.originReason}</span>
                  </div>
                ))}
            </div>
          </div>
        ) : null}
        {conv.notes.length ? (
          <div>
            <div className="mb-1.5 text-[12.5px] font-semibold">Notes</div>
            <div className="rounded-[10px] bg-surface-2 px-3 py-2.5 leading-normal text-ink-2">
              {conv.notes[conv.notes.length - 1]!.body}
            </div>
          </div>
        ) : null}
        {l.tasks.map((t) => (
          <div key={t.id} className="flex items-center gap-2">
            <span
              className="h-[15px] w-[15px] flex-none rounded-[4px] border border-line-strong"
              aria-hidden="true"
            />
            <span>{t.title}</span>
            {t.dueAt ? <span className="muted ml-auto text-xs">{shortDate(t.dueAt)}</span> : null}
          </div>
        ))}
        <Link href={`/leads/${l.id}`} className="btn">
          Open lead
        </Link>
      </div>
    </aside>
  );
}
