'use client';

import { type PlaygroundState, runPlayground } from '@/lib/actions/agents';
import { useActionState } from 'react';

export function TestAgentPanel({
  agentId,
  agentName,
  samplePost,
}: { agentId: string; agentName: string; samplePost: string }) {
  const [state, action, pending] = useActionState<PlaygroundState, FormData>(runPlayground, {});
  return (
    <aside className="panel flex flex-col">
      <div className="flex items-center gap-2 border-b border-line-soft px-[18px] py-3.5">
        <h2 className="m-0 text-sm font-semibold">Test the agent</h2>
        <span className="muted text-xs">Nothing here is posted</span>
      </div>
      <form action={action} className="flex flex-col gap-3 px-[18px] py-4 text-[13px]">
        <input type="hidden" name="agentId" value={agentId} />
        <label htmlFor="tp" className="text-[12.5px] font-semibold">
          Paste a Reddit post
        </label>
        <textarea
          id="tp"
          name="post"
          defaultValue={samplePost}
          className="field !h-auto min-h-[84px] resize-y py-2.5 leading-normal"
        />
        <button type="submit" className="btn self-start" disabled={pending}>
          {pending ? 'Assembling…' : `Draft as ${agentName}`}
        </button>
        {state.error ? (
          <p role="alert" className="m-0 text-[12.5px] text-bad">
            {state.error}
          </p>
        ) : null}
        {state.systemPrompt ? (
          <div
            className="flex flex-col gap-2 rounded-card border border-line-soft px-3.5 py-3"
            data-testid="playground-result"
          >
            <p role="status" className="m-0 rounded-[9px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
              {state.message}
            </p>
            <div className="text-xs font-semibold">System prompt</div>
            <pre className="m-0 max-h-[360px] overflow-auto whitespace-pre-wrap text-[12px] leading-normal text-ink-2">
              {state.systemPrompt}
            </pre>
          </div>
        ) : null}
      </form>
    </aside>
  );
}
