'use client';

import {
  type CookieExportState,
  clearDataAction,
  cookieExportAction,
  startCookieExportAction,
} from '@/lib/actions/browser-list';
import { startTransition, useActionState, useEffect, useState } from 'react';
import { Msg } from './BrowserControls';
import type { ActionState } from './action-state';
import type { ProfileView } from './view';

const POLL_MS = 2000;
const GIVE_UP_MS = 90_000;

/**
 * Drawer section (plan 0004 phase 4): export the browser's cookies, clear its cookies or cache. The export runs
 * in the browser on its node; this page only learns when the download is ready. The download itself is an
 * authenticated route that is never cached.
 */
export function CookieTools({ p, canEdit }: { p: ProfileView; canEdit: boolean }) {
  const [exp, setExp] = useState<CookieExportState>({ state: 'idle' });
  const [cleared, clear, clearing] = useActionState<ActionState | null, FormData>(clearDataAction, null);
  const [confirmed, setConfirmed] = useState(false);
  useEffect(() => {
    if (cleared?.ok) setConfirmed(false);
  }, [cleared]);

  const pendingJob = exp.state === 'pending' ? exp.jobId : null;
  useEffect(() => {
    if (!pendingJob) return;
    const started = Date.now();
    let stop = false;
    const tick = async () => {
      if (stop) return;
      if (Date.now() - started > GIVE_UP_MS) {
        setExp({ state: 'failed', message: 'The browser did not answer in time. Try again.' });
        return;
      }
      const r = await cookieExportAction(p.id, pendingJob).catch(
        (): CookieExportState => ({ state: 'pending', jobId: pendingJob }),
      );
      if (stop) return;
      if (r.state === 'pending') timer = setTimeout(tick, POLL_MS);
      else setExp(r);
    };
    let timer = setTimeout(tick, POLL_MS);
    return () => {
      stop = true;
      clearTimeout(timer);
    };
  }, [pendingJob, p.id]);

  if (!canEdit) return null;
  const href = (format: string) =>
    exp.state === 'ready'
      ? `/api/browsers/${p.id}/cookies?job=${encodeURIComponent(exp.jobId)}&format=${format}`
      : '#';
  const submitClear = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget, (e.nativeEvent as SubmitEvent).submitter);
    startTransition(() => clear(data));
  };
  return (
    <section
      className="flex flex-col gap-2.5 border-b border-line-soft px-[18px] py-4 text-[12.5px]"
      aria-labelledby={`cookies-h-${p.id}`}
      data-testid="cookie-tools"
    >
      <h3 id={`cookies-h-${p.id}`} className="m-0 text-[12.5px] font-semibold">
        Cookies and data
      </h3>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className="btn !h-7"
          disabled={exp.state === 'pending'}
          onClick={() => {
            setExp({ state: 'pending', jobId: '' });
            startCookieExportAction(p.id).then(setExp, () =>
              setExp({ state: 'failed', message: 'Could not start the export.' }),
            );
          }}
        >
          {exp.state === 'pending' ? 'Exporting…' : 'Export cookies'}
        </button>
        {exp.state === 'ready' ? (
          <>
            <a className="btn btn-primary !h-7" href={href('json')} download>
              Download JSON
            </a>
            <a className="btn !h-7" href={href('netscape')} download>
              Download cookies.txt
            </a>
          </>
        ) : null}
      </div>
      {exp.state === 'ready' ? (
        <output className="muted text-xs">
          {exp.count} {exp.count === 1 ? 'cookie' : 'cookies'} ready
          {exp.truncated ? ' (the browser holds more; only the first 3000 are included)' : ''}. The download
          works for 10 minutes and is recorded in the audit log. Treat the file like a password.
        </output>
      ) : exp.state === 'failed' ? (
        <p role="alert" className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-bad">
          {exp.message}
        </p>
      ) : (
        <span className="muted text-xs">
          Reads the cookies from the browser on its node (it is started if it is not running).
        </span>
      )}
      <form action={clear} onSubmit={submitClear} className="flex flex-col gap-2">
        <input type="hidden" name="profileId" value={p.id} />
        <label className="flex items-center gap-2">
          <input
            type="checkbox"
            name="confirm"
            className="m-0 accent-[var(--ink)]"
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />
          Sign this browser out of every site
        </label>
        <div className="flex flex-wrap items-center gap-2">
          <button type="submit" name="what" value="cookies" className="btn !h-7 text-bad" disabled={clearing}>
            Clear cookies
          </button>
          <button type="submit" name="what" value="cache" className="btn !h-7" disabled={clearing}>
            Clear cache
          </button>
        </div>
      </form>
      <Msg s={cleared} />
    </section>
  );
}
