'use client';

import { type ActionState, saveAssignment } from '@/lib/actions/agents';
import { useActionState } from 'react';
import { FormMessage } from './FormMessage';

export function AssignmentForm({
  agentId,
  value,
  options,
  canEdit,
}: {
  agentId: string;
  value: {
    accountId: string | null;
    approverMemberId: string | null;
    dailyDraftLimit: number;
    status: 'active' | 'paused';
  };
  options: {
    accounts: { id: string; username: string }[];
    approvers: { id: string; user: { name: string | null; email: string } }[];
    groups: { id: string; name: string; agentId: string | null; owner: string | null }[];
  };
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState, FormData>(saveAssignment, {});
  return (
    <form action={action} className="grid grid-cols-1 gap-x-6 gap-y-[18px] p-[18px] md:grid-cols-2">
      <input type="hidden" name="agentId" value={agentId} />
      <fieldset disabled={!canEdit || pending} className="contents">
        <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
          Posting account
          <select name="accountId" className="field !h-9 font-normal" defaultValue={value.accountId ?? ''}>
            <option value="">No account</option>
            {options.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                u/{a.username}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
          Approver
          <select
            name="approverMemberId"
            className="field !h-9 font-normal"
            defaultValue={value.approverMemberId ?? ''}
          >
            <option value="">Any approver</option>
            {options.approvers.map((m) => (
              <option key={m.id} value={m.id}>
                {m.user.name ?? m.user.email}
              </option>
            ))}
          </select>
          <span className="muted text-xs font-normal">Only members who can approve are listed.</span>
        </label>
        <label className="flex flex-col gap-1.5 text-[12.5px] font-semibold">
          Daily draft limit
          <input
            name="dailyDraftLimit"
            type="number"
            min={1}
            max={200}
            defaultValue={value.dailyDraftLimit}
            className="field !h-9 font-normal"
          />
        </label>
        <fieldset className="flex flex-col gap-1.5">
          <legend className="mb-1.5 text-[12.5px] font-semibold">Status</legend>
          <div className="flex gap-4 text-[13px]">
            {(['active', 'paused'] as const).map((s) => (
              <label key={s} className="flex items-center gap-2">
                <input
                  type="radio"
                  name="status"
                  value={s}
                  defaultChecked={value.status === s}
                  className="accent-[var(--ink)]"
                />
                {s === 'active' ? 'Active' : 'Paused'}
              </label>
            ))}
          </div>
        </fieldset>
        <fieldset className="flex flex-col gap-1.5 md:col-span-2">
          <legend className="mb-1.5 text-[12.5px] font-semibold">Keyword groups this agent handles</legend>
          <div className="grid grid-cols-1 gap-1.5 text-[13px] sm:grid-cols-2">
            {options.groups.map((g) => (
              <label key={g.id} className="flex items-center gap-2">
                <input
                  type="checkbox"
                  name="keywordGroupIds"
                  value={g.id}
                  defaultChecked={g.agentId === agentId}
                  className="accent-[var(--ink)]"
                />
                {g.name}
                {g.agentId && g.agentId !== agentId ? (
                  <span className="muted text-xs">· currently {g.owner}</span>
                ) : null}
              </label>
            ))}
          </div>
        </fieldset>
      </fieldset>
      <div className="flex items-center gap-3 md:col-span-2">
        {canEdit ? (
          <button type="submit" className="btn btn-primary" disabled={pending}>
            Save assignment
          </button>
        ) : (
          <span className="muted text-xs">Only admins can change assignments.</span>
        )}
        <FormMessage state={state} />
      </div>
    </form>
  );
}
