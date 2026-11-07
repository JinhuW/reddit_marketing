'use client';

import { addTask, setTaskDone } from '@/lib/actions/leads';
import { useActionState, useEffect, useOptimistic, useRef, useState, useTransition } from 'react';
import { shortDate } from './format';

type Task = { id: string; title: string; dueAt: string | null; done: boolean };

export function Tasks({ leadId, tasks, canEdit }: { leadId: string; tasks: Task[]; canEdit: boolean }) {
  const [adding, setAdding] = useState(false);
  const [state, action, pending] = useActionState(addTask, null);
  const [, start] = useTransition();
  const [optimistic, setOptimistic] = useOptimistic(tasks, (ts, p: { id: string; done: boolean }) =>
    ts.map((t) => (t.id === p.id ? { ...t, done: p.done } : t)),
  );
  const form = useRef<HTMLFormElement>(null);
  useEffect(() => {
    if (state?.ok) {
      form.current?.reset();
      setAdding(false);
    }
  }, [state]);

  const toggle = (t: Task) =>
    start(async () => {
      setOptimistic({ id: t.id, done: !t.done });
      await setTaskDone({ taskId: t.id, leadId, done: !t.done });
    });

  return (
    <section className="panel">
      <div className="sect-h">
        <h2>Tasks</h2>
        <div className="flex-1" />
        {canEdit ? (
          <button
            type="button"
            className="btn btn-ghost !h-7"
            onClick={() => setAdding((a) => !a)}
            aria-expanded={adding}
          >
            Add task
          </button>
        ) : null}
      </div>
      <div className="flex flex-col gap-2.5 px-[18px] pt-2 pb-3.5 text-[13px]">
        {adding ? (
          <form ref={form} action={action} className="flex flex-wrap items-center gap-2">
            <input type="hidden" name="leadId" value={leadId} />
            <input
              name="title"
              aria-label="Task title"
              placeholder="What needs doing?"
              required
              className="field min-w-[160px] flex-1"
            />
            <input name="dueAt" type="date" aria-label="Due date" className="field !w-auto" />
            <button type="submit" className="btn" disabled={pending}>
              Add
            </button>
            {state && !state.ok ? (
              <span role="alert" className="w-full text-xs text-bad">
                {state.error}
              </span>
            ) : null}
          </form>
        ) : null}
        {optimistic.length === 0 && !adding ? <p className="muted m-0">No tasks.</p> : null}
        {optimistic.map((t) => (
          <label key={t.id} className={`flex items-center gap-2.5 ${t.done ? 'text-muted' : ''}`}>
            <input
              type="checkbox"
              checked={t.done}
              disabled={!canEdit}
              onChange={() => toggle(t)}
              className="m-0 h-[15px] w-[15px] accent-[var(--ink)]"
            />
            <span className={`flex-1 ${t.done ? 'line-through' : ''}`}>{t.title}</span>
            {t.dueAt ? <span className="muted text-xs">{shortDate(new Date(t.dueAt))}</span> : null}
          </label>
        ))}
      </div>
    </section>
  );
}
