/** Tiny inline sparkline, as in the KPI tiles and keyword groups. */
export function Sparkline({
  values,
  stroke = 'var(--ink)',
  height = 28,
  label,
}: {
  values: number[];
  stroke?: string;
  height?: number;
  label?: string;
}) {
  const mx = Math.max(...values, 1);
  const mn = Math.min(...values, 0);
  const n = Math.max(values.length - 1, 1);
  const pts = values
    .map(
      (v, i) =>
        `${((i / n) * 120).toFixed(1)},${(height - 2 - ((v - mn) / (mx - mn || 1)) * (height - 4)).toFixed(1)}`,
    )
    .join(' ');
  return (
    <svg
      viewBox={`0 0 120 ${height}`}
      preserveAspectRatio="none"
      role={label ? 'img' : undefined}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      style={{ width: '100%', height, display: 'block' }}
    >
      <polyline
        points={pts}
        fill="none"
        stroke={stroke}
        strokeWidth={1.75}
        strokeLinejoin="round"
        vectorEffect="non-scaling-stroke"
      />
    </svg>
  );
}
