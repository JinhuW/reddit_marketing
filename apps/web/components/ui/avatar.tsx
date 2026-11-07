import { initials } from '@threadline/shared';

export const AGENT_COLORS: Record<string, string> = {
  Maya: 'var(--agent-maya)',
  Leo: 'var(--agent-leo)',
  Sam: 'var(--agent-sam)',
};

/** Round avatar. Agents use their color; people use the neutral avatar ground. */
export function Avatar({
  name,
  label,
  color,
  size = 28,
  title,
}: {
  name: string;
  /** explicit text, e.g. "M" for an agent */
  label?: string;
  color?: string;
  size?: number;
  title?: string;
}) {
  const bg = color ?? AGENT_COLORS[name] ?? 'var(--avatar-me)';
  const isAgent = Boolean(color ?? AGENT_COLORS[name]);
  return (
    <span
      title={title ?? name}
      className="grid flex-none place-items-center rounded-full font-semibold"
      style={{
        width: size,
        height: size,
        fontSize: Math.max(9, Math.round(size * 0.39)),
        background: bg,
        color: isAgent ? '#fff' : 'var(--ink)',
      }}
    >
      {label ?? initials(name)}
    </span>
  );
}
