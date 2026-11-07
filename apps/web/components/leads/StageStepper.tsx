'use client';

import { moveStage } from '@/lib/actions/leads';
import { LEAD_STAGE_LABEL, LeadStage } from '@threadline/shared';
import { useRouter } from 'next/navigation';
import { useState, useTransition } from 'react';

/** Pill stepper; click a stage to move the lead there (editors and above). */
export function StageStepper({
  leadId,
  stage: initial,
  canEdit,
}: { leadId: string; stage: LeadStage; canEdit: boolean }) {
  const router = useRouter();
  const [stage, setStage] = useState(initial);
  const [error, setError] = useState<string | null>(null);
  const [pending, start] = useTransition();
  const go = (s: LeadStage) => {
    if (s === stage) return;
    const prev = stage;
    setStage(s);
    setError(null);
    start(async () => {
      const r = await moveStage({ leadId, stage: s });
      if (!r.ok) {
        setStage(prev);
        setError(r.error);
      } else router.refresh();
    });
  };
  return (
    <div className="flex flex-col gap-1.5">
      <div
        role="group"
        aria-label="Stage"
        className="flex flex-wrap items-center overflow-hidden rounded-full border border-line bg-surface"
      >
        {LeadStage.map((s) => {
          const on = s === stage;
          return (
            <button
              key={s}
              type="button"
              aria-pressed={on}
              disabled={!canEdit || pending}
              onClick={() => go(s)}
              className={`flex h-[30px] items-center border-r border-line-soft px-3 text-[12.5px] font-medium last:border-r-0 disabled:cursor-default ${on ? 'bg-inverse text-inverse-ink' : 'text-muted hover:enabled:bg-surface-3 hover:enabled:text-ink'}`}
            >
              {LEAD_STAGE_LABEL[s]}
            </button>
          );
        })}
      </div>
      {error ? (
        <p role="alert" className="m-0 text-xs text-bad">
          {error}
        </p>
      ) : null}
    </div>
  );
}
