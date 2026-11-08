'use client';

import { FormMessage } from '@/components/agents/FormMessage';
import { Avatar } from '@/components/ui/avatar';
import { type ActionState, disconnectAccount, saveLimits } from '@/lib/actions/accounts';
import type { AccountCard as Card } from '@threadline/db/repos/accounts';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { connectionView } from './connect-mode';

const HEALTH = {
  healthy: { label: 'Healthy', chip: 'chip-ok' },
  watch: { label: 'Watch ratio', chip: 'chip-warn' },
  blocked: { label: 'Blocked', chip: 'chip-bad' },
} as const;
const ROLE = { founder: 'Founder', support: 'Support', brand: 'Brand' } as const;

export function AccountCard({ a, canManage }: { a: Card; canManage: boolean }) {
  const [editing, setEditing] = useState(false);
  const [state, action, pending] = useActionState<ActionState, FormData>(saveLimits, {});
  const todayPct = Math.min(100, Math.round((a.postedToday / Math.max(1, a.dailyPostLimit)) * 100));
  const ratioPct = a.selfPromoMax ? Math.min(100, Math.round((a.selfPromoPct / a.selfPromoMax) * 100)) : 100;
  const ratioColor =
    a.selfPromoPct > a.selfPromoMax
      ? 'var(--bad)'
      : a.selfPromoPct >= a.selfPromoMax * 0.8
        ? 'var(--warn)'
        : 'var(--ok)';
  const h = HEALTH[a.health];
  const conn = connectionView(a);
  const title = a.identified ? `u/${a.username}` : 'Waiting for sign-in';
  return (
    <article className="panel flex flex-col gap-3 p-4" data-testid="account-card" aria-label={title}>
      <div className="flex items-center gap-3">
        <Avatar name={a.ownerName} size={40} />
        <div className="min-w-0 flex-1 leading-tight">
          <div className="text-[15px] font-semibold">{title}</div>
          <div className="muted text-[12.5px]">
            {a.ownerName} · {ROLE[a.roleLabel]}
          </div>
        </div>
        <span className={`chip ${h.chip}`}>{h.label}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        <span className="chip chip-ok">Discloses: “{a.disclosureLine}”</span>
        <span className={`chip ${conn.chip}`} data-testid="connection-chip">
          {conn.label}
        </span>
      </div>
      {conn.signInHref ? (
        <div className="flex flex-wrap items-center gap-2 rounded-[9px] bg-warn-soft px-3 py-2 text-xs text-warn">
          <span className="flex-1">Nobody has signed in to Reddit in this account’s browser yet.</span>
          {canManage ? (
            <Link href={conn.signInHref} className="btn !h-[26px] !px-2">
              Open sign-in
            </Link>
          ) : null}
        </div>
      ) : null}
      <div className="grid grid-cols-3 gap-2 border-t border-line-soft pt-3">
        <Stat v={a.karma.toLocaleString('en-US')} l="Karma" />
        <Stat v={a.age} l="Account age" />
        <Stat v={String(a.postsThisWeek)} l="Posts this week" />
      </div>
      <div className="flex flex-col gap-[5px] text-xs">
        <div className="flex justify-between">
          <span className="muted">Today vs daily limit</span>
          <span className="num font-medium">
            {a.postedToday} of {a.dailyPostLimit} today
          </span>
        </div>
        <Meter
          pct={todayPct}
          color="var(--ink)"
          label="Posts today vs daily limit"
          now={a.postedToday}
          max={a.dailyPostLimit}
        />
        <div className="mt-1 flex justify-between">
          <span className="muted">Self-promo ratio · 7d</span>
          <span className="num font-medium" style={{ color: ratioColor }}>
            {a.selfPromoPct}% of {a.selfPromoMax}% max
          </span>
        </div>
        <Meter
          pct={ratioPct}
          color={ratioColor}
          label="Self-promo ratio vs max"
          now={a.selfPromoPct}
          max={a.selfPromoMax}
        />
      </div>
      {editing ? (
        <form action={action} className="flex flex-col gap-2 rounded-card bg-surface-2 p-3">
          <input type="hidden" name="accountId" value={a.id} />
          <label className="muted flex flex-col gap-1 text-xs">
            Disclosure line
            <input name="disclosureLine" className="field" defaultValue={a.disclosureLine} />
          </label>
          <div className="grid grid-cols-2 gap-2">
            <label className="muted flex flex-col gap-1 text-xs">
              Posts per day
              <input
                name="dailyPostLimit"
                type="number"
                min={1}
                max={50}
                className="field"
                defaultValue={a.dailyPostLimit}
              />
            </label>
            <label className="muted flex flex-col gap-1 text-xs">
              Self-promo max %
              <input
                name="selfPromoMax"
                type="number"
                min={0}
                max={100}
                className="field"
                defaultValue={a.selfPromoMax}
              />
            </label>
          </div>
          <div className="flex items-center gap-2">
            <button type="submit" className="btn btn-dark !h-7" disabled={pending}>
              Save
            </button>
            <button type="button" className="btn btn-ghost !h-7" onClick={() => setEditing(false)}>
              Close
            </button>
            <FormMessage state={state} />
          </div>
        </form>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {canManage && !editing ? (
          <button type="button" className="btn btn-ghost !h-7 !px-2" onClick={() => setEditing(true)}>
            Edit limits
          </button>
        ) : null}
        {a.browserProfileId ? (
          <Link href={`/browsers?id=${a.browserProfileId}`} className="btn btn-ghost !h-7 !px-2">
            Browser profile
          </Link>
        ) : null}
        {canManage && a.connected ? (
          <form
            action={disconnectAccount}
            onSubmit={(e) => {
              if (
                !confirm(
                  `Disconnect u/${a.username}? Threadline will stop posting from it until it is reconnected.`,
                )
              )
                e.preventDefault();
            }}
          >
            <input type="hidden" name="accountId" value={a.id} />
            <button type="submit" className="btn btn-ghost !h-7 !px-2">
              Disconnect
            </button>
          </form>
        ) : null}
      </div>
    </article>
  );
}

function Stat({ v, l }: { v: string; l: string }) {
  return (
    <div className="flex min-w-0 flex-col gap-[3px]">
      <b className="num text-[15px] font-semibold">{v}</b>
      <span className="text-[11.5px] text-muted">{l}</span>
    </div>
  );
}

function Meter({
  pct,
  color,
  label,
  now,
  max,
}: { pct: number; color: string; label: string; now: number; max: number }) {
  return (
    <div
      className="h-1.5 overflow-hidden rounded-full bg-surface-3"
      role="meter"
      aria-label={label}
      aria-valuenow={now}
      aria-valuemin={0}
      aria-valuemax={max}
    >
      <i className="block h-full rounded-full" style={{ width: `${pct}%`, background: color }} />
    </div>
  );
}
