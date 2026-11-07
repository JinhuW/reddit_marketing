/** Excerpt of the post body with the matched keyword marked, as in the artboard. */
export function Highlighted({
  body,
  keyword,
  max = 200,
}: { body: string; keyword: string | null; max?: number }) {
  if (!keyword) return <>{body.length > max ? `${body.slice(0, max)}…` : body}</>;
  const at = body.toLowerCase().indexOf(keyword.toLowerCase());
  if (at === -1) return <>{body.length > max ? `${body.slice(0, max)}…` : body}</>;
  const start = Math.max(0, at - 80);
  const end = Math.min(body.length, at + keyword.length + 110);
  return (
    <>
      {start > 0 ? '…' : ''}
      {body.slice(start, at)}
      <mark className="rounded-[4px] bg-accent-soft px-[3px] text-accent">
        {body.slice(at, at + keyword.length)}
      </mark>
      {body.slice(at + keyword.length, end)}
      {end < body.length ? '…' : ''}
    </>
  );
}
