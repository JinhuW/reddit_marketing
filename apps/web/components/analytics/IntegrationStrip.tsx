type Status = 'connected' | 'disconnected' | 'error' | 'coming_soon';

const CHIP: Record<Status, string> = {
  connected: 'chip-ok',
  disconnected: 'chip-mid',
  error: 'chip-warn',
  coming_soon: 'chip-mid',
};
const SUFFIX: Record<Status, string> = {
  connected: '',
  disconnected: ' · not set up',
  error: ' · error',
  coming_soon: ' · coming soon',
};

/** Link-out integration tiles (GA4, PostHog, Stripe, HubSpot, site script). Read-only in v1. */
export function IntegrationStrip({
  items,
}: {
  items: { key: string; label: string; status: Status; detail: string | null; href: string }[];
}) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-t border-line-soft px-[18px] py-3 text-xs">
      <span className="mr-1 font-semibold">Integrations</span>
      {items.map((i) => (
        <a
          key={i.key}
          href={i.href}
          target={i.href.startsWith('http') ? '_blank' : undefined}
          rel="noreferrer"
          className={`chip ${CHIP[i.status]} hover:underline`}
          title={i.detail ?? undefined}
        >
          {i.label}
          {SUFFIX[i.status]}
        </a>
      ))}
    </div>
  );
}
