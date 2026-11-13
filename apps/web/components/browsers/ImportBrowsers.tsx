'use client';

import { importBrowsersAction } from '@/lib/actions/browser-list';
import { startTransition, useActionState, useEffect, useState } from 'react';
import { Msg } from './BrowserControls';
import type { ActionState } from './action-state';

const SAMPLE = `name,group,tags,notes,start_url,proxy
Shop 1,Shops,warm;us,bought in March,https://www.reddit.com/r/startups/,gate.example.com:7000
Shop 2,Shops,warm,,,`;

/**
 * "Import from CSV" (plan 0004 phase 4): one browser per row, in the columns the Browsers export writes. Pasted,
 * or read from a file in this browser; only the text is sent.
 */
export function ImportBrowsers() {
  const [state, run, busy] = useActionState<ActionState | null, FormData>(importBrowsersAction, null);
  const [csv, setCsv] = useState('');
  useEffect(() => {
    if (state?.ok) setCsv('');
  }, [state]);
  return (
    <form
      action={run}
      onSubmit={(e) => {
        e.preventDefault();
        const data = new FormData(e.currentTarget);
        data.delete('file');
        startTransition(() => run(data));
      }}
      className="panel flex flex-col gap-3 px-[18px] py-4 text-[12.5px]"
      data-testid="import-browsers"
    >
      <h2 className="m-0 text-[13px] font-semibold">Import from CSV</h2>
      <p className="muted m-0 text-xs leading-normal">
        One browser per row. The first line names the columns: <span className="num">name</span> (required),{' '}
        <span className="num">group</span>, <span className="num">tags</span> (separated by ;),{' '}
        <span className="num">notes</span>, <span className="num">start_url</span>,{' '}
        <span className="num">proxy</span> (host:port of a pool proxy). Missing groups and tags are created.
        Up to 100 rows.
      </p>
      <label htmlFor="imp-file" className="sr-only">
        CSV file
      </label>
      <input
        id="imp-file"
        name="file"
        type="file"
        accept=".csv,text/csv,text/plain"
        className="text-xs"
        onChange={async (e) => {
          const f = e.target.files?.[0];
          if (f) setCsv((await f.text()).slice(0, 500_000));
        }}
      />
      <label htmlFor="imp-csv" className="sr-only">
        CSV text
      </label>
      <textarea
        id="imp-csv"
        name="csv"
        className="field num min-h-[120px] resize-y py-2 font-mono text-[11.5px] leading-snug"
        spellCheck={false}
        placeholder={SAMPLE}
        value={csv}
        onChange={(e) => setCsv(e.target.value)}
      />
      <button type="submit" className="btn !h-7 self-start" disabled={busy || !csv.trim()}>
        {busy ? 'Importing…' : 'Import browsers'}
      </button>
      <Msg s={state} />
    </form>
  );
}
