'use client';

import { Avatar } from '@/components/ui/avatar';
import {
  type ActionResult,
  approveDraft,
  editDraft,
  regenerateDraft,
  rejectDraft,
  scheduleDraft,
} from '@/lib/actions/approvals';
import { countLinks, evaluateDraft } from '@threadline/agents';
import type { RuleCheck } from '@threadline/shared';
import { useEffect, useMemo, useRef, useState, useTransition } from 'react';
import { isTyping } from './ApprovalsView';
import { PostingAsBanner } from './PostingAsBanner';
import { RuleCheckPanel } from './RuleCheckPanel';
import { TrackedLinkPreview } from './TrackedLinkPreview';
import type { DraftDetail } from './types';

function blockReason(c: RuleCheck, disclosureLine: string) {
  switch (c.key) {
    case 'disclosure':
      return `Add the disclosure line “${disclosureLine}” to approve.`;
    case 'link_rule':
      return 'Remove links to meet the subreddit’s link rule.';
    case 'daily_limit':
      return 'This account has reached its daily posting limit.';
    case 'dm_after_engagement':
      return 'This person has not messaged or replied to us, so a DM cannot be sent.';
    case 'one_voice_per_thread':
      return 'Another account of the same person is already in this thread. Use that account or skip it.';
    default:
      return c.detail;
  }
}

function defaultScheduleValue() {
  const d = new Date(Date.now() + 3_600_000);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function DraftReview({
  d,
  position,
  onPrev,
  onNext,
  onDone,
  perms,
}: {
  d: DraftDetail;
  position: { index: number; total: number };
  onPrev: () => void;
  onNext: () => void;
  onDone: () => void;
  perms: { canApprove: boolean; canEdit: boolean };
}) {
  const [body, setBody] = useState(d.body);
  const [mode, setMode] = useState<null | 'reject' | 'schedule'>(null);
  const [reason, setReason] = useState('');
  const [at, setAt] = useState(defaultScheduleValue);
  const [instruction, setInstruction] = useState('');
  const [result, setResult] = useState<ActionResult | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [busy, start] = useTransition();
  const textRef = useRef<HTMLTextAreaElement>(null);
  const regenRef = useRef<HTMLInputElement>(null);
  const reasonRef = useRef<HTMLInputElement>(null);

  const checks = useMemo(
    () => evaluateDraft({ ...d.ruleContext, draft: { ...d.ruleContext.draft, body } }),
    [d.ruleContext, body],
  );
  const firstBlock = checks.find((c) => c.level === 'block' && !c.passed);
  const disclosed = checks.find((c) => c.key === 'disclosure')?.passed ?? false;
  const dirty = body !== d.body;
  const links = countLinks(body);

  const approveBlocked = !perms.canApprove
    ? 'Only approvers can approve drafts.'
    : firstBlock
      ? blockReason(firstBlock, d.account.disclosureLine)
      : null;
  const editBlocked = perms.canEdit ? null : 'Viewers cannot edit drafts.';
  const rejectBlocked = perms.canApprove ? null : 'Only approvers can reject drafts.';

  const run = (fn: () => Promise<ActionResult>, after?: () => void) =>
    start(async () => {
      const r = await fn();
      setResult(r);
      if (r.ok) after?.();
    });

  const approve = () => {
    if (approveBlocked || busy) return;
    run(() => approveDraft({ draftId: d.id, body: dirty ? body : undefined }), onDone);
  };
  const regenerate = () => {
    if (editBlocked || busy) return;
    if (instruction.trim().length < 3) {
      setResult({ ok: false, error: 'Write an instruction for the agent first.' });
      regenRef.current?.focus();
      return;
    }
    run(
      () => regenerateDraft({ draftId: d.id, instruction }),
      () => setInstruction(''),
    );
  };

  // A / E / R shortcuts (J/K live in the list)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isTyping(e)) {
        (e.target as HTMLElement).blur();
        return;
      }
      if (isTyping(e) || e.metaKey || e.ctrlKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'a') {
        e.preventDefault();
        approve();
      } else if (k === 'e' && !editBlocked) {
        e.preventDefault();
        textRef.current?.focus();
      } else if (k === 'r' && !editBlocked) {
        e.preventDefault();
        regenRef.current?.focus();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (mode === 'reject') reasonRef.current?.focus();
  }, [mode]);

  const t = d.thread;

  return (
    <section
      className="panel flex min-w-0 flex-col gap-[18px] px-[22px] pt-[18px] pb-[22px]"
      aria-label="Draft review"
      data-hydrated={hydrated ? '' : undefined}
    >
      <div className="flex flex-wrap items-center gap-2.5 text-[13px]">
        <span className="chip chip-line">{d.typeLabel}</span>
        <span className="muted">
          Drafted by {d.agent} {d.createdAgo} ago · {position.index + 1} of {position.total}
          {d.editCount ? ` · ${d.editCount} edit${d.editCount === 1 ? '' : 's'}` : ''}
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="btn !w-8 !p-0"
          aria-label="Previous draft"
          onClick={onPrev}
          disabled={position.index <= 0}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn !w-8 !p-0"
          aria-label="Next draft"
          onClick={onNext}
          disabled={position.index >= position.total - 1}
        >
          ↓
        </button>
      </div>

      <div className="flex flex-col gap-1.5 rounded-card border border-line-soft bg-surface-2 px-4 py-3.5">
        <div className="muted text-xs">{t.meta}</div>
        {t.title ? <div className="text-[15px] leading-snug font-semibold">{t.title}</div> : null}
        {t.excerpt ? <div className="text-[13px] leading-normal text-ink-2">{t.excerpt}</div> : null}
        {t.messages?.length ? (
          <ul className="m-0 flex list-none flex-col gap-2 p-0">
            {t.messages.map((m, i) => (
              <li
                key={i}
                className={`border-l-2 pl-2.5 text-[13px] leading-normal ${m.inbound ? 'border-ink' : 'border-line'}`}
              >
                <span className="font-medium text-ink">{m.author}</span>{' '}
                <span className="muted">· {m.ago}</span>
                <div className="text-ink-2">{m.body}</div>
              </li>
            ))}
          </ul>
        ) : null}
        <div className="muted mt-1 text-xs">{t.note}</div>
      </div>

      <div>
        <div className="mb-1.5 flex items-center gap-2 text-xs">
          <label htmlFor="draft-body" className="font-semibold">
            Draft
          </label>
          <span className="muted">{perms.canEdit ? 'editable' : 'read-only'}</span>
          {dirty ? <span className="chip chip-warn">Edited</span> : null}
          <div className="flex-1" />
          <span className="muted num">
            {body.length} characters · {links} link{links === 1 ? '' : 's'}
          </span>
        </div>
        <textarea
          id="draft-body"
          ref={textRef}
          aria-label="Draft reply"
          value={body}
          readOnly={!perms.canEdit}
          onChange={(e) => setBody(e.target.value)}
          className="block min-h-[188px] w-full resize-y rounded-card border border-ink bg-surface px-4 py-3.5 text-[14.5px] leading-relaxed text-ink outline-none"
        />
        {dirty && perms.canEdit ? (
          <div className="mt-2 flex gap-2">
            <button
              type="button"
              className="btn"
              disabled={busy}
              onClick={() => run(() => editDraft({ draftId: d.id, body }))}
            >
              Save edit
            </button>
            <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => setBody(d.body)}>
              Discard changes
            </button>
          </div>
        ) : null}
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        <RuleCheckPanel checks={checks} />
        <div className="flex flex-col gap-3.5">
          <div className="rounded-card border border-line-soft px-3.5 py-3">
            <div className="mb-1.5 flex items-center gap-2 text-[12.5px]">
              <Avatar name={d.agent} label={d.agent[0]} color={d.agentColor} size={20} />
              <span className="font-semibold">Why this reply</span>
            </div>
            <div className="text-[13px] leading-relaxed text-ink-2">
              {d.reasoning || 'The agent did not give a reason.'}
            </div>
          </div>
          <TrackedLinkPreview link={d.link} />
        </div>
      </div>

      <div className="flex flex-col gap-3 border-t border-line-soft pt-4">
        <PostingAsBanner
          account={d.account}
          approverName={d.approverName}
          disclosed={disclosed}
          type={d.type}
        />

        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            regenerate();
          }}
        >
          <input
            ref={regenRef}
            aria-label="Regenerate instruction"
            placeholder="Regenerate with an instruction, e.g. “shorter, skip the link”"
            value={instruction}
            onChange={(e) => setInstruction(e.target.value)}
            disabled={Boolean(editBlocked)}
            className="field !h-9 min-w-[240px] flex-1 !rounded-[10px]"
          />
          <button
            type="submit"
            className="btn !h-9"
            disabled={Boolean(editBlocked) || busy}
            title={editBlocked ?? undefined}
          >
            Regenerate <kbd>R</kbd>
          </button>
        </form>

        {mode === 'reject' ? (
          <form
            className="flex flex-wrap items-center gap-2 rounded-card bg-bad-soft px-3 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              if (reason.trim().length < 3) {
                setResult({ ok: false, error: 'Give a reason so the agent can learn from it.' });
                return;
              }
              run(() => rejectDraft({ draftId: d.id, reason }), onDone);
            }}
          >
            <input
              ref={reasonRef}
              aria-label="Reason for rejecting"
              placeholder="Why? e.g. “Too salesy for a first touch”"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              required
              minLength={3}
              className="field !h-9 min-w-[240px] flex-1"
            />
            <button type="submit" className="btn !h-9" disabled={busy}>
              Reject draft
            </button>
            <button type="button" className="btn btn-ghost !h-9" onClick={() => setMode(null)}>
              Cancel
            </button>
          </form>
        ) : null}

        {mode === 'schedule' ? (
          <form
            className="flex flex-wrap items-center gap-2 rounded-card bg-surface-2 px-3 py-2.5"
            onSubmit={(e) => {
              e.preventDefault();
              run(
                () =>
                  scheduleDraft({
                    draftId: d.id,
                    at: new Date(at).toISOString(),
                    body: dirty ? body : undefined,
                  }),
                onDone,
              );
            }}
          >
            <label className="flex items-center gap-2 text-[13px] font-medium">
              Post at
              <input
                type="datetime-local"
                value={at}
                onChange={(e) => setAt(e.target.value)}
                required
                className="field !h-9 !w-auto"
              />
            </label>
            <button
              type="submit"
              className="btn !h-9"
              disabled={busy || Boolean(approveBlocked)}
              title={approveBlocked ?? undefined}
            >
              Approve and schedule
            </button>
            <button type="button" className="btn btn-ghost !h-9" onClick={() => setMode(null)}>
              Cancel
            </button>
          </form>
        ) : null}

        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            className="btn btn-ghost"
            disabled={Boolean(rejectBlocked) || busy}
            title={rejectBlocked ?? undefined}
            onClick={() => setMode(mode === 'reject' ? null : 'reject')}
          >
            Reject with reason
          </button>
          <button
            type="button"
            className="btn"
            disabled={Boolean(approveBlocked) || busy}
            title={approveBlocked ?? undefined}
            onClick={() => setMode(mode === 'schedule' ? null : 'schedule')}
          >
            Schedule
          </button>
          <button
            type="button"
            className="btn"
            disabled={Boolean(editBlocked)}
            title={editBlocked ?? undefined}
            onClick={() => textRef.current?.focus()}
          >
            Edit <kbd>E</kbd>
          </button>
          <div className="flex-1" />
          {approveBlocked ? (
            <span id="approve-blocked" className="text-[12.5px] text-bad">
              {approveBlocked}
            </span>
          ) : null}
          <button
            type="button"
            className="btn btn-primary !h-10 !rounded-[12px] !px-[18px] !text-sm"
            disabled={Boolean(approveBlocked) || busy}
            aria-describedby={approveBlocked ? 'approve-blocked' : undefined}
            onClick={approve}
          >
            {busy ? 'Working…' : dirty ? 'Approve edit and post' : 'Approve and post'}{' '}
            <kbd className="!border-white/40 !bg-transparent !text-white">A</kbd>
          </button>
        </div>

        {result ? (
          <p
            role={result.ok ? 'status' : 'alert'}
            className={`m-0 text-[13px] ${result.ok ? 'text-ok' : 'text-bad'}`}
          >
            {result.ok ? result.message : result.error}
          </p>
        ) : null}
      </div>
    </section>
  );
}
