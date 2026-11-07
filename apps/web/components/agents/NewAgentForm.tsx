'use client';

import { type ActionState, createAgent } from '@/lib/actions/agents';
import Link from 'next/link';
import { useActionState } from 'react';
import { FormMessage } from './FormMessage';

export function NewAgentForm({ atLimit, limitMessage }: { atLimit: boolean; limitMessage: string }) {
  const [state, action, pending] = useActionState<ActionState, FormData>(createAgent, {});
  return (
    <section className="panel" aria-labelledby="new-agent-h">
      <div className="sect-h">
        <h2 id="new-agent-h">New agent</h2>
        <span className="muted text-xs">Starts paused. Drafts always go to an approver.</span>
        <div className="flex-1" />
        <Link href="/agents" className="btn btn-ghost !h-7">
          Cancel
        </Link>
      </div>
      {atLimit ? (
        <p role="alert" className="m-[18px] rounded-[9px] bg-warn-soft px-3 py-2 text-[13px] text-warn">
          {limitMessage}
        </p>
      ) : null}
      <form action={action} className="grid grid-cols-1 gap-4 p-[18px] md:grid-cols-3">
        <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
          Name
          <input name="name" className="field !h-9 font-normal" required maxLength={40} placeholder="Nora" />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
          Role title
          <input
            name="roleTitle"
            className="field !h-9 font-normal"
            required
            maxLength={80}
            placeholder="Integrations Expert"
          />
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
          Focus
          <input
            name="focus"
            className="field !h-9 font-normal"
            maxLength={160}
            placeholder="Zapier and API questions"
          />
        </label>
        <div className="flex items-center gap-3 md:col-span-3">
          <button type="submit" className="btn btn-primary" disabled={pending}>
            Create agent
          </button>
          <FormMessage state={state} />
        </div>
      </form>
    </section>
  );
}
