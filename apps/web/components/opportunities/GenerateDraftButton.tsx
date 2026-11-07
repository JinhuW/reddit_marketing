'use client';

import { generateDraft } from '@/lib/actions/opportunities';
import { useState, useTransition } from 'react';

export function GenerateDraftButton({ id, disabled }: { id: string; disabled?: boolean }) {
  const [pending, start] = useTransition();
  const [error, setError] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      <button
        type="button"
        className="btn btn-primary !h-[38px] !text-sm"
        disabled={disabled || pending}
        onClick={() =>
          start(async () => {
            setError(null);
            const r = await generateDraft(id);
            if (r && !r.ok) setError(r.error);
          })
        }
      >
        {pending ? 'Requesting draft…' : 'Generate draft'}
      </button>
      {error ? (
        <p role="alert" className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
