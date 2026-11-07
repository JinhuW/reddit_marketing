'use client';

import { Avatar } from '@/components/ui/avatar';
import { changeRoleAction, inviteMemberAction } from '@/lib/actions/settings';
import { MemberRole, ROLE_LABEL } from '@threadline/shared';
import { useActionState, useState } from 'react';
import type { ActionState } from './action-state';

export interface TeamRow {
  id: string;
  name: string;
  email: string;
  role: MemberRole;
  canApprove: boolean;
  account: string | null;
  lastActive: string;
}

function Status({ s }: { s: ActionState | null }) {
  if (!s) return null;
  return (
    <p
      role={s.ok ? 'status' : 'alert'}
      className={`m-0 rounded-[9px] px-3 py-2 text-[12.5px] ${s.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}
    >
      {s.message}
    </p>
  );
}

function RoleCell({ m, isAdmin }: { m: TeamRow; isAdmin: boolean }) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(changeRoleAction, null);
  if (!isAdmin) return <span className="chip chip-line">{ROLE_LABEL[m.role]}</span>;
  return (
    <form action={action} className="flex items-center gap-1.5">
      <input type="hidden" name="memberId" value={m.id} />
      <select
        name="role"
        aria-label={`Role for ${m.name}`}
        defaultValue={m.role}
        disabled={pending}
        className="field !h-7 !w-auto !px-2 !text-xs"
        onChange={(e) => e.currentTarget.form?.requestSubmit()}
      >
        {MemberRole.map((r) => (
          <option key={r} value={r}>
            {ROLE_LABEL[r]}
          </option>
        ))}
      </select>
      {state && !state.ok ? (
        <span role="alert" className="text-xs text-bad">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

export function TeamTable({ rows, isAdmin }: { rows: TeamRow[]; isAdmin: boolean }) {
  const [inviting, setInviting] = useState(false);
  const [invite, inviteAction, invitingPending] = useActionState<ActionState | null, FormData>(
    inviteMemberAction,
    null,
  );
  return (
    <section className="panel" aria-labelledby="team-h">
      <div className="sect-h">
        <h2 id="team-h">Team and roles</h2>
        <span className="muted text-xs">{rows.length} members · Approver is required to post anything</span>
        <div className="flex-1" />
        {isAdmin ? (
          <button
            type="button"
            className="btn"
            aria-expanded={inviting}
            onClick={() => setInviting((v) => !v)}
          >
            Invite member
          </button>
        ) : null}
      </div>
      {isAdmin && inviting ? (
        <form
          action={inviteAction}
          className="flex flex-wrap items-end gap-2 border-b border-line-soft px-[18px] py-3"
        >
          <label className="flex min-w-[220px] flex-1 flex-col gap-1 text-xs font-semibold">
            Email
            <input name="email" type="email" required className="field" placeholder="name@company.com" />
          </label>
          <div className="flex flex-col gap-1 text-xs font-semibold">
            <label htmlFor="invite-role">Role</label>
            <select id="invite-role" name="role" defaultValue="editor" className="field !w-auto">
              {MemberRole.map((r) => (
                <option key={r} value={r}>
                  {ROLE_LABEL[r]}
                </option>
              ))}
            </select>
          </div>
          <button type="submit" className="btn btn-primary !h-[34px]" disabled={invitingPending}>
            Send invite
          </button>
          <div className="basis-full">
            <Status s={invite} />
          </div>
        </form>
      ) : null}
      <div className="overflow-x-auto px-2 pt-1 pb-1.5">
        <table className="tbl" data-testid="team-table">
          <thead>
            <tr>
              <th>Member</th>
              <th>Role</th>
              <th>Can approve</th>
              <th>Reddit account</th>
              <th>Last active</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((m) => (
              <tr key={m.id}>
                <td>
                  <div className="flex items-center gap-2">
                    <Avatar name={m.name} size={24} />
                    <div className="leading-tight">
                      <div className="font-medium">{m.name}</div>
                      <div className="muted text-[11.5px]">{m.email}</div>
                    </div>
                  </div>
                </td>
                <td>
                  <RoleCell m={m} isAdmin={isAdmin} />
                </td>
                <td>
                  <span className={`chip ${m.canApprove ? 'chip-ok' : 'chip-mid'}`}>
                    {m.canApprove ? 'Yes' : 'No'}
                  </span>
                </td>
                <td className="muted">{m.account ? `u/${m.account}` : '—'}</td>
                <td className="muted whitespace-nowrap">{m.lastActive}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
