'use client';

import { addNote } from '@/lib/actions/leads';
import { useActionState, useEffect, useRef } from 'react';
import { shortDate } from './format';

export function Notes({
  leadId,
  notes,
  canEdit,
}: {
  leadId: string;
  notes: { by: string; at: string; body: string }[];
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState(addNote, null);
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) form.current?.reset();
  }, [state]);
  return (
    <section className="panel">
      <div className="sect-h">
        <h2>Notes</h2>
      </div>
      <div className="flex flex-col gap-2.5 px-[18px] py-3.5 text-[13px]">
        {notes.length === 0 ? <p className="muted m-0">No notes yet.</p> : null}
        {[...notes].reverse().map((n, i) => (
          <div key={`${n.at}-${i}`} className="rounded-[10px] bg-surface-2 px-3 py-2.5 leading-normal">
            <div className="muted mb-0.5 text-[11.5px]">
              {n.by.split(' ')[0]} · {shortDate(new Date(n.at))}
            </div>
            <div className="whitespace-pre-wrap">{n.body}</div>
          </div>
        ))}
        {canEdit ? (
          <form ref={form} action={action} className="flex flex-col gap-2">
            <input type="hidden" name="leadId" value={leadId} />
            <textarea
              name="body"
              aria-label="Add a note"
              placeholder="Add a note"
              required
              className="field !h-auto min-h-14 resize-y !py-2.5"
            />
            <div className="flex items-center gap-2">
              {state && !state.ok ? (
                <span role="alert" className="text-xs text-bad">
                  {state.error}
                </span>
              ) : null}
              <div className="flex-1" />
              <button type="submit" className="btn !h-7" disabled={pending}>
                Save note
              </button>
            </div>
          </form>
        ) : null}
      </div>
    </section>
  );
}
