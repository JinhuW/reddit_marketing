'use client';

import { Icon } from '@/components/ui/icon';
import { INTENT_LABEL, OpportunityStatus as STATUSES } from '@threadline/shared';
import { Intent as INTENTS } from '@threadline/shared';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { STATUS_LABEL } from './params';

interface Props {
  groups: { id: string; name: string }[];
  subreddits: string[];
  value: {
    group: string | null;
    subreddits: string[];
    intents: string[];
    minScore: number;
    sinceDays?: number;
    statuses: string[];
    q: string | null;
  };
}

function Menu({
  label,
  value,
  active,
  children,
}: { label: string; value: string; active: boolean; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', close);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        aria-expanded={open}
        aria-haspopup="true"
        onClick={() => setOpen((o) => !o)}
        className={`inline-flex h-[30px] items-center gap-1.5 rounded-full border bg-surface px-2.5 text-[12.5px] font-medium hover:bg-surface-3 ${active ? 'border-ink' : 'border-line'}`}
      >
        {label} <span className={active ? 'text-ink' : 'font-normal text-muted'}>{value}</span>
        <Icon name="chevDownSm" size={13} className="text-faint" />
      </button>
      {open ? (
        <div className="absolute top-9 left-0 z-30 flex min-w-[220px] flex-col rounded-[12px] border border-line bg-surface p-1 text-[13px]">
          {children}
        </div>
      ) : null}
    </div>
  );
}

function Opt({
  checked,
  onChange,
  children,
  type = 'checkbox',
  name,
}: {
  checked: boolean;
  onChange: () => void;
  children: ReactNode;
  type?: 'checkbox' | 'radio';
  name?: string;
}) {
  return (
    <label className="flex cursor-pointer items-center gap-2 rounded-[9px] px-2.5 py-1.5 hover:bg-surface-3">
      <input type={type} name={name} checked={checked} onChange={onChange} className="accent-[var(--ink)]" />
      {children}
    </label>
  );
}

const DAYS = [
  ['1', 'Last 24 hours'],
  ['7', 'Last 7 days'],
  ['30', 'Last 30 days'],
  ['all', 'Any time'],
] as const;

export function FilterBar({ groups, subreddits, value: serverValue }: Props) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  // Optimistic copy so checkboxes respond before the server re-render lands.
  const [value, setValue] = useState(serverValue);
  const key = JSON.stringify(serverValue);
  // biome-ignore lint/correctness/useExhaustiveDependencies: resync only when the server value changes
  useEffect(() => setValue(serverValue), [key]);

  const FIELD: Record<string, keyof Props['value']> = {
    group: 'group',
    sub: 'subreddits',
    intent: 'intents',
    score: 'minScore',
    days: 'sinceDays',
    status: 'statuses',
    q: 'q',
  };
  const set = (k: string, v: string | null) => {
    const f = FIELD[k];
    if (f)
      setValue((cur) => {
        const list = ['subreddits', 'intents', 'statuses'].includes(f);
        let next: unknown = v;
        if (list) next = v === null || v === 'all' ? [] : v.split(',');
        else if (f === 'minScore') next = Number(v);
        else if (f === 'sinceDays') next = v === 'all' ? undefined : Number(v);
        return { ...cur, [f]: next };
      });
    const p = new URLSearchParams(params);
    if (v === null || v === '') p.delete(k);
    else p.set(k, v);
    p.delete('limit');
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const toggleIn = (k: string, cur: string[], item: string, emptyValue: string | null = null) => {
    const next = cur.includes(item) ? cur.filter((x) => x !== item) : [...cur, item];
    set(k, next.length ? next.join(',') : emptyValue);
  };

  const groupName = groups.find((g) => g.id === value.group)?.name;
  const daysKey = value.sinceDays === undefined ? 'all' : String(value.sinceDays);
  const statusText =
    value.statuses.length === 0
      ? 'All'
      : value.statuses.map((s) => STATUS_LABEL[s as keyof typeof STATUS_LABEL]).join(', ');

  return (
    <div className="flex flex-wrap items-center gap-2" aria-label="Filters" role="group">
      <Menu label="Keyword group" value={groupName ?? 'All'} active={Boolean(value.group)}>
        <Opt type="radio" name="kg" checked={!value.group} onChange={() => set('group', null)}>
          All groups
        </Opt>
        {groups.map((g) => (
          <Opt
            key={g.id}
            type="radio"
            name="kg"
            checked={value.group === g.id}
            onChange={() => set('group', g.id)}
          >
            {g.name}
          </Opt>
        ))}
      </Menu>
      <Menu
        label="Subreddit"
        value={value.subreddits.length ? `${value.subreddits.length} selected` : 'All'}
        active={value.subreddits.length > 0}
      >
        {subreddits.map((s) => (
          <Opt
            key={s}
            checked={value.subreddits.includes(s)}
            onChange={() => toggleIn('sub', value.subreddits, s)}
          >
            r/{s}
          </Opt>
        ))}
      </Menu>
      <Menu
        label="Intent"
        value={
          value.intents.length
            ? value.intents.map((i) => INTENT_LABEL[i as keyof typeof INTENT_LABEL]).join(', ')
            : 'All'
        }
        active={value.intents.length > 0}
      >
        {INTENTS.map((i) => (
          <Opt
            key={i}
            checked={value.intents.includes(i)}
            onChange={() => toggleIn('intent', value.intents, i)}
          >
            {INTENT_LABEL[i]}
          </Opt>
        ))}
      </Menu>
      <Menu label="Score" value={`≥ ${value.minScore}`} active={value.minScore !== 60}>
        {[0, 60, 70, 80, 90].map((s) => (
          <Opt
            key={s}
            type="radio"
            name="score"
            checked={value.minScore === s}
            onChange={() => set('score', String(s))}
          >
            {s === 0 ? 'Any score' : `≥ ${s}`}
          </Opt>
        ))}
      </Menu>
      <Menu
        label="Date"
        value={DAYS.find(([k]) => k === daysKey)?.[1] ?? 'Last 7 days'}
        active={daysKey !== '7'}
      >
        {DAYS.map(([k, l]) => (
          <Opt key={k} type="radio" name="days" checked={daysKey === k} onChange={() => set('days', k)}>
            {l}
          </Opt>
        ))}
      </Menu>
      <Menu
        label="Status"
        value={statusText}
        active={
          !(
            value.statuses.length === 2 &&
            value.statuses.includes('new') &&
            value.statuses.includes('drafting')
          )
        }
      >
        {STATUSES.map((s) => (
          <Opt
            key={s}
            checked={value.statuses.includes(s)}
            onChange={() => toggleIn('status', value.statuses, s, 'all')}
          >
            {STATUS_LABEL[s]}
          </Opt>
        ))}
      </Menu>
      {value.q ? (
        <button
          type="button"
          onClick={() => set('q', null)}
          className="inline-flex h-[30px] items-center gap-1.5 rounded-full border border-ink bg-surface px-2.5 text-[12.5px] font-medium"
          aria-label={`Clear search “${value.q}”`}
        >
          Search <span>“{value.q}”</span>
          <Icon name="x" size={12} />
        </button>
      ) : null}
    </div>
  );
}
