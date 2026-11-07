'use client';

import { Avatar } from '@/components/ui/avatar';
import { Sparkline } from '@/components/ui/sparkline';
import { type ActionState, deleteKeywordGroup, saveKeywordGroup } from '@/lib/actions/tracking';
import type { KeywordGroupView } from '@threadline/db/repos/tracking';
import { INTENT_LABEL, Intent } from '@threadline/shared';
import { useRouter } from 'next/navigation';
import { useActionState, useEffect, useState } from 'react';

const EX_CHIP = 'chip border border-dashed border-line-strong bg-surface font-medium text-muted line-through';

export function KeywordGroups({
  groups,
  agents,
  canEdit,
  openNew,
}: {
  groups: KeywordGroupView[];
  agents: { id: string; name: string }[];
  canEdit: boolean;
  openNew: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(openNew && canEdit ? 'new' : null);
  useEffect(() => {
    if (openNew && canEdit) setEditing('new');
  }, [openNew, canEdit]);

  return (
    <section className="panel min-w-0" aria-labelledby="kg-h">
      <div className="sect-h flex-wrap">
        <h2 id="kg-h">Keyword groups</h2>
        <span className="muted text-xs">Include · exclude · competitor terms</span>
        <div className="flex-1" />
        {canEdit && editing !== 'new' ? (
          <button type="button" className="btn btn-ghost !h-7" onClick={() => setEditing('new')}>
            New group
          </button>
        ) : null}
      </div>
      {editing === 'new' ? <GroupForm agents={agents} onClose={() => setEditing(null)} /> : null}
      {groups.length === 0 && editing !== 'new' ? (
        <p className="muted m-0 px-[18px] py-6 text-[13px]">
          No keyword groups yet. Add one to start finding threads.
        </p>
      ) : null}
      {groups.map((g) =>
        editing === g.id ? (
          <GroupForm key={g.id} group={g} agents={agents} onClose={() => setEditing(null)} />
        ) : (
          <article
            key={g.id}
            data-testid="keyword-group"
            className="flex flex-col gap-2 border-b border-line-soft px-[18px] py-3.5"
            aria-label={g.name}
          >
            <div className="flex items-center gap-2.5">
              <h3 className="m-0 text-sm font-semibold">{g.name}</h3>
              <span className="chip chip-line">{INTENT_LABEL[g.intent]}</span>
              <div className="flex-1" />
              <span className="w-[88px]">
                <Sparkline
                  values={g.series}
                  stroke="var(--accent)"
                  height={22}
                  label={'Daily matches, last 7 days'}
                />
              </span>
              <span
                className="num w-[54px] text-right text-[13px] font-semibold"
                title="Opportunities in the last 7 days"
              >
                {g.volume} <span className="muted text-[11px] font-normal">/wk</span>
              </span>
              {canEdit ? (
                <button
                  type="button"
                  className="btn btn-ghost !h-7 !px-2"
                  onClick={() => setEditing(g.id)}
                  aria-label={`Edit ${g.name}`}
                >
                  Edit
                </button>
              ) : null}
            </div>
            <div className="flex flex-wrap gap-1.5">
              {g.include.map((t) => (
                <span key={`i-${t}`} className="chip chip-line">
                  {t}
                </span>
              ))}
              {g.competitor.map((t) => (
                <span key={`c-${t}`} className="chip chip-hot">
                  {t}
                </span>
              ))}
              {g.exclude.map((t) => (
                <span key={`e-${t}`} className={EX_CHIP}>
                  <span className="sr-only">exclude </span>
                  {t}
                </span>
              ))}
            </div>
            <div className="muted flex flex-wrap items-center gap-3 text-xs">
              <span>Alerts: {g.alertLabel}</span>
              <span className="inline-flex items-center gap-1.5">
                Agent:{' '}
                {g.agent ? (
                  <>
                    <Avatar name={g.agent.name} label={g.agent.name[0]} size={18} />
                    {g.agent.name}
                  </>
                ) : (
                  'none'
                )}
              </span>
              {g.subreddits.length ? (
                <span>Watching {g.subreddits.map((s) => `r/${s}`).join(', ')}</span>
              ) : null}
            </div>
          </article>
        ),
      )}
      <div className="muted flex flex-wrap gap-3 px-[18px] py-2.5 text-xs">
        <span>
          <span className="chip chip-line !h-4 !text-[10px]">term</span> include
        </span>
        <span>
          <span className="chip chip-hot !h-4 !text-[10px]">term</span> competitor
        </span>
        <span>
          <span className={`${EX_CHIP} !h-4 !text-[10px]`}>term</span> exclude
        </span>
      </div>
    </section>
  );
}

function GroupForm({
  group,
  agents,
  onClose,
}: {
  group?: KeywordGroupView;
  agents: { id: string; name: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(saveKeywordGroup, { ok: false });
  const [channel, setChannel] = useState<string>(group?.alert.channel ?? 'slack');
  useEffect(() => {
    if (state.ok) {
      onClose();
      router.replace('/tracking', { scroll: false });
    }
  }, [state, onClose, router]);
  const join = (l?: string[]) => (l ?? []).join(', ');
  return (
    <form
      action={action}
      aria-label={group ? `Edit ${group.name}` : 'New keyword group'}
      className="flex flex-col gap-2.5 border-b border-line-soft bg-surface-2 px-[18px] py-3.5 text-[13px]"
    >
      {group ? <input type="hidden" name="id" value={group.id} /> : null}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <label className="flex flex-col gap-1 font-medium">
          Name
          <input
            name="name"
            className="field"
            required
            defaultValue={group?.name}
            placeholder="Asana alternative"
          />
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Intent
          <select name="intent" className="field" defaultValue={group?.intent ?? 'looking_for_tool'}>
            {Intent.map((i) => (
              <option key={i} value={i}>
                {INTENT_LABEL[i]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium sm:col-span-2">
          Include terms <span className="muted text-xs font-normal">comma separated</span>
          <input
            name="include"
            className="field"
            required
            defaultValue={join(group?.include)}
            placeholder="asana alternative, leaving asana"
          />
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Competitor terms
          <input
            name="competitor"
            className="field"
            defaultValue={join(group?.competitor)}
            placeholder="asana"
          />
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Exclude terms
          <input
            name="exclude"
            className="field"
            defaultValue={join(group?.exclude)}
            placeholder="asana jobs"
          />
        </label>
        <label className="flex flex-col gap-1 font-medium sm:col-span-2">
          Subreddits{' '}
          <span className="muted text-xs font-normal">comma separated, e.g. projectmanagement, SaaS</span>
          <input name="subreddits" className="field" defaultValue={join(group?.subreddits)} />
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Alert channel
          <select
            name="alertChannel"
            className="field"
            value={channel}
            onChange={(e) => setChannel(e.target.value)}
          >
            <option value="slack">Slack</option>
            <option value="email">Email</option>
            <option value="none">Off</option>
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Cadence
          <select
            name="alertCadence"
            className="field"
            disabled={channel === 'none'}
            defaultValue={
              group?.alert.cadence && group.alert.cadence !== 'off' ? group.alert.cadence : 'instant'
            }
          >
            <option value="instant">Instant</option>
            <option value="hourly">Hourly</option>
            <option value="daily">Daily digest</option>
          </select>
        </label>
        {channel !== 'none' ? (
          <label className="flex flex-col gap-1 font-medium">
            {channel === 'slack' ? 'Slack channel' : 'Email to'}
            <input
              name="alertTarget"
              className="field"
              defaultValue={group?.alert.target}
              placeholder={channel === 'slack' ? '#reddit' : 'jane@acme.so'}
            />
          </label>
        ) : (
          <input type="hidden" name="alertCadence" value="instant" />
        )}
        <label className="flex flex-col gap-1 font-medium">
          Agent
          <select name="agentId" className="field" defaultValue={group?.agent?.id ?? ''}>
            <option value="">None</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Saving…' : group ? 'Save group' : 'Create group'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        {state.error ? (
          <span role="alert" className="text-xs text-bad">
            {state.error}
          </span>
        ) : null}
        <div className="flex-1" />
        {group ? (
          <button
            type="submit"
            formAction={deleteKeywordGroup}
            formNoValidate
            className="btn btn-ghost !text-bad"
            onClick={(e) => {
              if (!confirm(`Delete “${group.name}”? Its opportunities stay.`)) e.preventDefault();
            }}
          >
            Delete
          </button>
        ) : null}
      </div>
    </form>
  );
}
