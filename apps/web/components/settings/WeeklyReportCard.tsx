'use client';

import { saveReportAction } from '@/lib/actions/settings';
import { useActionState } from 'react';
import type { ActionState } from './action-state';

const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];

export function WeeklyReportCard({
  report,
  canEdit,
}: {
  report: { enabled: boolean; day: string; recipients: string[] };
  canEdit: boolean;
}) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(saveReportAction, null);
  const day = report.day.charAt(0).toUpperCase() + report.day.slice(1);
  return (
    <section className="panel" aria-labelledby="rep-h">
      <div className="sect-h">
        <h2 id="rep-h">Weekly report</h2>
      </div>
      <form action={action} className="flex flex-col gap-3 px-[18px] pt-3 pb-3.5 text-[13px]">
        <p className="muted m-0 leading-normal">
          {report.enabled
            ? `Sent ${day}s 8:00 to ${report.recipients.join(', ') || 'nobody yet'}. Covers replies, leads, clicks and revenue for the week.`
            : 'The weekly report is off.'}
        </p>
        <fieldset disabled={!canEdit} className="m-0 flex flex-col gap-3 border-0 p-0">
          <label className="flex items-center gap-2.5">
            <input
              type="checkbox"
              name="enabled"
              defaultChecked={report.enabled}
              className="m-0 h-[15px] w-[15px] accent-[var(--ink)]"
            />
            Send the weekly report
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            Day
            <select name="day" defaultValue={report.day} className="field !w-48">
              {DAYS.map((d) => (
                <option key={d} value={d}>
                  {d.charAt(0).toUpperCase() + d.slice(1)}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs font-semibold">
            Recipients
            <input
              name="recipients"
              defaultValue={report.recipients.join(', ')}
              className="field"
              placeholder="jane@acme.so, leo@acme.so"
            />
          </label>
        </fieldset>
        {state ? (
          <p
            role={state.ok ? 'status' : 'alert'}
            className={`m-0 rounded-[9px] px-3 py-2 text-[12.5px] ${state.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}
          >
            {state.message}
          </p>
        ) : null}
        {canEdit ? (
          <div className="flex gap-2">
            <button type="submit" className="btn" disabled={pending}>
              Save
            </button>
            <span className="muted self-center text-xs">Sending ships with the report job in M5.</span>
          </div>
        ) : (
          <p className="muted m-0 text-xs">Only admins can change the report.</p>
        )}
      </form>
    </section>
  );
}
