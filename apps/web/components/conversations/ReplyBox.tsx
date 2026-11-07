'use client';

import { Avatar } from '@/components/ui/avatar';
import { askAgentToDraft } from '@/lib/actions/conversations';
import { useActionState } from 'react';

export function ReplyBox({
  conversationId,
  agent,
  account,
  canDraft,
}: {
  conversationId: string;
  agent: { name: string; color: string } | null;
  account: string | null;
  canDraft: boolean;
}) {
  const [state, action, pending] = useActionState(askAgentToDraft, null);
  return (
    <form action={action} className="flex flex-col gap-2.5 border-t border-line-soft px-4 py-3.5">
      <input type="hidden" name="conversationId" value={conversationId} />
      <textarea
        name="instruction"
        aria-label="What should the reply say?"
        placeholder={
          agent
            ? `Tell ${agent.name} what the reply should cover (optional)…`
            : 'Assign an agent to this lead to draft replies'
        }
        disabled={!canDraft}
        className="field !h-auto min-h-[72px] resize-y !rounded-[12px] !px-3 !py-2.5 text-[13.5px] leading-normal"
      />
      {state ? (
        <p
          role={state.ok ? 'status' : 'alert'}
          className={`m-0 rounded-[9px] px-3 py-2 text-[13px] ${state.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}
        >
          {state.ok ? state.message : state.error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        <span className="muted text-xs">
          {account ? (
            <>
              Sends as <b className="font-medium text-ink">u/{account}</b> · goes to Approvals first
            </>
          ) : (
            'Every reply goes to Approvals first'
          )}
        </span>
        <div className="flex-1" />
        <button type="submit" className="btn btn-primary ml-auto" disabled={!canDraft || !agent || pending}>
          {agent ? <Avatar name={agent.name} label={agent.name[0]} color={agent.color} size={16} /> : null}
          {pending ? 'Queuing…' : `Ask ${agent?.name ?? 'agent'} to draft`}
        </button>
      </div>
    </form>
  );
}
