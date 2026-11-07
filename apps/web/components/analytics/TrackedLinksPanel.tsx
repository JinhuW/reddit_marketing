'use client';

import { LINK_MEDIUM_OPTIONS } from '@/components/analytics/constants';
import { type CreateLinkState, createTrackedLink } from '@/lib/actions/analytics';
import { type LinkMedium, buildUtm, fmtInt, withUtm } from '@threadline/shared';
import { type ReactNode, useActionState, useEffect, useMemo, useState } from 'react';

export interface LinkRow {
  id: string;
  short: string;
  destPath: string;
  destination: string;
  full: string;
  medium: string;
  clicks: number;
  conversions: number;
}

export function TrackedLinksPanel({
  links,
  options,
  canEdit,
  children,
}: {
  links: LinkRow[];
  options: {
    subreddits: { id: string; name: string }[];
    agents: { id: string; name: string }[];
    siteUrl: string;
  };
  canEdit: boolean;
  children?: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  return (
    <section className="panel min-w-0">
      <div className="sect-h flex-wrap">
        <h2>Tracked links</h2>
        <span className="muted text-xs">
          {links.length} short link{links.length === 1 ? '' : 's'}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="btn btn-ghost !h-7"
          aria-expanded={open}
          aria-controls="utm-builder"
          onClick={() => setOpen((o) => !o)}
        >
          UTM builder
        </button>
      </div>
      {open ? <UtmBuilder options={options} canEdit={canEdit} /> : null}
      <div className="relative overflow-x-auto px-2 pt-1 pb-1.5">
        <table className="tbl" data-testid="tracked-links">
          <thead>
            <tr>
              <th>Short link</th>
              <th>Destination</th>
              <th>Medium</th>
              <th className="!text-right">Clicks</th>
              <th className="!text-right">Conv.</th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => (
              <tr key={l.id} className="row-hover">
                <td className="font-semibold whitespace-nowrap">{l.short}</td>
                <td className="max-w-[180px] truncate" title={l.full}>
                  {l.destPath}
                </td>
                <td>
                  <span className="chip chip-line">{l.medium}</span>
                </td>
                <td className="text-right">{fmtInt(l.clicks)}</td>
                <td className="text-right">{fmtInt(l.conversions)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {children}
    </section>
  );
}

function UtmBuilder({
  options,
  canEdit,
}: {
  options: {
    subreddits: { id: string; name: string }[];
    agents: { id: string; name: string }[];
    siteUrl: string;
  };
  canEdit: boolean;
}) {
  const [dest, setDest] = useState(`${options.siteUrl.replace(/\/$/, '')}/`);
  const [medium, setMedium] = useState<LinkMedium>('comment');
  const [subId, setSubId] = useState(options.subreddits[0]?.id ?? '');
  const [agentId, setAgentId] = useState(options.agents[0]?.id ?? '');
  const [label, setLabel] = useState('');
  const [state, action, pending] = useActionState<CreateLinkState, FormData>(createTrackedLink, {
    ok: false,
  });
  const subName = options.subreddits.find((s) => s.id === subId)?.name ?? '';
  const agentName = options.agents.find((a) => a.id === agentId)?.name ?? '';

  const preview = useMemo(() => {
    try {
      return withUtm(dest, buildUtm({ medium, subreddit: subName || null, agent: agentName || null }));
    } catch {
      return null;
    }
  }, [dest, medium, subName, agentName]);

  useEffect(() => {
    if (state.ok) setLabel('');
  }, [state]);

  return (
    <form
      id="utm-builder"
      action={action}
      className="flex flex-col gap-3 border-b border-line-soft bg-surface-2 px-[18px] py-3.5 text-[13px]"
      aria-label="UTM builder"
    >
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        <label className="flex flex-col gap-1 font-medium sm:col-span-2">
          Destination URL
          <input
            name="destination"
            className="field"
            type="url"
            required
            value={dest}
            onChange={(e) => setDest(e.target.value)}
          />
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Medium
          <select
            name="medium"
            className="field"
            value={medium}
            onChange={(e) => setMedium(e.target.value as LinkMedium)}
          >
            {LINK_MEDIUM_OPTIONS.map((m) => (
              <option key={m.value} value={m.value}>
                {m.label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Subreddit
          <select
            name="subredditId"
            className="field"
            value={subId}
            onChange={(e) => setSubId(e.target.value)}
          >
            <option value="">None (DM)</option>
            {options.subreddits.map((s) => (
              <option key={s.id} value={s.id}>
                r/{s.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Agent
          <select
            name="agentId"
            className="field"
            value={agentId}
            onChange={(e) => setAgentId(e.target.value)}
          >
            <option value="">None</option>
            {options.agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Display label <span className="muted text-xs font-normal">optional, e.g. pm-6team</span>
          <input name="label" className="field" value={label} onChange={(e) => setLabel(e.target.value)} />
        </label>
      </div>
      <input type="hidden" name="subredditName" value={subName} />
      <input type="hidden" name="agentName" value={agentName} />
      <div className="flex flex-col gap-1">
        <span className="muted text-xs">Preview</span>
        <output
          data-testid="utm-preview"
          className="rounded-[9px] border border-line bg-surface px-2.5 py-2 font-mono text-xs break-all text-ink-2"
        >
          {preview ?? 'Enter a full URL, starting with https://'}
        </output>
      </div>
      <div className="flex items-center gap-2.5">
        {canEdit ? (
          <button type="submit" className="btn btn-primary" disabled={pending || !preview}>
            {pending ? 'Creating…' : 'Create link'}
          </button>
        ) : (
          <span className="muted text-xs">Editors can create links.</span>
        )}
        {state.error ? (
          <span role="alert" className="text-xs text-bad">
            {state.error}
          </span>
        ) : null}
        {state.ok && state.short ? (
          <span role="status" className="text-xs text-ok">
            Created {state.short}
          </span>
        ) : null}
      </div>
    </form>
  );
}
