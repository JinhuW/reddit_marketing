'use client';

import { checkSignInAction, finishSignInAction, signInStatusAction } from '@/lib/actions/browsers';
import { useRouter } from 'next/navigation';
import { useEffect, useRef, useState } from 'react';
import type { SignInCheck } from './view';

export const POLL_MS = 3_000;
export const POLL_LIMIT_MS = 60_000;
/** A `profile.signIn` run may start the browser, import cookies and fill the login form + 2FA. */
export const SIGN_IN_LIMIT_MS = 150_000;

/**
 * Browser-mode sign-in (plan 0002, Flow 2–3): the owner signs in to reddit.com in the viewer, presses
 * "I'm signed in" (queues `profile.whoami`), and the page polls until the account has a username. With `jobId`
 * (plan 0003 "Sign in now"), the page follows that `profile.signIn` run from the start.
 */
export function SignInPanel({
  profileId,
  username,
  canControl,
  hasControl,
  jobId = null,
  back = 'accounts',
}: {
  profileId: string;
  /** set once the account is identified */
  username: string | null;
  canControl: boolean;
  /** the viewer is in a take-over session they started */
  hasControl: boolean;
  /** a queued `profile.signIn` job to follow */
  jobId?: string | null;
  /** where "Hand back and finish" goes */
  back?: 'accounts' | 'browser';
}) {
  const router = useRouter();
  const [check, setCheck] = useState<SignInCheck>(
    username ? { state: 'signed_in', username } : jobId ? { state: 'checking' } : { state: 'idle' },
  );
  const [busy, setBusy] = useState(Boolean(jobId && !username));
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);
  useEffect(() => {
    if (username) setCheck({ state: 'signed_in', username });
  }, [username]);

  function follow(job: string, limitMs: number) {
    const until = Date.now() + limitMs;
    const tick = async () => {
      let s: SignInCheck;
      try {
        s = await signInStatusAction(profileId, job);
      } catch {
        s = { state: 'failed', message: 'Could not read the sign-in check. Reload the page.' };
      }
      if (s.state === 'checking' || s.state === 'idle') {
        if (Date.now() >= until) {
          setBusy(false);
          setCheck({
            state: 'failed',
            message: 'No answer from the browser yet. Press I’m signed in to try again.',
          });
          return;
        }
        timer.current = setTimeout(tick, POLL_MS);
        return;
      }
      setBusy(false);
      setCheck(s);
      if (s.state === 'signed_in') router.refresh();
    };
    timer.current = setTimeout(tick, POLL_MS);
  }

  // "Sign in now" queued a profile.signIn run before navigating here: follow it once.
  const followed = useRef(false);
  useEffect(() => {
    if (!jobId || username || followed.current) return;
    followed.current = true;
    follow(jobId, SIGN_IN_LIMIT_MS);
  });

  async function press() {
    setBusy(true);
    setCheck({ state: 'checking' });
    if (timer.current) clearTimeout(timer.current);
    const r = await checkSignInAction(profileId).catch(() => ({
      ok: false as const,
      message: 'Could not reach Threadline. Try again.',
    }));
    if (!r.ok) {
      setBusy(false);
      setCheck({ state: 'failed', message: r.message });
      return;
    }
    follow(r.jobId, POLL_LIMIT_MS);
  }

  if (check.state === 'signed_in')
    return (
      <section
        className="panel flex flex-wrap items-center gap-3 px-[18px] py-3 text-[13px]"
        data-testid="sign-in-panel"
      >
        <span className="chip chip-ok">Signed in</span>
        <span className="font-semibold">Signed in as u/{check.username}</span>
        <div className="flex-1" />
        {canControl ? (
          <form action={finishSignInAction}>
            <input type="hidden" name="profileId" value={profileId} />
            <input type="hidden" name="back" value={back} />
            <button type="submit" className="btn btn-primary">
              Hand back and finish
            </button>
          </form>
        ) : null}
      </section>
    );

  return (
    <section
      className="panel flex flex-col gap-2 px-[18px] py-3 text-[13px]"
      aria-live="polite"
      data-testid="sign-in-panel"
    >
      <div className="flex flex-wrap items-center gap-3">
        <span className="font-semibold">
          Sign in to Reddit in this window, then press <b>I’m signed in</b>
        </span>
        <div className="flex-1" />
        {canControl ? (
          <button
            type="button"
            className="btn btn-primary"
            onClick={press}
            disabled={busy || !hasControl}
            title={hasControl ? undefined : 'Take control of the browser first'}
          >
            {busy ? 'Checking…' : 'I’m signed in'}
          </button>
        ) : null}
      </div>
      {check.state === 'checking' ? (
        <p role="status" className="muted m-0 text-[12.5px]">
          {jobId
            ? 'Signing in: cookies, password and 2FA as saved on the browser…'
            : 'Checking who is signed in…'}
        </p>
      ) : check.state === 'not_signed_in' ? (
        <p role="status" className="m-0 rounded-[9px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn">
          {check.message}
        </p>
      ) : check.state === 'failed' ? (
        <p role="alert" className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
          {check.message}
        </p>
      ) : !hasControl && canControl ? (
        <p className="muted m-0 text-[12.5px]">Take control of the browser first (on the right).</p>
      ) : null}
    </section>
  );
}
