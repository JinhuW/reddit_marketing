'use client';

import { FormMessage } from '@/components/agents/FormMessage';
import { type ActionState, finishConnect, startBrowserConnect } from '@/lib/actions/accounts';
import { useActionState, useEffect, useState } from 'react';
import { connectModes } from './connect-mode';

const ROLES = [
  { v: 'founder', l: 'Founder', example: 'I’m a founder at' },
  { v: 'support', l: 'Support', example: 'I work on support at' },
  { v: 'brand', l: 'Brand', example: 'Official account of' },
] as const;

export interface ConnectProps {
  configured: boolean;
  ownerName: string;
  /** accounts this person already owns (signed in); a person may own several */
  owns: string[];
  /** set when the workspace has no room left for another account on its plan */
  planFull: string | null;
  /** the owner's unfinished browser connect (pending username), which the browser flow resumes */
  resumes: string | null;
  canConnect: boolean;
  authorized: { username: string; scopes: string[] } | null;
  product: string;
  error: string | null;
  /** the workspace's proxies (safe labels only) for a browser-mode profile */
  proxies: { id: string; label: string }[];
  compact?: boolean;
}

export function ConnectAccountFlow(p: ConnectProps) {
  const [oauthState, oauthAction, oauthPending] = useActionState<ActionState, FormData>(finishConnect, {});
  const [browserState, browserAction, browserPending] = useActionState<ActionState, FormData>(
    startBrowserConnect,
    {},
  );
  const modes = connectModes(p.configured);
  const [mode, setMode] = useState(p.authorized ? 'oauth' : modes[0]!);
  const [role, setRole] = useState<(typeof ROLES)[number]['v']>('founder');
  const [fingerprint, setFingerprint] = useState('');

  // Captured once, in the owner's real browser, so their browser profile matches their device.
  useEffect(() => {
    try {
      setFingerprint(
        JSON.stringify({
          userAgent: navigator.userAgent,
          screen: `${screen.width}×${screen.height}`,
          tz: Intl.DateTimeFormat().resolvedOptions().timeZone,
          locale: navigator.languages?.join(', ') || navigator.language,
          os:
            (navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ??
            navigator.platform,
        }),
      );
    } catch {}
  }, []);

  const browser = mode === 'browser';
  // A pending browser account is resumed by the browser flow, so it needs no free slot; anything new does.
  const blocked = !p.canConnect || (Boolean(p.planFull) && !(browser && p.resumes));
  const step1Done = !browser && Boolean(p.authorized);
  const later = browser ? blocked : !step1Done || blocked;
  const pending = browser ? browserPending : oauthPending;
  const state = browser ? browserState : oauthState;
  const roleMeta = ROLES.find((r) => r.v === role)!;

  return (
    <aside className="panel" aria-labelledby="connect-h">
      <div className="border-b border-line-soft px-[18px] py-3.5">
        <h2 id="connect-h" className="m-0 text-sm font-semibold">
          Connect an account
        </h2>
        <div className="muted mt-0.5 text-xs">Four steps · about two minutes</div>
      </div>
      <form
        action={browser ? browserAction : oauthAction}
        className="flex flex-col gap-4 px-[18px] py-4 text-[13px]"
      >
        <input type="hidden" name="fingerprint" value={fingerprint} />
        {p.error ? (
          <p role="alert" className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
            {p.error}
          </p>
        ) : null}

        <Step n={1} done={step1Done}>
          {browser ? (
            <div className="flex w-full flex-col gap-2" data-testid="connect-browser">
              <div className="font-semibold">Connect through the browser</div>
              <div className="muted text-[12.5px]">
                Threadline opens this account’s own browser. You sign in to reddit.com in it yourself;
                Threadline reads the username when you’re done.
              </div>
              {!p.configured ? (
                <p className="muted m-0 text-xs" data-testid="reddit-not-configured">
                  No Reddit app is configured, so accounts connect through their browser.
                </p>
              ) : null}
              <label className="muted flex flex-col gap-1 text-xs">
                Proxy
                <select name="proxyId" className="field !h-9" defaultValue="" disabled={blocked}>
                  <option value="">No proxy · direct connection</option>
                  {p.proxies.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </label>
              {modes.includes('oauth') ? (
                <button
                  type="button"
                  className="btn btn-ghost !h-7 self-start !px-2"
                  onClick={() => setMode('oauth')}
                >
                  Use Reddit sign-in instead
                </button>
              ) : null}
            </div>
          ) : (
            <OAuthStep p={p} blocked={blocked} onBrowser={() => setMode('browser')} />
          )}
        </Step>

        <Step n={2}>
          <div className="flex w-full flex-col gap-2">
            <div className="font-semibold">Who owns this account?</div>
            <input className="field" value={p.ownerName} readOnly aria-label="Owner" />
            {!p.canConnect ? (
              <p role="alert" className="m-0 text-xs text-bad">
                Viewers can’t connect accounts.
              </p>
            ) : blocked && p.planFull ? (
              <p
                role="alert"
                className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad"
                data-testid="plan-full"
              >
                {p.planFull}
              </p>
            ) : p.resumes ? (
              <div className="muted text-xs" data-testid="connect-resumes">
                {browser
                  ? `You started connecting an account but didn’t finish signing in. This picks up u/${p.resumes} where you left off.`
                  : `You also have an unfinished browser sign-in (u/${p.resumes}). Connecting through the browser picks it up.`}
              </div>
            ) : (
              <div className="muted text-xs">
                {p.owns.length
                  ? `This adds another account for you (you own ${p.owns.map((u) => `u/${u}`).join(', ')}). Your accounts never speak in the same thread.`
                  : 'The account is connected to you, the person signing in.'}
              </div>
            )}
          </div>
        </Step>
        <fieldset disabled={later || pending} className="contents">
          <Step n={3}>
            <div className="flex w-full flex-col gap-2">
              <div className="font-semibold">Role and disclosure line</div>
              <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label="Role">
                {ROLES.map((r) => (
                  <label
                    key={r.v}
                    className={`chip chip-line cursor-pointer ${role === r.v ? '!border-ink !text-ink' : ''}`}
                  >
                    <input
                      type="radio"
                      name="roleLabel"
                      value={r.v}
                      checked={role === r.v}
                      onChange={() => setRole(r.v)}
                      className="sr-only"
                    />
                    {r.l}
                  </label>
                ))}
              </div>
              <input
                name="disclosureLine"
                className="field !h-9"
                key={role}
                defaultValue={`${roleMeta.example} ${p.product}.`}
                aria-label="Disclosure line"
              />
            </div>
          </Step>
          <Step n={4}>
            <div className="flex w-full flex-col gap-2">
              <div className="font-semibold">Limits</div>
              <div className="grid grid-cols-2 gap-2">
                <label className="muted flex flex-col gap-1 text-xs">
                  Posts per day
                  <input
                    name="dailyPostLimit"
                    type="number"
                    min={1}
                    max={50}
                    defaultValue={3}
                    className="field !h-9"
                  />
                </label>
                <label className="muted flex flex-col gap-1 text-xs">
                  Self-promo max %
                  <input
                    name="selfPromoMax"
                    type="number"
                    min={0}
                    max={100}
                    defaultValue={10}
                    className="field !h-9"
                  />
                </label>
              </div>
            </div>
          </Step>
          <button type="submit" className="btn btn-primary !h-[38px] !rounded-card text-sm">
            {browser
              ? pending
                ? 'Opening the browser…'
                : 'Open the browser to sign in'
              : 'Finish connecting'}
          </button>
        </fieldset>
        <FormMessage state={state} />
      </form>
    </aside>
  );
}

function OAuthStep({ p, blocked, onBrowser }: { p: ConnectProps; blocked: boolean; onBrowser: () => void }) {
  if (p.authorized)
    return (
      <>
        <div className="font-semibold">Sign in with Reddit</div>
        <div className="muted mt-0.5 text-[12.5px]">
          Authorized u/{p.authorized.username} · {p.authorized.scopes.join(', ')}
        </div>
      </>
    );
  return (
    <div className="flex flex-col gap-2">
      <div className="font-semibold">Sign in with Reddit</div>
      <div className="muted mt-0.5 text-[12.5px]">
        The account owner signs in themselves. Threadline asks for identity, read, submit, privatemessages,
        history and edit.
      </div>
      <div className="flex flex-wrap gap-2">
        {blocked ? (
          <button type="button" className="btn" disabled>
            Sign in with Reddit
          </button>
        ) : (
          <a href="/api/auth/reddit/start" className="btn btn-dark">
            Sign in with Reddit
          </a>
        )}
        <button type="button" className="btn" onClick={onBrowser} disabled={blocked}>
          Connect through the browser
        </button>
      </div>
    </div>
  );
}

function Step({ n, done, children }: { n: number; done?: boolean; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[26px_minmax(0,1fr)] items-start gap-3">
      <span
        className={`grid h-[26px] w-[26px] place-items-center rounded-full text-xs font-semibold ${done ? 'bg-inverse text-inverse-ink' : 'bg-surface-3 text-ink'}`}
        aria-hidden="true"
      >
        {done ? '✓' : n}
      </span>
      <div>{children}</div>
    </div>
  );
}
