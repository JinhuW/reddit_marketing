'use client';

import { Avatar } from '@/components/ui/avatar';
import type { DraftType } from '@threadline/shared';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useCallback, useEffect } from 'react';
import { DraftReview } from './DraftReview';
import type { DraftDetail, DraftRow } from './types';

export function isTyping(e: KeyboardEvent) {
  const t = e.target as HTMLElement | null;
  if (!t) return false;
  return t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName);
}

export function ApprovalsView({
  rows,
  counts,
  type,
  detail,
  oldestWait,
  typeLabels,
  perms,
}: {
  rows: DraftRow[];
  counts: { all: number; comment: number; post: number; dm: number };
  type: DraftType | null;
  detail: DraftDetail | null;
  oldestWait: string | null;
  typeLabels: Record<DraftType, string>;
  perms: { canApprove: boolean; canEdit: boolean };
}) {
  const router = useRouter();
  const selId = detail?.id ?? null;
  const idx = rows.findIndex((r) => r.id === selId);

  const href = useCallback(
    (id?: string, t: DraftType | null = type) => {
      const p = new URLSearchParams();
      if (t) p.set('type', t);
      if (id) p.set('id', id);
      const q = p.toString();
      return q ? `/approvals?${q}` : '/approvals';
    },
    [type],
  );
  const go = useCallback(
    (i: number) => {
      const r = rows[i];
      if (r) router.push(href(r.id), { scroll: false });
    },
    [rows, router, href],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'j') {
        e.preventDefault();
        go(Math.min(rows.length - 1, idx + 1));
      } else if (k === 'k') {
        e.preventDefault();
        go(Math.max(0, idx - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, idx, rows.length]);

  const segs: { t: DraftType | null; label: string; n: number }[] = [
    { t: null, label: 'All', n: counts.all },
    { t: 'comment', label: 'Comments', n: counts.comment },
    { t: 'post', label: 'Posts', n: counts.post },
    { t: 'dm', label: 'DMs', n: counts.dm },
  ];

  return (
    <div className="grid items-start gap-5 lg:grid-cols-[380px_minmax(0,1fr)]">
      <section className="panel flex min-w-0 flex-col" aria-label="Drafts waiting for approval">
        <div className="flex flex-col gap-3 px-4 pt-4 pb-3">
          <div className="flex items-baseline gap-2">
            <h1 className="m-0 text-lg font-semibold">Approvals</h1>
            <span className="num text-sm font-semibold text-accent">{counts.all}</span>
            <div className="flex-1" />
            {oldestWait ? <span className="muted text-xs">Oldest waiting {oldestWait}</span> : null}
          </div>
          <nav
            aria-label="Filter by type"
            className="flex w-full gap-0.5 rounded-[10px] bg-surface-3 p-[3px]"
          >
            {segs.map((s) => {
              const on = s.t === type;
              return (
                <Link
                  key={s.label}
                  href={href(undefined, s.t)}
                  aria-current={on ? 'true' : undefined}
                  className={`flex h-7 flex-1 items-center justify-center gap-1.5 rounded-lg px-2.5 text-[12.5px] font-medium ${on ? 'border border-line bg-surface text-ink' : 'text-ink-3 hover:text-ink'}`}
                >
                  {s.label} <span className="num">{s.n}</span>
                </Link>
              );
            })}
          </nav>
        </div>
        <ul className="m-0 list-none border-t border-line-soft p-0" aria-label="Drafts">
          {rows.map((r) => {
            const on = r.id === selId;
            return (
              <li key={r.id}>
                <Link
                  href={href(r.id)}
                  scroll={false}
                  aria-current={on ? 'true' : undefined}
                  data-draft-row={r.id}
                  className={`grid grid-cols-[30px_minmax(0,1fr)] gap-2.5 border-b border-line-soft px-4 py-3 ${on ? 'bg-surface-3' : 'hover:bg-surface-2'}`}
                >
                  <Avatar name={r.agent} label={r.agent[0]} color={r.agentColor} size={30} />
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <div className="flex items-center gap-2 text-xs">
                      <span className="chip chip-line">{typeLabels[r.type]}</span>
                      <span className="muted truncate">{r.where}</span>
                      <div className="flex-1" />
                      <span className={`num font-medium ${r.waitHot ? 'text-accent' : 'text-muted'}`}>
                        {r.wait}
                      </span>
                    </div>
                    <div className="truncate text-[13.5px] font-medium">{r.firstLine}</div>
                    <div className="muted text-xs">
                      {r.agent} drafted · posts from {r.account}
                    </div>
                  </div>
                </Link>
              </li>
            );
          })}
        </ul>
        {rows.length === 0 ? (
          <div className="muted px-4 py-10 text-center text-[13px]">
            {type
              ? 'No drafts of this type are waiting.'
              : 'Nothing is waiting. New drafts appear here when an agent writes one.'}
          </div>
        ) : null}
        <div className="muted flex flex-wrap gap-3.5 px-4 py-3 text-xs">
          <span>
            <kbd>J</kbd> <kbd>K</kbd> move
          </span>
          <span>
            <kbd>A</kbd> approve
          </span>
          <span>
            <kbd>E</kbd> edit
          </span>
          <span>
            <kbd>R</kbd> regenerate
          </span>
        </div>
      </section>

      {detail ? (
        <DraftReview
          key={detail.id}
          d={detail}
          position={{ index: idx, total: rows.length }}
          onPrev={() => go(Math.max(0, idx - 1))}
          onNext={() => go(Math.min(rows.length - 1, idx + 1))}
          onDone={() => router.replace(href(rows[idx + 1]?.id ?? rows[idx - 1]?.id), { scroll: false })}
          perms={perms}
        />
      ) : (
        <section className="panel grid min-h-[320px] place-items-center p-8 text-center">
          <div className="flex flex-col gap-1.5">
            <div className="text-[15px] font-semibold">You’re all caught up</div>
            <div className="muted text-[13px]">
              Every draft has been reviewed. Generate a draft from Opportunities to fill the queue.
            </div>
            <Link href="/opportunities" className="btn mt-2 self-center">
              Open opportunities
            </Link>
          </div>
        </section>
      )}
    </div>
  );
}
