export function FormMessage({ state }: { state: { ok?: boolean; error?: string; message?: string } }) {
  if (state.error)
    return (
      <p role="alert" className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
        {state.error}
      </p>
    );
  if (state.ok && state.message)
    return (
      <p role="status" className="m-0 text-[12.5px] font-medium text-ok">
        {state.message}
      </p>
    );
  return null;
}
