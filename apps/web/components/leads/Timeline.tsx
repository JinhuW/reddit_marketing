import type { leads } from '@threadline/db';
import { lastTouch } from './format';

const ICONS = {
  msg: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  click: <path d="M4 3l9 4-4 1.5L7.5 12z" />,
  stage: <path d="M3 8h10M9 4l4 4-4 4" />,
  money: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v6M6.5 6.5h2.2a1 1 0 010 2H7.3a1 1 0 000 2h2.2" />
    </>
  ),
};

export function Timeline({ events }: { events: leads.TimelineEvent[] }) {
  return (
    <section className="panel">
      <div className="sect-h">
        <h2>Timeline</h2>
        <span className="muted text-xs">Every comment, reply, DM, click and payment</span>
      </div>
      <ol className="m-0 list-none p-0">
        {events.map((e) => (
          <li
            key={e.id}
            data-kind={e.kind}
            className="grid grid-cols-[28px_minmax(0,1fr)_auto] items-start gap-3 border-b border-line-soft px-[18px] py-3 text-[13px] leading-[1.45] last:border-b-0"
          >
            <span
              className={`grid h-7 w-7 place-items-center rounded-full ${e.kind === 'click' ? 'bg-accent-soft' : e.kind === 'money' ? 'bg-ok-soft' : 'bg-surface-3'}`}
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                width={14}
                height={14}
                fill="none"
                stroke="var(--ink-2)"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {ICONS[e.kind]}
              </svg>
            </span>
            <div className="min-w-0">
              <div>
                <span className="font-semibold">{e.who}</span> <span className="muted">{e.verb}</span>
              </div>
              <div className="mt-0.5 text-ink-2 [text-wrap:pretty]">{e.text}</div>
              {e.meta ? <div className="muted mt-1 text-xs">{e.meta}</div> : null}
            </div>
            <time dateTime={e.at.toISOString()} className="muted num text-xs whitespace-nowrap">
              {lastTouch(e.at)}
            </time>
          </li>
        ))}
      </ol>
    </section>
  );
}
