import { Avatar } from '@/components/ui/avatar';
import { PageHeader } from '@/components/ui/page-header';
import { toggleStatus } from '@/lib/actions/agents';
import { requireMember } from '@/lib/session';
import { agents, members, prisma, shell } from '@threadline/db';
import { ago } from '@threadline/shared';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { AgentCard } from './AgentCard';
import { AssignmentForm } from './AssignmentForm';
import { ConnectorGrid } from './ConnectorGrid';
import { ContextList } from './ContextList';
import { NewAgentForm } from './NewAgentForm';
import { PerformanceCharts } from './PerformanceCharts';
import { PersonaForm } from './PersonaForm';
import { SkillToggleList } from './SkillToggleList';
import { TestAgentPanel } from './TestAgentPanel';

export const TABS = ['persona', 'skills', 'context', 'connectors', 'assignment', 'performance'] as const;
export type Tab = (typeof TABS)[number];

const SAMPLE_POST =
  'We’re a 6-person agency and Asana pricing jumped when we added two contractors. Need boards, due dates and client guest access. Budget ~$50/mo.';

export async function AgentsView({
  selectedId,
  tab,
  isNew,
}: { selectedId?: string; tab: Tab; isNew?: boolean }) {
  const me = await requireMember();
  const cards = await agents.listCards(me.workspaceId);
  const isAdmin = members.roleAtLeast(me.role, 'admin');
  const canEdit = members.roleAtLeast(me.role, 'editor');
  const selected = selectedId ? cards.find((c) => c.id === selectedId) : cards[0];
  if (selectedId && !selected) notFound();

  const counts = await shell.shellCounts(me.workspaceId, me.id);
  const atLimit = counts.usage.agents.used >= counts.usage.agents.limit;
  const limitMessage = `Your ${counts.plan[0]!.toUpperCase()}${counts.plan.slice(1)} plan includes ${counts.usage.agents.limit} agents and you have ${counts.usage.agents.used}. Upgrade the plan or remove an agent to add another.`;

  return (
    <>
      <PageHeader
        title="Agent employees"
        sub={`${cards.length} agent employee${cards.length === 1 ? '' : 's'} · every draft goes to a human approver before it posts`}
        actions={
          isAdmin ? (
            <Link href="/agents?new=1" className="btn btn-primary">
              New agent
            </Link>
          ) : null
        }
      />
      {isNew && isAdmin ? <NewAgentForm atLimit={atLimit} limitMessage={limitMessage} /> : null}
      {isNew && !isAdmin ? (
        <p role="alert" className="m-0 rounded-[9px] bg-warn-soft px-3 py-2 text-[13px] text-warn">
          Only admins can create agents.
        </p>
      ) : null}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {cards.map((a) => (
          <AgentCard key={a.id} a={a} selected={a.id === selected?.id} />
        ))}
      </div>
      {selected ? (
        <Editor
          agentId={selected.id}
          tab={tab}
          canEdit={canEdit}
          isAdmin={isAdmin}
          workspaceId={me.workspaceId}
        />
      ) : null}
    </>
  );
}

const TAB_LABEL: Record<Tab, string> = {
  persona: 'Persona',
  skills: 'Skills',
  context: 'Context',
  connectors: 'Connectors',
  assignment: 'Assignment',
  performance: 'Performance',
};

async function Editor({
  agentId,
  tab,
  canEdit,
  isAdmin,
  workspaceId,
}: { agentId: string; tab: Tab; canEdit: boolean; isAdmin: boolean; workspaceId: string }) {
  const a = await agents.get(workspaceId, agentId);
  if (!a) notFound();
  const persona = agents.asPersona(a.persona);

  let body: React.ReactNode;
  if (tab === 'persona') {
    body = (
      <PersonaForm
        agentId={a.id}
        name={a.name}
        roleTitle={a.roleTitle}
        persona={persona}
        accountDisclosure={a.account?.disclosureLine ?? null}
        canEdit={canEdit}
      />
    );
  } else if (tab === 'skills') {
    body = <SkillToggleList agentId={a.id} skills={a.skills} canEdit={canEdit} />;
  } else if (tab === 'context') {
    const now = Date.now();
    const rows = await prisma.$queryRaw<{ id: string; embedded: boolean }[]>`
      SELECT id, embedding IS NOT NULL AS embedded FROM "ContextItem" WHERE "agentId" = ${a.id}`;
    const embedded = new Set(rows.filter((r) => r.embedded).map((r) => r.id));
    body = (
      <ContextList
        agentId={a.id}
        canEdit={canEdit}
        items={a.contextItems.map((c) => ({
          id: c.id,
          kind: c.kind,
          title: c.title,
          sourceUrl: c.sourceUrl,
          fresh: `${ago(c.freshAt)} ago`,
          stale: now - c.freshAt.getTime() > 30 * 86_400_000,
          embedded: embedded.has(c.id),
        }))}
      />
    );
  } else if (tab === 'connectors') {
    const order = ['notion', 'gdrive', 'hubspot', 'attio', 'slack', 'ga4', 'posthog', 'stripe', 'calendly'];
    body = (
      <ConnectorGrid
        agentId={a.id}
        canEdit={isAdmin}
        connectors={[...a.connectors]
          .sort((x, y) => order.indexOf(x.provider) - order.indexOf(y.provider))
          .map((c) => ({
            provider: c.provider,
            status: c.status,
            tools: ((c.permissions as { tools?: string[] } | null)?.tools ?? []) as string[],
          }))}
      />
    );
  } else if (tab === 'assignment') {
    const opts = await agents.assignmentOptions(workspaceId);
    const names = new Map((await agents.listCards(workspaceId)).map((c) => [c.id, c.name]));
    body = (
      <AssignmentForm
        agentId={a.id}
        canEdit={isAdmin}
        value={{
          accountId: a.accountId,
          approverMemberId: a.approverMemberId,
          dailyDraftLimit: a.dailyDraftLimit,
          status: a.status,
        }}
        options={{
          ...opts,
          groups: opts.groups.map((g) => ({
            ...g,
            owner: g.agentId ? (names.get(g.agentId) ?? null) : null,
          })),
        }}
      />
    );
  } else {
    body = <PerformanceCharts p={await agents.performance(workspaceId, a.id)} />;
  }

  return (
    <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
      <section className="panel min-w-0" aria-label={`${a.name} editor`}>
        <div className="flex items-center gap-3 px-[18px] pt-4 pb-2">
          <Avatar name={a.name} label={a.name[0]} color={a.color} size={32} />
          <div className="flex-1 leading-tight">
            <h2 className="m-0 text-[15px] font-semibold">{a.name}</h2>
            <div className="muted text-xs">
              {a.roleTitle}
              {persona.focus ? ` for ${persona.focus}` : ''}
            </div>
          </div>
          {isAdmin ? (
            <form action={toggleStatus}>
              <input type="hidden" name="agentId" value={a.id} />
              <input type="hidden" name="status" value={a.status === 'active' ? 'paused' : 'active'} />
              <button type="submit" className="btn">
                {a.status === 'active' ? 'Pause' : 'Resume'}
              </button>
            </form>
          ) : null}
          {tab === 'persona' && canEdit ? (
            <button type="submit" form="persona-form" className="btn btn-primary">
              Save changes
            </button>
          ) : null}
        </div>
        <nav
          aria-label="Agent sections"
          className="flex gap-0.5 overflow-x-auto border-b border-line-soft px-[18px]"
        >
          {TABS.map((t) => (
            <Link
              key={t}
              href={`/agents/${a.id}/${t}`}
              aria-current={t === tab ? 'page' : undefined}
              className={`-mb-px flex h-[42px] items-center border-b-2 px-2.5 text-[13px] ${t === tab ? 'border-ink font-semibold text-ink' : 'border-transparent font-medium text-muted hover:text-ink'}`}
            >
              {TAB_LABEL[t]}
            </Link>
          ))}
        </nav>
        {body}
      </section>
      <TestAgentPanel agentId={a.id} agentName={a.name} samplePost={SAMPLE_POST} />
    </div>
  );
}
