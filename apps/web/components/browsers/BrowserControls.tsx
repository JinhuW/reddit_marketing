'use client';

import {
  assignNodeAction,
  resumeAccountAction,
  startProfileAction,
  stopProfileAction,
} from '@/lib/actions/browsers';
import Link from 'next/link';
import { useActionState } from 'react';
import { Dot } from './ProfileTable';
import type { ActionState } from './action-state';
import type { ProfileView } from './view';

function Msg({ s }: { s: ActionState | null }) {
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

/**
 * Node, live status, pause reason and Start / Stop / Open browser for one profile (plan 0001 T30). Not on the
 * artboard: kept to one block of rows and buttons above the proxy settings.
 */
export function BrowserControls({
  p,
  canEdit,
  isAdmin,
  nodeOptions,
}: {
  p: ProfileView;
  canEdit: boolean;
  isAdmin: boolean;
  nodeOptions: { id: string; label: string }[];
}) {
  const [assign, assignAct, assigning] = useActionState<ActionState | null, FormData>(assignNodeAction, null);
  const [resume, resumeAct, resuming] = useActionState<ActionState | null, FormData>(
    resumeAccountAction,
    null,
  );
  const [start, startAct, starting] = useActionState<ActionState | null, FormData>(startProfileAction, null);
  const [stop, stopAct, stopping] = useActionState<ActionState | null, FormData>(stopProfileAction, null);

  return (
    <section
      className="flex flex-col gap-2.5 border-b border-line-soft px-[18px] py-4 text-[12.5px]"
      aria-label="Browser"
      data-testid="browser-controls"
    >
      <div className="flex flex-wrap items-center gap-2 font-semibold">
        Browser
        <span className={`chip ${p.status.chip}`}>
          <Dot color={p.status.dot} />
          {p.status.label}
        </span>
        {p.paused ? (
          <span className="chip chip-warn" data-testid="pause-chip">
            Paused · {p.paused.label}
          </span>
        ) : null}
      </div>

      <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5">
        <span className="text-muted">Node</span>
        {isAdmin ? (
          <form action={assignAct} className="flex items-center gap-2">
            <input type="hidden" name="profileId" value={p.id} />
            <select
              name="nodeId"
              aria-label="Assign node"
              className="field !h-[28px] min-w-0 flex-1"
              defaultValue={p.node.id ?? ''}
            >
              {nodeOptions.map((o) => (
                <option key={o.id} value={o.id}>
                  {o.label}
                </option>
              ))}
            </select>
            <button type="submit" className="btn btn-ghost !h-[26px] !px-2" disabled={assigning}>
              Assign
            </button>
          </form>
        ) : (
          <span className="font-medium">{p.node.name}</span>
        )}
        <span className="text-muted">Node status</span>
        <span>
          <span className={`chip ${p.node.chip}`} data-testid="node-chip">
            {p.node.label}
          </span>
        </span>
      </div>
      <Msg s={assign} />

      {p.paused ? (
        <form
          action={resumeAct}
          className="flex flex-wrap items-center gap-2 rounded-[9px] bg-warn-soft px-3 py-2 text-xs text-warn"
        >
          <input type="hidden" name="profileId" value={p.id} />
          <span className="flex-1">
            Posting from {p.account} is paused: {p.paused.label.toLowerCase()}.
          </span>
          {isAdmin ? (
            <button type="submit" className="btn !h-[26px] !px-2" disabled={resuming}>
              Resume
            </button>
          ) : null}
        </form>
      ) : null}
      <Msg s={resume} />

      {!p.signedIn ? (
        <p className="m-0 rounded-[9px] bg-surface-2 px-3 py-2 text-xs">
          Nobody has signed in to Reddit in this browser yet.{' '}
          {canEdit ? (
            <Link href={`/browsers/${p.id}/session?login=1`} className="font-semibold underline">
              Sign in now
            </Link>
          ) : null}
        </p>
      ) : null}

      {canEdit ? (
        <div className="flex flex-wrap items-center gap-2">
          <form action={startAct}>
            <input type="hidden" name="profileId" value={p.id} />
            <button type="submit" className="btn !h-7" disabled={starting}>
              Start
            </button>
          </form>
          <form action={stopAct}>
            <input type="hidden" name="profileId" value={p.id} />
            <button type="submit" className="btn !h-7" disabled={stopping}>
              Stop
            </button>
          </form>
          <Link href={`/browsers/${p.id}/session`} className="btn btn-dark !h-7">
            Open browser
          </Link>
        </div>
      ) : null}
      <Msg s={start} />
      <Msg s={stop} />
    </section>
  );
}
