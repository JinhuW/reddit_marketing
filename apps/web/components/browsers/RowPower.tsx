'use client';

import { startProfileAction, stopProfileAction } from '@/lib/actions/browsers';
import { useActionState } from 'react';
import type { ActionState } from './action-state';

/** Start / Stop for one row of the list (plan 0004). A refusal (no node, node offline) shows as the tooltip. */
export function RowPower({ id, running }: { id: string; running: boolean }) {
  const [state, act, busy] = useActionState<ActionState | null, FormData>(
    running ? stopProfileAction : startProfileAction,
    null,
  );
  const failed = state && !state.ok;
  return (
    <form action={act} className="inline">
      <input type="hidden" name="profileId" value={id} />
      <button
        type="submit"
        className={`btn !h-[26px] !px-2 ${failed ? 'text-bad' : ''}`}
        disabled={busy}
        title={state?.message}
      >
        {busy ? '…' : running ? 'Stop' : 'Start'}
      </button>
      {failed ? (
        <span role="alert" className="sr-only">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}
