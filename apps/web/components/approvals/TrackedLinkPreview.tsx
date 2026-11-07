export function TrackedLinkPreview({ link }: { link: { short: string; full: string } | null }) {
  if (!link) {
    return (
      <div className="rounded-card border border-line-soft px-3.5 py-3">
        <div className="mb-1 text-[12.5px] font-semibold">Tracked link</div>
        <div className="muted text-[13px]">
          No link in this draft. The subreddit rule or the agent chose not to use one.
        </div>
      </div>
    );
  }
  const [base, query = ''] = link.full.split('?');
  const parts = query.split('&').filter(Boolean);
  return (
    <div className="rounded-card border border-line-soft px-3.5 py-3">
      <div className="mb-1 text-[12.5px] font-semibold">
        Tracked link <span className="font-normal text-muted">· inserted automatically</span>
      </div>
      <div className="text-sm font-semibold">{link.short}</div>
      <div className="mt-1 text-xs leading-relaxed break-all text-ink-3">
        {base}
        {parts.length ? '?' : ''}
        {parts.map((p, i) => {
          const [k, v] = p.split('=');
          return (
            <span key={p}>
              {i ? '&' : ''}
              {k?.startsWith('utm_') ? <b className="font-medium text-ink">{k}</b> : k}={v}
            </span>
          );
        })}
      </div>
    </div>
  );
}
