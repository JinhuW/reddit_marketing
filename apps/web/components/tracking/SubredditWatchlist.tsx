'use client';

import { type ActionState, saveSubreddit } from '@/lib/actions/tracking';
import type { SubredditView } from '@threadline/db/repos/tracking';
import { LINK_RULE_LABEL, LinkRule, type ModStatus, fmtInt } from '@threadline/shared';
import { useRouter } from 'next/navigation';
import { Fragment, useActionState, useEffect, useState } from 'react';

const LINK_CHIP: Record<LinkRule, string> = {
  one_per_comment: 'chip-ok',
  allowed: 'chip-ok',
  none: 'chip-warn',
  saturdays: 'chip-warn',
};
/** Short copy from the Tracking artboard; LINK_RULE_LABEL is the long form (title + editor). */
const LINK_SHORT: Record<LinkRule, string> = {
  one_per_comment: '1 per comment',
  none: 'None in comments',
  saturdays: 'Saturdays only',
  allowed: 'Allowed',
};
const MOD: Record<ModStatus, { label: string; chip: string }> = {
  ok: { label: 'Approved', chip: 'chip-ok' },
  watch: { label: 'Pending', chip: 'chip-mid' },
  banned: { label: 'Declined', chip: 'chip-mid' },
  unknown: { label: 'Not contacted', chip: 'chip-mid' },
};

export function fmtMembers(n: number) {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

export function SubredditWatchlist({
  subs,
  canEdit,
  openNew,
}: {
  subs: SubredditView[];
  canEdit: boolean;
  openNew: boolean;
}) {
  const [editing, setEditing] = useState<string | null>(openNew && canEdit ? 'new' : null);
  useEffect(() => {
    if (openNew && canEdit) setEditing('new');
  }, [openNew, canEdit]);
  return (
    <section className="panel min-w-0" aria-labelledby="sw-h">
      <div className="sect-h flex-wrap">
        <h2 id="sw-h">Subreddit watchlist</h2>
        <span className="muted text-xs">Rules and our standing in each</span>
        <div className="flex-1" />
        {canEdit && editing !== 'new' ? (
          <button type="button" className="btn btn-ghost !h-7" onClick={() => setEditing('new')}>
            Add subreddit
          </button>
        ) : null}
      </div>
      {editing === 'new' ? <SubForm onClose={() => setEditing(null)} /> : null}
      <div className="relative overflow-x-auto px-2 pt-1 pb-1.5">
        <table className="tbl" data-testid="subreddits">
          <thead>
            <tr>
              <th>Subreddit</th>
              <th className="!text-right">Members</th>
              <th>Activity</th>
              <th>Self-promo policy</th>
              <th>Links</th>
              <th className="!text-right">Our karma</th>
              <th>Mods</th>
            </tr>
          </thead>
          <tbody>
            {subs.map((s) => (
              <Fragment key={s.id}>
                <tr className="row-hover" data-testid="subreddit-row">
                  <td className="font-semibold whitespace-nowrap" title={s.notes ?? undefined}>
                    {canEdit ? (
                      <button
                        type="button"
                        className="border-0 bg-transparent p-0 font-semibold text-ink hover:text-accent hover:underline"
                        aria-label={`Edit r/${s.name}`}
                        aria-expanded={editing === s.id}
                        onClick={() => setEditing(editing === s.id ? null : s.id)}
                      >
                        r/{s.name}
                      </button>
                    ) : (
                      `r/${s.name}`
                    )}
                  </td>
                  <td className="text-right">{fmtMembers(s.members)}</td>
                  <td>
                    <span
                      className="inline-block h-1.5 w-[72px] overflow-hidden rounded-full bg-surface-3 align-middle"
                      role="meter"
                      aria-label={`Activity ${Math.round(s.activity * 100)}%`}
                      aria-valuenow={Math.round(s.activity * 100)}
                      aria-valuemin={0}
                      aria-valuemax={100}
                    >
                      <i
                        className="block h-full rounded-full bg-ink"
                        style={{ width: `${Math.round(s.activity * 100)}%` }}
                      />
                    </span>
                  </td>
                  <td className="muted min-w-[120px]">{s.selfPromoPolicy ?? '—'}</td>
                  <td>
                    <span className={`chip ${LINK_CHIP[s.linkRule]}`} title={LINK_RULE_LABEL[s.linkRule]}>
                      {LINK_SHORT[s.linkRule]}
                    </span>
                  </td>
                  <td className="text-right">{s.karma === null ? '—' : fmtInt(s.karma)}</td>
                  <td>
                    <span className={`chip ${MOD[s.modStatus].chip}`}>{MOD[s.modStatus].label}</span>
                  </td>
                </tr>
                {editing === s.id ? (
                  <tr>
                    <td colSpan={7} className="!p-0">
                      <SubForm sub={s} onClose={() => setEditing(null)} />
                    </td>
                  </tr>
                ) : null}
              </Fragment>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function SubForm({ sub, onClose }: { sub?: SubredditView; onClose: () => void }) {
  const router = useRouter();
  const [state, action, pending] = useActionState<ActionState, FormData>(saveSubreddit, { ok: false });
  useEffect(() => {
    if (state.ok) {
      onClose();
      router.replace('/tracking', { scroll: false });
    }
  }, [state, onClose, router]);
  return (
    <form
      action={action}
      aria-label={sub ? `Edit r/${sub.name}` : 'Add subreddit'}
      className="flex flex-col gap-2.5 border-b border-line-soft bg-surface-2 px-[18px] py-3.5 text-[13px]"
    >
      {sub ? <input type="hidden" name="id" value={sub.id} /> : null}
      <div className="grid grid-cols-1 gap-2.5 sm:grid-cols-2">
        {sub ? (
          <input type="hidden" name="name" value={sub.name} />
        ) : (
          <label className="flex flex-col gap-1 font-medium">
            Subreddit
            <input name="name" className="field" required placeholder="r/projectmanagement" />
          </label>
        )}
        <label className="flex flex-col gap-1 font-medium">
          Link rule
          <select name="linkRule" className="field" defaultValue={sub?.linkRule ?? 'one_per_comment'}>
            {LinkRule.map((r) => (
              <option key={r} value={r}>
                {LINK_RULE_LABEL[r]}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Self-promo policy
          <input
            name="selfPromoPolicy"
            className="field"
            defaultValue={sub?.selfPromoPolicy ?? ''}
            placeholder="Disclosed answers OK"
          />
        </label>
        <label className="flex flex-col gap-1 font-medium">
          Mods
          <select name="modStatus" className="field" defaultValue={sub?.modStatus ?? 'unknown'}>
            {(Object.keys(MOD) as ModStatus[]).map((m) => (
              <option key={m} value={m}>
                {MOD[m].label}
              </option>
            ))}
          </select>
        </label>
        <label className="flex flex-col gap-1 font-medium sm:col-span-2">
          Notes
          <input name="notes" className="field" defaultValue={sub?.notes ?? ''} />
        </label>
      </div>
      <div className="flex items-center gap-2">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Saving…' : sub ? 'Save' : 'Add subreddit'}
        </button>
        <button type="button" className="btn btn-ghost" onClick={onClose}>
          Cancel
        </button>
        {state.error ? (
          <span role="alert" className="text-xs text-bad">
            {state.error}
          </span>
        ) : null}
      </div>
    </form>
  );
}
