'use client';

import { type ActionState, savePersona } from '@/lib/actions/agents';
import type { AgentPersona } from '@threadline/db/repos/agents';
import { useActionState, useState } from 'react';
import { FormMessage } from './FormMessage';

const SLIDERS = [
  { key: 'formal', low: 'Casual', high: 'Formal' },
  { key: 'concise', low: 'Detailed', high: 'Concise' },
  { key: 'playful', low: 'Earnest', high: 'Playful' },
  { key: 'technical', low: 'Plain', high: 'Technical' },
] as const;

export function PersonaForm({
  agentId,
  name,
  roleTitle,
  persona,
  accountDisclosure,
  canEdit,
}: {
  agentId: string;
  name: string;
  roleTitle: string;
  persona: AgentPersona;
  accountDisclosure: string | null;
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(savePersona, {});
  return (
    <form
      id="persona-form"
      action={action}
      className="grid grid-cols-1 gap-x-6 gap-y-[18px] p-[18px] md:grid-cols-2"
    >
      <input type="hidden" name="agentId" value={agentId} />
      <fieldset disabled={!canEdit || pending} className="contents">
        <Field label="Name" htmlFor="p-name">
          <input id="p-name" name="name" className="field !h-9" defaultValue={name} required maxLength={40} />
        </Field>
        <Field label="Role title" htmlFor="p-role">
          <input
            id="p-role"
            name="roleTitle"
            className="field !h-9"
            defaultValue={roleTitle}
            required
            maxLength={80}
          />
        </Field>
        <Field label="Role" htmlFor="p-focus" wide>
          <input
            id="p-focus"
            name="focus"
            className="field !h-9"
            defaultValue={persona.focus ?? ''}
            maxLength={160}
            placeholder="Product expert who answers comparison questions for teams under 10"
          />
        </Field>
        <div className="flex flex-col gap-1.5 text-[13px]">
          <span className="text-[12.5px] font-semibold">Voice and tone</span>
          {SLIDERS.map((s) => (
            <div
              key={s.key}
              className="grid grid-cols-[80px_minmax(0,1fr)_80px] items-center gap-2.5 text-xs text-muted"
            >
              <span>{s.low}</span>
              <input
                type="range"
                name={s.key}
                min={0}
                max={100}
                defaultValue={persona.voice?.[s.key] ?? 50}
                aria-label={`${s.low} to ${s.high}`}
                className="m-0 w-full accent-[var(--ink)]"
              />
              <span className="text-right">{s.high}</span>
            </div>
          ))}
        </div>
        <Field label="Disclosure line" htmlFor="p-disc">
          <input
            id="p-disc"
            name="disclosure"
            className="field !h-9"
            defaultValue={persona.disclosure ?? ''}
            maxLength={200}
          />
          <span className="muted text-xs">
            Added to every reply · the rule check uses the posting account’s line
            {accountDisclosure ? ` (“${accountDisclosure}”)` : ''} and fails without it
          </span>
        </Field>
        <ListEditor
          label="Do"
          name="dos"
          tone="ok"
          initial={persona.dos ?? []}
          placeholder="Answer the exact needs OP listed"
        />
        <ListEditor
          label="Don’t"
          name="donts"
          tone="bad"
          initial={persona.donts ?? []}
          placeholder="Make pricing claims about competitors"
        />
        <div className="flex flex-col gap-1.5 md:col-span-2">
          <ListEditor
            label="Sample replies"
            name="samples"
            tone="sample"
            initial={persona.samples ?? []}
            placeholder="Paste a reply the team approved"
          />
        </div>
      </fieldset>
      <div className="flex items-center gap-3 md:col-span-2">
        <FormMessage state={state} />
        {!canEdit ? <span className="muted text-xs">Viewers can’t edit agents.</span> : null}
      </div>
    </form>
  );
}

function Field({
  label,
  htmlFor,
  wide,
  children,
}: { label: string; htmlFor: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`flex flex-col gap-1.5 text-[13px] ${wide ? 'md:col-span-2' : ''}`}>
      <label htmlFor={htmlFor} className="text-[12.5px] font-semibold">
        {label}
      </label>
      {children}
    </div>
  );
}

function ListEditor({
  label,
  name,
  tone,
  initial,
  placeholder,
}: {
  label: string;
  name: string;
  tone: 'ok' | 'bad' | 'sample';
  initial: string[];
  placeholder: string;
}) {
  const [items, setItems] = useState(initial);
  const [draft, setDraft] = useState('');
  const add = () => {
    const v = draft.trim();
    if (v) setItems([...items, v]);
    setDraft('');
  };
  const chip = tone === 'ok' ? 'chip-ok' : 'chip-bad';
  return (
    <div className="flex flex-col gap-1.5 text-[13px]">
      <span className="text-[12.5px] font-semibold">{label}</span>
      <ul className="m-0 flex list-none flex-col gap-1.5 p-0 text-ink-2">
        {items.map((it, i) => (
          <li
            key={`${i}-${it}`}
            className={
              tone === 'sample'
                ? 'flex gap-2 rounded-card bg-surface-2 px-3.5 py-3 leading-relaxed'
                : 'flex items-start gap-2'
            }
          >
            <input type="hidden" name={name} value={it} />
            {tone === 'sample' ? null : (
              <span className={`chip ${chip} mt-0.5 !h-[18px] !px-1.5`}>{label}</span>
            )}
            <span className="flex-1">{tone === 'sample' ? `“${it}”` : it}</span>
            <button
              type="button"
              className="btn btn-ghost !h-6 !px-1.5 text-xs"
              aria-label={`Remove “${it.slice(0, 40)}”`}
              onClick={() => setItems(items.filter((_, j) => j !== i))}
            >
              Remove
            </button>
          </li>
        ))}
      </ul>
      <div className="flex gap-2">
        <input
          className="field"
          value={draft}
          placeholder={placeholder}
          aria-label={`Add to ${label}`}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              add();
            }
          }}
        />
        <button type="button" className="btn" onClick={add}>
          Add
        </button>
      </div>
    </div>
  );
}
