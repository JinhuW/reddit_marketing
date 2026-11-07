import { ApprovalsView } from '@/components/approvals/ApprovalsView';
import type { DraftDetail, DraftRow, ThreadContext } from '@/components/approvals/types';
import { requireMember } from '@/lib/session';
import { evaluateDraft } from '@threadline/agents';
import { drafts, members } from '@threadline/db';
import { type DraftType, ago, buildUtm, withUtm } from '@threadline/shared';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Approvals' };
export const dynamic = 'force-dynamic';

const TYPE_LABEL: Record<DraftType, string> = { comment: 'Comment', post: 'Post', dm: 'DM follow-up' };
const DETAIL_LABEL: Record<DraftType, string> = {
  comment: 'Comment reply',
  post: 'New post',
  dm: 'DM follow-up',
};
const ROLE: Record<string, string> = { founder: 'Founder', support: 'Support', brand: 'Brand' };
const TYPES = ['comment', 'post', 'dm'] as const;

type D = drafts.DraftWithContext;

function where(d: D) {
  if (d.type === 'dm') return d.conversation ? `u/${d.conversation.lead.redditUser.username}` : 'DM';
  const sub = drafts.draftSubreddit(d);
  return sub ? `r/${sub.name}` : 'Reddit';
}

function firstLine(d: D) {
  const line = (d.title ?? d.body).split('\n')[0] ?? '';
  return line.length > 90 ? `${line.slice(0, 88).trimEnd()}…` : line;
}

function thread(d: D): ThreadContext {
  if (d.type === 'dm' && d.conversation) {
    const c = d.conversation;
    return {
      kind: 'dm',
      meta: `DM with u/${c.lead.redditUser.username} · ${c.originReason}`,
      note: 'Replying in an existing DM conversation',
      messages: c.messages.slice(-3).map((m) => ({
        author: m.direction === 'in' ? `u/${m.author}` : `u/${m.author}`,
        body: m.body,
        ago: ago(m.sentAt),
        inbound: m.direction === 'in',
      })),
    };
  }
  if (d.opportunity) {
    const p = d.opportunity.post;
    const body = p.body.length > 240 ? `${p.body.slice(0, 238).trimEnd()}…` : p.body;
    return {
      kind: 'thread',
      meta: `r/${p.subreddit.name} · u/${p.authorUsername} · ${ago(p.postedAt)} · ${p.upvotes} upvotes · ${p.comments} comments`,
      title: p.title,
      excerpt: body,
      note: 'Replying to the post as a top-level comment',
    };
  }
  const sub = drafts.draftSubreddit(d);
  return {
    kind: 'new_post',
    meta: sub ? `New post in r/${sub.name}` : 'New post',
    title: d.title ?? undefined,
    note: 'Submitting a new post from this account',
  };
}

function link(d: D, shortHost: string) {
  const tl = d.trackedLink;
  if (!tl) return null;
  const utm = (tl.utm ?? {}) as Record<string, string>;
  const label = utm.label ?? tl.slug;
  const params = buildUtm({
    medium: tl.medium,
    subreddit: tl.subreddit?.name ?? null,
    postId: utm.utm_content ?? null,
    agent: d.agent.name,
  });
  return {
    short: `${shortHost}/r/${label}`,
    full: (utm.full ?? withUtm(tl.destinationUrl, params)).replace(/^https?:\/\//, ''),
  };
}

export default async function ApprovalsPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | undefined>> }) {
  const me = await requireMember();
  const sp = await searchParams;
  const type = TYPES.find((t) => t === sp.type);
  const [list, counts] = await Promise.all([
    drafts.pending(me.workspaceId, { type }),
    drafts.pendingCounts(me.workspaceId),
  ]);
  const now = new Date();

  const rows: DraftRow[] = list.map((d) => ({
    id: d.id,
    type: d.type,
    agent: d.agent.name,
    agentColor: d.agent.color,
    where: where(d),
    wait: ago(d.createdAt, now),
    waitHot: now.getTime() - d.createdAt.getTime() > 2 * 3_600_000,
    firstLine: firstLine(d),
    account: `u/${d.account.username}`,
  }));

  const sel = list.find((d) => d.id === sp.id) ?? list[0] ?? null;
  const settings = (me.workspace.settings ?? {}) as { shortHost?: string };
  let detail: DraftDetail | null = null;
  if (sel) {
    const ruleContext = await drafts.buildRuleContext(sel, now);
    detail = {
      id: sel.id,
      type: sel.type,
      typeLabel: DETAIL_LABEL[sel.type],
      agent: sel.agent.name,
      agentColor: sel.agent.color,
      createdAgo: ago(sel.createdAt, now),
      body: sel.body,
      title: sel.title,
      reasoning: sel.reasoning,
      thread: thread(sel),
      ruleContext,
      initialChecks: evaluateDraft(ruleContext),
      link: link(sel, settings.shortHost ?? 'acme.so'),
      account: {
        username: sel.account.username,
        roleLabel: ROLE[sel.account.roleLabel] ?? sel.account.roleLabel,
        ownerName: sel.account.owner.user.name ?? sel.account.owner.user.email,
        disclosureLine: sel.account.disclosureLine,
      },
      approverName: me.user.name ?? me.user.email,
      editCount: sel.editCount,
    };
  }
  const oldest = list.length ? list.reduce((a, d) => (d.createdAt < a.createdAt ? d : a)) : null;

  return (
    <ApprovalsView
      rows={rows}
      counts={counts}
      type={type ?? null}
      detail={detail}
      oldestWait={oldest ? ago(oldest.createdAt, now) : null}
      typeLabels={TYPE_LABEL}
      perms={{ canApprove: members.memberCanApprove(me), canEdit: members.roleAtLeast(me.role, 'editor') }}
    />
  );
}
