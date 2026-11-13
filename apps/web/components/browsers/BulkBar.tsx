'use client';

import { bulkAction } from '@/lib/actions/browser-list';
import { useActionState, useEffect, useState } from 'react';
import { Msg } from './BrowserControls';
import type { ActionState } from './action-state';

export const BULK_FORM = 'bulk-form';
const boxes = () => [
  ...document.querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${BULK_FORM}"]`),
];

interface Option {
  id: string;
  label: string;
}

/** One operation of the bar: a submit button that names its `op`. */
function Op({
  op,
  children,
  danger,
  disabled,
}: { op: string; children: string; danger?: boolean; disabled: boolean }) {
  return (
    <button
      type="submit"
      name="op"
      value={op}
      className={`btn !h-7 ${danger ? 'text-bad' : ''}`}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/**
 * The bulk bar of the profile list (plan 0004). The row checkboxes belong to this form through their `form`
 * attribute, so the table stays a plain server-rendered table. Every button is one `op` of `bulkAction`.
 */
export function BulkBar({
  trash,
  canClone,
  groups,
  tags,
  proxies,
}: { trash: boolean; canClone: boolean; groups: Option[]; tags: Option[]; proxies: Option[] }) {
  const [state, act, busy] = useActionState<ActionState | null, FormData>(bulkAction, null);
  const [n, setN] = useState(0);

  useEffect(() => {
    const count = () => setN(boxes().filter((b) => b.checked).length);
    count();
    document.addEventListener('change', count);
    return () => document.removeEventListener('change', count);
  }, []);
  // A finished action leaves nothing ticked: the rows may have moved or gone.
  useEffect(() => {
    if (!state?.ok) return;
    for (const b of boxes()) b.checked = false;
    const all = document.querySelector<HTMLInputElement>('input[data-select-all]');
    if (all) all.checked = false;
    setN(0);
  }, [state]);

  const none = n === 0 || busy;
  return (
    <div className="flex flex-col gap-2 border-b border-line-soft px-[18px] py-2.5" data-testid="bulk-bar">
      <form id={BULK_FORM} action={act} className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="num font-semibold" aria-live="polite" data-testid="bulk-count">
          {n} selected
        </span>
        {trash ? (
          <>
            <Op op="restore" disabled={none}>
              Restore
            </Op>
            <Op op="purge" danger disabled={none}>
              Delete for good
            </Op>
          </>
        ) : (
          <>
            <Op op="start" disabled={none}>
              Start
            </Op>
            <Op op="stop" disabled={none}>
              Stop
            </Op>
            <span className="flex items-center gap-1">
              <label className="sr-only" htmlFor="bulk-group">
                Group to move to
              </label>
              <select id="bulk-group" name="groupId" className="field !h-7 !w-auto" defaultValue="">
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.label}
                  </option>
                ))}
              </select>
              <Op op="group" disabled={none}>
                Move
              </Op>
            </span>
            {tags.length ? (
              <span className="flex items-center gap-1">
                <label className="sr-only" htmlFor="bulk-tag">
                  Tag
                </label>
                <select id="bulk-tag" name="tagId" className="field !h-7 !w-auto" defaultValue={tags[0]?.id}>
                  {tags.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.label}
                    </option>
                  ))}
                </select>
                <Op op="tag_add" disabled={none}>
                  Tag
                </Op>
                <Op op="tag_remove" disabled={none}>
                  Untag
                </Op>
              </span>
            ) : null}
            {proxies.length ? (
              <span className="flex items-center gap-1">
                <label className="sr-only" htmlFor="bulk-proxy">
                  Proxy to set
                </label>
                <select
                  id="bulk-proxy"
                  name="proxyId"
                  className="field !h-7 !w-auto max-w-[220px]"
                  defaultValue={proxies[0]?.id}
                >
                  {proxies.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
                <Op op="proxy" disabled={none}>
                  Set proxy
                </Op>
              </span>
            ) : null}
            {canClone ? (
              <Op op="clone" disabled={none}>
                Clone
              </Op>
            ) : null}
            <Op op="trash" danger disabled={none}>
              Delete
            </Op>
          </>
        )}
      </form>
      <Msg s={state} />
    </div>
  );
}

/** Header checkbox: ticks or clears every row on the page. */
export function SelectAll() {
  return (
    <input
      type="checkbox"
      data-select-all
      aria-label="Select every browser on this page"
      className="m-0 h-[15px] w-[15px] accent-[var(--ink)]"
      onChange={(e) => {
        for (const b of boxes()) b.checked = e.currentTarget.checked;
        // Row boxes changed without their own events: tell the bar to recount.
        document.dispatchEvent(new Event('change'));
      }}
    />
  );
}
