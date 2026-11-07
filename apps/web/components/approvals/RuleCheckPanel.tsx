import type { RuleCheck } from '@threadline/shared';

const chip = (c: RuleCheck) =>
  c.passed
    ? { cls: 'chip chip-ok', s: 'Pass' }
    : c.level === 'block'
      ? { cls: 'chip chip-bad', s: 'Block' }
      : { cls: 'chip chip-warn', s: 'Warn' };

export function RuleCheckPanel({ checks }: { checks: RuleCheck[] }) {
  const pass = checks.filter((c) => c.passed).length;
  const warn = checks.filter((c) => !c.passed && c.level === 'warn').length;
  const block = checks.filter((c) => !c.passed && c.level === 'block').length;
  return (
    <section aria-label="Rule check" className="overflow-hidden rounded-card border border-line-soft">
      <div className="flex items-center gap-2 border-b border-line-soft px-3.5 py-2.5 text-[12.5px]">
        <span className="font-semibold">Rule check</span>
        <span className="chip chip-ok">{pass} pass</span>
        {warn ? <span className="chip chip-warn">{warn} warn</span> : null}
        {block ? <span className="chip chip-bad">{block} block</span> : null}
      </div>
      <ul className="m-0 list-none p-0" aria-live="polite">
        {checks.map((c) => {
          const k = chip(c);
          return (
            <li
              key={c.key}
              data-rule={c.key}
              data-status={k.s.toLowerCase()}
              className="grid grid-cols-[auto_minmax(0,1fr)] items-start gap-2.5 border-b border-line-soft px-3.5 py-[9px] text-[13px] leading-[1.4] last:border-b-0"
            >
              <span className={`${k.cls} mt-px w-[46px] justify-center`}>{k.s}</span>
              <div>
                <div className="font-medium">{c.label}</div>
                <div className="muted text-xs">{c.detail}</div>
              </div>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
