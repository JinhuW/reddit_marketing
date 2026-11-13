'use client';

import { type KeyState, createApiKeyAction, revokeApiKeyAction } from '@/lib/actions/api-keys';
import { useActionState } from 'react';

function Note({ s }: { s: KeyState | null }) {
  if (!s) return null;
  return (
    <p
      role="status"
      className={`m-0 rounded-[9px] px-3 py-2 text-[12.5px] ${s.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}
    >
      {s.message}
    </p>
  );
}

/** "New key" (plan 0004 phase 7). The key is shown once, in the answer to this form, and nowhere else. */
export function NewApiKey() {
  const [state, act, busy] = useActionState<KeyState | null, FormData>(createApiKeyAction, null);
  return (
    <div className="flex flex-col gap-2.5" data-testid="new-api-key">
      <form action={act} className="flex flex-wrap items-center gap-2">
        <label htmlFor="key-name" className="sr-only">
          Key name
        </label>
        <input
          id="key-name"
          name="name"
          className="field !h-[30px] max-w-[280px] flex-1"
          placeholder="What will use this key? e.g. inventory script"
          maxLength={60}
          required
        />
        <button type="submit" className="btn btn-primary !h-[30px]" disabled={busy}>
          {busy ? 'Creating…' : 'Create key'}
        </button>
      </form>
      <Note s={state} />
      {state?.key ? (
        <div className="flex flex-col gap-1">
          <label htmlFor="key-value" className="text-xs font-semibold">
            Your new key
          </label>
          <input
            id="key-value"
            readOnly
            value={state.key}
            className="field num font-mono text-[12px]"
            onFocus={(e) => e.currentTarget.select()}
            data-testid="api-key-value"
          />
        </div>
      ) : null}
    </div>
  );
}

export function RevokeApiKey({ id, name }: { id: string; name: string }) {
  const [state, act, busy] = useActionState<KeyState | null, FormData>(revokeApiKeyAction, null);
  return (
    <form action={act} className="inline">
      <input type="hidden" name="id" value={id} />
      <button
        type="submit"
        className="btn btn-ghost !h-[26px] !px-2 text-bad"
        disabled={busy}
        aria-label={`Revoke ${name}`}
        title={state && !state.ok ? state.message : undefined}
      >
        Revoke
      </button>
    </form>
  );
}
