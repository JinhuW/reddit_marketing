'use client';

import {
  assignOpportunities,
  markAllWatched,
  skipOpportunities,
  watchOpportunities,
} from '@/lib/actions/opportunities';
import type { OpportunityListItem } from '@threadline/db/repos/opportunities';
import { INTENT_LABEL, LINK_RULE_LABEL, ago } from '@threadline/shared';
import { usePathname, useRouter, useSearchParams } from 'next/navigation';
import { useState, useTransition } from 'react';
import { Highlighted } from './highlight';
import { STATUS_LABEL } from './params';

const LEVEL = { high: 'High', medium: 'Medium', low: 'Low' } as const;

export function OpportunityList({
  items,
  total,
  selectedId,
  agents,
  canEdit,
  limit,
}: {
  items: OpportunityListItem[];
  total: number;
  selectedId: string | null;
  agents: { id: string; name: string }[];
  canEdit: boolean;
  limit: number;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const [pending, start] = useTransition();
  const [assignOpen, setAssignOpen] = useState(false);

  const nav = (patch: Record<string, string>) => {
    const p = new URLSearchParams(params);
    for (const [k, v] of Object.entries(patch)) p.set(k, v);
    router.replace(`${pathname}?${p.toString()}`, { scroll: false });
  };
  const toggle = (id: string) =>
    setChecked((s) => {
      const n = new Set(s);
      n.has(id) ? n.delete(id) : n.add(id);
      return n;
    });
  const run = (fn: () => Promise<{ ok: boolean; message?: string; error?: string }>) =>
    start(async () => {
      const r = await fn();
      setMsg({ ok: r.ok, text: (r.ok ? r.message : r.error) ?? '' });
      if (r.ok) setChecked(new Set());
      router.refresh();
    });
  const ids = [...checked];

  return (
    <div className="flex min-w-0 flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <span className="muted text-[12.5px]" aria-live="polite">
          {msg ? (
            <span className={msg.ok ? 'text-ok' : 'text-bad'}>{msg.text}</span>
          ) : (
            `${checked.size} selected`
          )}
        </span>
        <div className="flex-1" />
        {canEdit ? (
          <>
            <div className="relative">
              <button
                type="button"
                className="btn !h-[30px]"
                disabled={!checked.size || pending}
                aria-expanded={assignOpen}
                onClick={() => setAssignOpen((o) => !o)}
              >
                Assign to agent
              </button>
              {assignOpen ? (
                <ul className="absolute top-9 right-0 z-30 m-0 w-44 list-none rounded-[12px] border border-line bg-surface p-1">
                  {agents.map((a) => (
                    <li key={a.id}>
                      <button
                        type="button"
                        className="w-full rounded-[9px] px-2.5 py-1.5 text-left text-[13px] hover:bg-surface-3"
                        onClick={() => {
                          setAssignOpen(false);
                          run(() => assignOpportunities(ids, a.id));
                        }}
                      >
                        {a.name}
                      </button>
                    </li>
                  ))}
                </ul>
              ) : null}
            </div>
            <button
              type="button"
              className="btn !h-[30px]"
              disabled={!checked.size || pending}
              onClick={() => run(() => watchOpportunities(ids))}
            >
              Watch
            </button>
            <button
              type="button"
              className="btn !h-[30px]"
              disabled={!checked.size || pending}
              onClick={() => run(() => skipOpportunities(ids))}
            >
              Skip
            </button>
            <button
              type="button"
              className="btn btn-ghost !h-[30px]"
              disabled={pending}
              onClick={() => run(() => markAllWatched())}
            >
              Mark all as watched
            </button>
          </>
        ) : null}
      </div>

      {items.length === 0 ? (
        <div className="panel muted px-5 py-10 text-center text-[13px]">
          No opportunities match these filters.
        </div>
      ) : null}

      {items.map((p) => {
        const on = p.id === selectedId;
        return (
          // biome-ignore lint/a11y/useKeyWithClickEvents: the title link inside is the keyboard target
          <article
            key={p.id}
            data-testid="opp-card"
            data-id={p.id}
            aria-current={on ? 'true' : undefined}
            onClick={() => nav({ id: p.id })}
            className={`flex cursor-pointer flex-col gap-2 rounded-[14px] border px-4 py-3.5 ${on ? 'border-ink bg-surface-2' : 'border-line bg-surface hover:border-line-strong'}`}
          >
            <div className="flex flex-wrap items-center gap-2 text-[12.5px]">
              {canEdit ? (
                <input
                  type="checkbox"
                  aria-label={`Select “${p.title}”`}
                  checked={checked.has(p.id)}
                  onClick={(e) => e.stopPropagation()}
                  onChange={() => toggle(p.id)}
                  className="m-0 h-[15px] w-[15px] accent-[var(--ink)]"
                />
              ) : null}
              <span className="font-semibold">r/{p.subreddit}</span>
              <span className="chip chip-line">{LINK_RULE_LABEL[p.linkRule]}</span>
              <div className="flex-1" />
              <span className={`chip ${p.level === 'high' ? 'chip-hot' : 'chip-mid'}`}>
                {LEVEL[p.level]} · {p.score}
              </span>
              <span className="chip chip-line !text-muted">{STATUS_LABEL[p.status]}</span>
            </div>
            <a
              href={`?${new URLSearchParams({ ...Object.fromEntries(params), id: p.id }).toString()}`}
              onClick={(e) => {
                e.preventDefault();
                e.stopPropagation();
                nav({ id: p.id });
              }}
              className="text-[15px] leading-snug font-semibold tracking-[-0.005em] [text-wrap:pretty]"
            >
              {p.title}
            </a>
            <div className="text-[13px] leading-normal text-ink-2">
              <Highlighted body={p.body} keyword={p.matchedKeyword} />
            </div>
            <div className="muted flex flex-wrap items-center gap-3 text-xs">
              <span>u/{p.author}</span>
              <span className="num">{p.upvotes} upvotes</span>
              <span className="num">{p.comments} comments</span>
              <span>{ago(p.postedAt)}</span>
              <div className="flex-1" />
              <span className="inline-flex items-center gap-1.5 text-ink">
                <span className="h-1.5 w-1.5 rounded-full bg-accent" />
                {INTENT_LABEL[p.intent]}
              </span>
            </div>
            <div className="border-t border-dashed border-line pt-2 text-[12.5px] leading-snug text-ink-3">
              {p.reason}
            </div>
          </article>
        );
      })}
      {total > items.length ? (
        <button
          type="button"
          className="btn btn-ghost self-center"
          onClick={() => nav({ limit: String(limit + 20) })}
        >
          Show {Math.min(20, total - items.length)} more
        </button>
      ) : null}
    </div>
  );
}
