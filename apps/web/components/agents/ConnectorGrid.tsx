'use client';

import { type ActionState, saveConnector } from '@/lib/actions/agents';
import type { ConnectorProvider, ConnectorStatus } from '@threadline/shared';
import { useActionState } from 'react';
import { FormMessage } from './FormMessage';

const META: Record<ConnectorProvider, { name: string; desc: string; tools: string[] }> = {
  notion: { name: 'Notion', desc: 'Import pages as context', tools: ['search', 'read_page'] },
  gdrive: { name: 'Google Drive', desc: 'Import docs as context', tools: ['search', 'read_file'] },
  hubspot: {
    name: 'HubSpot',
    desc: 'Sync leads and stages',
    tools: ['read_contact', 'upsert_contact', 'add_note'],
  },
  attio: { name: 'Attio', desc: 'CRM sync', tools: [] },
  slack: { name: 'Slack', desc: 'Alerts and approvals', tools: [] },
  ga4: { name: 'GA4', desc: 'Site analytics', tools: [] },
  posthog: { name: 'PostHog', desc: 'Product analytics', tools: [] },
  stripe: { name: 'Stripe', desc: 'Revenue attribution', tools: [] },
  calendly: { name: 'Calendly', desc: 'Demo booking links', tools: [] },
};

export function ConnectorGrid({
  agentId,
  connectors,
  canEdit,
}: {
  agentId: string;
  connectors: { provider: ConnectorProvider; status: ConnectorStatus; tools: string[] }[];
  canEdit: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 p-[18px] sm:grid-cols-2 xl:grid-cols-3">
      {connectors.map((c) => (
        <Tile key={c.provider} agentId={agentId} c={c} canEdit={canEdit} />
      ))}
    </div>
  );
}

function Tile({
  agentId,
  c,
  canEdit,
}: {
  agentId: string;
  c: { provider: ConnectorProvider; status: ConnectorStatus; tools: string[] };
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveConnector, {});
  const m = META[c.provider];
  const soon = c.status === 'coming_soon';
  const on = c.status === 'connected';
  return (
    <form
      action={action}
      data-testid={`connector-${c.provider}`}
      className={`flex flex-col gap-2.5 rounded-card border p-3.5 text-[13px] ${soon ? 'border-dashed border-line' : on ? 'border-ink' : 'border-line'}`}
    >
      <input type="hidden" name="agentId" value={agentId} />
      <input type="hidden" name="provider" value={c.provider} />
      <div className="flex items-center gap-2">
        <span className="font-semibold">{m.name}</span>
        <span className={`chip ml-auto ${soon ? 'chip-mid' : on ? 'chip-ok' : 'chip-line'}`}>
          {soon ? 'Coming soon' : on ? 'Connected' : 'Off'}
        </span>
      </div>
      <div className="muted text-xs">{m.desc}</div>
      {soon ? null : (
        <fieldset disabled={!canEdit || pending} className="flex flex-col gap-2">
          <label className="flex items-center gap-2 text-[12.5px] font-medium">
            <input type="checkbox" name="connected" defaultChecked={on} className="accent-[var(--ink)]" />
            Allow this agent to use {m.name}
          </label>
          <div className="flex flex-col gap-1 pl-5">
            {m.tools.map((t) => (
              <label key={t} className="flex items-center gap-2 text-xs text-ink-2">
                <input
                  type="checkbox"
                  name="tools"
                  value={t}
                  defaultChecked={on ? c.tools.includes(t) : true}
                  className="accent-[var(--ink)]"
                />
                <code className="text-[11.5px]">{t}</code>
              </label>
            ))}
          </div>
          {canEdit ? (
            <button type="submit" className="btn self-start !h-7">
              Save
            </button>
          ) : null}
        </fieldset>
      )}
      <FormMessage state={state} />
    </form>
  );
}
