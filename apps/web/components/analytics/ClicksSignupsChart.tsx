'use client';

import type { Series } from '@threadline/db/repos/analytics';
import { useState } from 'react';
import { LegendDot, SegButtons } from './Seg';

export const SERIES_COLORS = ['var(--ink)', 'var(--accent)', 'var(--agent-maya)', 'var(--faint)'];

const W = 640;
const H = 200;
const L = 40;
const TOP = 20;
const BOTTOM = 170;

function niceMax(v: number) {
  if (v <= 4) return 4;
  const pow = 10 ** Math.floor(Math.log10(v));
  const n = v / pow;
  const step = n <= 2 ? 2 : n <= 4 ? 4 : n <= 5 ? 5 : 10;
  return step * pow;
}

const fmtDay = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });

export function ClicksSignupsChart({
  days,
  clicks,
  signups,
}: {
  days: string[];
  clicks: Series[];
  signups: Series[];
}) {
  const [metric, setMetric] = useState<'clicks' | 'signups'>('clicks');
  const series = metric === 'clicks' ? clicks : signups;
  const max = niceMax(Math.max(1, ...series.flatMap((s) => s.values)));
  const n = days.length;
  const x = (i: number) => (n === 1 ? (L + W) / 2 : L + (i / (n - 1)) * (W - L));
  const y = (v: number) => BOTTOM - (v / max) * (BOTTOM - TOP);
  const ticks = [0.25, 0.5, 0.75, 1].map((f) => Math.round(max * f));
  const total = (s: Series) => s.values.reduce((a, b) => a + b, 0);
  const summary = series.map((s) => `${s.name} ${total(s)}`).join(', ');
  const midIdx = Math.floor((n - 1) / 2);

  return (
    <section className="panel min-w-0">
      <div className="sect-h flex-wrap">
        <h2>Clicks and signups</h2>
        <span className="muted text-xs">Daily · split by subreddit</span>
        <div className="flex-1" />
        <SegButtons
          label="Series"
          value={metric}
          onChange={setMetric}
          items={[
            { key: 'clicks', label: 'Clicks' },
            { key: 'signups', label: 'Signups' },
          ]}
        />
      </div>
      <div className="flex flex-col gap-2.5 px-[18px] pt-4 pb-2.5">
        <svg
          viewBox={`0 0 ${W} ${H}`}
          role="img"
          aria-label={`Daily ${metric} over ${n} days by subreddit. Totals: ${summary}.`}
          className="block h-[220px] w-full"
          preserveAspectRatio="none"
        >
          <g style={{ stroke: 'var(--line-soft)' }} strokeWidth={1}>
            {ticks.map((t) => (
              <line key={t} x1={L} x2={W} y1={y(t)} y2={y(t)} />
            ))}
            <line x1={L} x2={W} y1={BOTTOM} y2={BOTTOM} style={{ stroke: 'var(--line)' }} />
          </g>
          <g style={{ fill: 'var(--muted)' }} fontSize={11}>
            {ticks.map((t) => (
              <text key={t} x={0} y={y(t) + 4}>
                {t}
              </text>
            ))}
            {n > 0 ? (
              <text x={L} y={190}>
                {fmtDay(days[0]!)}
              </text>
            ) : null}
            {n > 2 ? (
              <text x={x(midIdx)} y={190} textAnchor="middle">
                {fmtDay(days[midIdx]!)}
              </text>
            ) : null}
            {n > 1 ? (
              <text x={W} y={190} textAnchor="end">
                {fmtDay(days[n - 1]!)}
              </text>
            ) : null}
          </g>
          {series.map((s, si) => {
            const color = SERIES_COLORS[si] ?? 'var(--faint)';
            const dashed = s.name === 'Other';
            if (n === 1)
              return <circle key={s.name} cx={x(0)} cy={y(s.values[0] ?? 0)} r={3} style={{ fill: color }} />;
            return (
              <polyline
                key={s.name}
                fill="none"
                strokeWidth={2}
                strokeLinejoin="round"
                strokeDasharray={dashed ? '4 4' : undefined}
                vectorEffect="non-scaling-stroke"
                style={{ stroke: color }}
                points={s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(' ')}
              />
            );
          })}
        </svg>
        <div className="flex flex-wrap gap-4">
          {series.map((s, si) => (
            <LegendDot key={s.name} color={SERIES_COLORS[si] ?? 'var(--faint)'} dashed={s.name === 'Other'}>
              {s.name}
            </LegendDot>
          ))}
        </div>
        <table className="sr-only">
          <caption>Daily {metric} by subreddit</caption>
          <thead>
            <tr>
              <th>Day</th>
              {series.map((s) => (
                <th key={s.name}>{s.name}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {days.map((d, i) => (
              <tr key={d}>
                <td>{fmtDay(d)}</td>
                {series.map((s) => (
                  <td key={s.name}>{s.values[i]}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
