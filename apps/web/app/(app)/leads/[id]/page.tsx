import { Notes } from '@/components/leads/Notes';
import { StageStepper } from '@/components/leads/StageStepper';
import { Tasks } from '@/components/leads/Tasks';
import { Timeline } from '@/components/leads/Timeline';
import { money, scoreChip, scoreLevel, shortDate } from '@/components/leads/format';
import { Avatar } from '@/components/ui/avatar';
import { requireMember } from '@/lib/session';
import { leads, members, prisma } from '@threadline/db';
import { ago } from '@threadline/shared';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export async function generateMetadata({ params }: { params: Promise<{ id: string }> }): Promise<Metadata> {
  const { id } = await params;
  const l = await prisma.lead.findUnique({
    where: { id },
    select: { redditUser: { select: { username: true } } },
  });
  return { title: l ? `u/${l.redditUser.username}` : 'Lead' };
}

export default async function LeadDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireMember();
  const lead = await leads.get(me.workspaceId, id);
  if (!lead) notFound();
  const events = await leads.timeline(me.workspaceId, id);
  const canEdit = members.roleAtLeast(me.role, 'editor');
  const conv = await prisma.conversation.findFirst({
    where: { workspaceId: me.workspaceId, leadId: id },
    orderBy: { lastMessageAt: 'desc' },
    select: { id: true },
  });

  const subline = [
    `first seen ${shortDate(lead.firstSeenAt)}${lead.subreddits[0] ? ` in r/${lead.subreddits[0]}` : ''}`,
    `${lead.threads} thread${lead.threads === 1 ? '' : 's'}`,
    `${lead.clicks} click${lead.clicks === 1 ? '' : 's'}`,
  ].join(' · ');

  return (
    <>
      <nav aria-label="Breadcrumb" className="muted flex items-center gap-1.5 text-[12.5px]">
        <Link href="/leads" className="hover:text-ink">
          Leads
        </Link>
        <span aria-hidden="true">/</span>
        <span className="text-ink">u/{lead.username}</span>
      </nav>

      <div className="panel flex flex-col gap-4 px-[22px] py-[18px]">
        <div className="flex flex-wrap items-center gap-3.5">
          <Avatar name={lead.username} size={48} />
          <div className="min-w-[240px] flex-1 leading-tight">
            <h1 className="m-0 text-[22px] font-semibold tracking-[-0.01em]">u/{lead.username}</h1>
            <div className="muted mt-[3px] text-[13px]">{subline}</div>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span className={scoreChip(lead.intentScore)}>
              Intent {lead.intentScore} · {scoreLevel(lead.intentScore)}
            </span>
            {lead.hubspotSyncedAt ? (
              <span className="chip chip-ok">Synced to HubSpot · {ago(lead.hubspotSyncedAt)}</span>
            ) : (
              <span className="chip chip-mid">Not synced</span>
            )}
            {lead.owner ? (
              <span className="btn !cursor-default">
                <Avatar name={lead.owner.name} size={16} />
                {lead.owner.name}
              </span>
            ) : null}
            {conv ? (
              <Link href={`/conversations?id=${conv.id}`} className="btn btn-primary">
                Message
              </Link>
            ) : null}
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-3">
          <StageStepper leadId={lead.id} stage={lead.stage} canEdit={canEdit} />
          <div className="flex-1" />
          <span className="muted text-[12.5px]">
            Deal value{' '}
            <b className="num font-semibold text-ink">
              {lead.dealValueCents ? `${money(lead.dealValueCents)} / mo` : '—'}
            </b>
            {lead.agent ? ` · est. by ${lead.agent.name} from thread context` : ''}
          </span>
        </div>
      </div>

      <div className="grid items-start gap-5 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
        <Timeline events={events} />
        <div className="flex flex-col gap-5">
          <section className="panel">
            <div className="sect-h">
              <h2>Details</h2>
            </div>
            <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2.5 px-[18px] pt-3 pb-4 text-[13px]">
              <dt className="muted">Owner</dt>
              <dd className="m-0 font-medium">{lead.owner?.name ?? 'Unassigned'}</dd>
              <dt className="muted">Agent</dt>
              <dd className="m-0 flex items-center gap-1.5 font-medium">
                {lead.agent ? (
                  <>
                    <Avatar
                      name={lead.agent.name}
                      label={lead.agent.name[0]}
                      color={lead.agent.color}
                      size={18}
                    />
                    {lead.agent.name} · {lead.agent.roleTitle}
                  </>
                ) : (
                  '—'
                )}
              </dd>
              <dt className="muted">Subreddits</dt>
              <dd className="m-0 flex flex-wrap gap-1.5">
                {lead.subreddits.length
                  ? lead.subreddits.map((s) => (
                      <span key={s} className="chip chip-line">
                        r/{s}
                      </span>
                    ))
                  : '—'}
              </dd>
              <dt className="muted">Signup email</dt>
              <dd className="m-0 font-medium">{lead.signupEmail ?? '— not yet'}</dd>
              <dt className="muted">Revenue</dt>
              <dd className="num m-0 font-medium">{lead.revenueCents ? money(lead.revenueCents) : '$0'}</dd>
              <dt className="muted">Clicks</dt>
              <dd className="num m-0 font-medium">
                {lead.clicks}
                {lead.lastClickAt ? ` · last ${ago(lead.lastClickAt)} ago` : ''}
              </dd>
              <dt className="muted">Tags</dt>
              <dd className="m-0 flex flex-wrap gap-1.5">
                {lead.tags.length
                  ? lead.tags.map((t) => (
                      <span key={t} className="chip chip-mid">
                        {t}
                      </span>
                    ))
                  : '—'}
              </dd>
            </dl>
          </section>
          <Notes leadId={lead.id} notes={lead.notes} canEdit={canEdit} />
          <Tasks
            leadId={lead.id}
            canEdit={canEdit}
            tasks={lead.tasks.map((t) => ({
              id: t.id,
              title: t.title,
              done: t.done,
              dueAt: t.dueAt?.toISOString() ?? null,
            }))}
          />
        </div>
      </div>
    </>
  );
}
