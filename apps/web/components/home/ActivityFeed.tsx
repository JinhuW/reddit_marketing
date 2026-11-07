import type { dashboard } from '@threadline/db';
import { ago } from '@threadline/shared';
import Link from 'next/link';

type Item = Awaited<ReturnType<typeof dashboard.activity>>[number];

const TONE: Record<Item['tone'], string> = {
  ok: 'chip-ok',
  dark: 'chip-dark',
  mid: 'chip-mid',
  hot: 'chip-hot',
  bad: 'chip-bad',
};

export function ActivityFeed({ items }: { items: Item[] }) {
  return (
    <section className="panel" aria-labelledby="act-h">
      <div className="sect-h">
        <h2 id="act-h">Activity</h2>
        <div className="flex-1" />
        <Link href="/settings/audit" className="btn btn-ghost !h-7">
          Audit log
        </Link>
      </div>
      {items.length === 0 ? <p className="muted m-0 px-[18px] py-6 text-[13px]">No activity yet.</p> : null}
      {items.map((f) => (
        <div
          key={f.id}
          className="grid grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2.5 border-b border-line-soft px-[18px] py-2.5 text-[13px] leading-snug last:border-b-0"
        >
          <span className={`chip ${TONE[f.tone]} mt-px`}>{f.kind}</span>
          <span className="[text-wrap:pretty]">{f.text}</span>
          <span className="muted num text-xs">{ago(f.at)}</span>
        </div>
      ))}
    </section>
  );
}
