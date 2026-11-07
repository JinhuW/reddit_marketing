'use client';

import { type ActionState, addContext, removeContext } from '@/lib/actions/agents';
import { useActionState } from 'react';
import { FormMessage } from './FormMessage';

const KIND_LABEL = {
  doc: 'Doc',
  url: 'URL',
  faq: 'FAQ',
  pricing: 'Pricing',
  approved_reply: 'Approved replies',
} as const;

export interface ContextRow {
  id: string;
  kind: keyof typeof KIND_LABEL;
  title: string;
  sourceUrl: string | null;
  fresh: string;
  stale: boolean;
  embedded: boolean;
}

export function ContextList({
  agentId,
  items,
  canEdit,
}: { agentId: string; items: ContextRow[]; canEdit: boolean }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(addContext, {});
  return (
    <div className="flex flex-col">
      <ul className="m-0 list-none p-0">
        {items.length === 0 ? (
          <li className="muted px-[18px] py-6 text-[13px]">No context yet. Add a URL or paste a doc.</li>
        ) : null}
        {items.map((c) => (
          <li
            key={c.id}
            className="flex items-center gap-3 border-b border-line-soft px-[18px] py-3 text-[13px]"
          >
            <span className="chip chip-line w-[112px] justify-center">{KIND_LABEL[c.kind]}</span>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{c.title}</div>
              <div className="muted truncate text-xs">{c.sourceUrl ?? 'Pasted text'}</div>
            </div>
            {c.embedded ? null : <span className="chip chip-mid">Embedding queued</span>}
            <span className={`chip ${c.stale ? 'chip-warn' : 'chip-ok'}`} title="Last refreshed">
              {c.fresh}
            </span>
            {canEdit ? (
              <form action={removeContext}>
                <input type="hidden" name="agentId" value={agentId} />
                <input type="hidden" name="itemId" value={c.id} />
                <button
                  type="submit"
                  className="btn btn-ghost !h-7 !px-2 text-xs"
                  aria-label={`Remove ${c.title}`}
                >
                  Remove
                </button>
              </form>
            ) : null}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <form action={action} className="grid grid-cols-1 gap-3 p-[18px] md:grid-cols-[140px_minmax(0,1fr)]">
          <input type="hidden" name="agentId" value={agentId} />
          <div className="text-[12.5px] font-semibold md:col-span-2">Add context</div>
          <select name="kind" className="field" aria-label="Kind" defaultValue="url">
            {Object.entries(KIND_LABEL).map(([k, l]) => (
              <option key={k} value={k}>
                {l}
              </option>
            ))}
          </select>
          <input
            name="title"
            className="field"
            placeholder="Title, e.g. Pricing page"
            aria-label="Title"
            required
          />
          <input
            name="sourceUrl"
            className="field md:col-span-2"
            placeholder="https://acme.so/docs/…"
            aria-label="Source URL"
          />
          <textarea
            name="content"
            className="field !h-auto min-h-[80px] py-2 md:col-span-2"
            placeholder="…or paste the text of a doc, FAQ or approved reply"
            aria-label="Pasted text"
          />
          <div className="flex items-center gap-3 md:col-span-2">
            <button type="submit" className="btn btn-dark" disabled={pending}>
              Add to knowledge base
            </button>
            <FormMessage state={state} />
          </div>
        </form>
      ) : null}
    </div>
  );
}
