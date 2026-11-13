'use client';

import { saveNotesAction } from '@/lib/actions/browser-list';
import { useActionState, useEffect, useState } from 'react';
import type { ActionState } from './action-state';

/** Quick edit of a browser's notes right in the list (plan 0004). Enter saves, Escape cancels. */
export function NotesCell({ id, notes, canEdit }: { id: string; notes: string; canEdit: boolean }) {
  const [editing, setEditing] = useState(false);
  const [state, act, saving] = useActionState<ActionState | null, FormData>(saveNotesAction, null);
  useEffect(() => {
    if (state?.ok) setEditing(false);
  }, [state]);

  if (!editing)
    return (
      <span className="flex max-w-[220px] items-center gap-1">
        <span className={`truncate ${notes ? '' : 'muted'}`} title={notes || undefined}>
          {notes || '—'}
        </span>
        {canEdit ? (
          <button
            type="button"
            className="btn btn-ghost !h-[22px] !px-1.5 text-[11.5px]"
            onClick={() => setEditing(true)}
            aria-label="Edit notes"
          >
            Edit
          </button>
        ) : null}
      </span>
    );
  return (
    <form action={act} className="flex items-center gap-1">
      <input type="hidden" name="profileId" value={id} />
      <input
        name="notes"
        className="field !h-[26px] w-[200px]"
        defaultValue={notes}
        maxLength={2000}
        // biome-ignore lint/a11y/noAutofocus: the person just asked to edit this field
        autoFocus
        aria-label="Notes"
        aria-invalid={state && !state.ok ? true : undefined}
        title={state && !state.ok ? state.message : undefined}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setEditing(false);
        }}
      />
      <button type="submit" className="btn !h-[26px] !px-2" disabled={saving}>
        Save
      </button>
    </form>
  );
}
