'use client';

import { startSessionAction } from '@/lib/actions/browsers';
import { useActionState } from 'react';
import type { ActionState } from './action-state';

export function TakeoverForm({
  profileId,
  agentName,
  login = false,
}: { profileId: string; agentName: string | null; login?: boolean }) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(startSessionAction, null);
  return (
    <form action={action} className="flex flex-col gap-2.5 px-[18px] py-3.5 text-[12.5px]">
      <input type="hidden" name="profileId" value={profileId} />
      {login ? <input type="hidden" name="login" value="1" /> : null}
      <label htmlFor="reason" className="font-semibold">
        Why are you taking over?
      </label>
      <textarea
        id="reason"
        name="reason"
        required
        minLength={3}
        rows={3}
        className="field !h-auto py-2"
        defaultValue={login ? 'Sign in to Reddit' : undefined}
        placeholder="e.g. Reddit asked to verify it’s you"
      />
      {state && !state.ok ? (
        <p role="alert" className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-bad">
          {state.message}
        </p>
      ) : null}
      <button type="submit" className="btn btn-primary" disabled={pending}>
        {pending ? 'Starting…' : `Take control${agentName ? ` · pause ${agentName}` : ''}`}
      </button>
      <p className="muted m-0 text-xs">
        Logged to the audit trail. The agent’s queue for this account pauses until you hand back.
      </p>
    </form>
  );
}
