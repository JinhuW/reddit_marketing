'use client';

import { FormMessage } from '@/components/agents/FormMessage';
import { type ActionState, finishConnect } from '@/lib/actions/accounts';
import { useActionState, useEffect, useState } from 'react';

const ROLES = [
  { v: 'founder', l: 'Founder', example: 'I’m a founder at' },
  { v: 'support', l: 'Support', example: 'I work on support at' },
  { v: 'brand', l: 'Brand', example: 'Official account of' },
] as const;

export interface ConnectProps {
  configured: boolean;
  ownerName: string;
  alreadyOwns: string | null;
  canConnect: boolean;
  authorized: { username: string; scopes: string[] } | null;
  product: string;
  error: string | null;
  compact?: boolean;
}

export function ConnectAccountFlow(p: ConnectProps) {
  const [state, action, pending] = useActionState<ActionState, FormData>(finishConnect, {});
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

  const blocked = Boolean(p.alreadyOwns) || !p.canConnect;
  const step1Done = Boolean(p.authorized);
  const later = !step1Done || blocked;
  const roleMeta = ROLES.find((r) => r.v === role)!;

  return (
    <aside className="panel" aria-labelledby="connect-h">
      <div className="border-b border-line-soft px-[18px] py-3.5">
        <h2 id="connect-h" className="m-0 text-sm font-semibold">
          Connect an account
        </h2>
        <div className="muted mt-0.5 text-xs">Four steps · about two minutes</div>
      </div>
      <div className="flex flex-col gap-4 px-[18px] py-4 text-[13px]">
        {p.error ? (
          <p role="alert" className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad">
            {p.error}
          </p>
        ) : null}

        <Step n={1} done={step1Done}>
          <div className="font-semibold">Sign in with Reddit</div>
          {step1Done ? (
            <div className="muted mt-0.5 text-[12.5px]">
              Authorized u/{p.authorized!.username} · {p.authorized!.scopes.join(', ')}
            </div>
          ) : !p.configured ? (
            <div className="flex flex-col gap-2">
              <p
                role="status"
                className="m-0 mt-1 rounded-[9px] bg-warn-soft px-3 py-2 text-[12.5px] text-warn"
                data-testid="reddit-not-configured"
              >
                Reddit app not configured — set REDDIT_CLIENT_ID/SECRET
              </p>
              <button type="button" className="btn self-start" disabled>
                Sign in with Reddit
              </button>
            </div>
          ) : (
            <div className="flex flex-col gap-2">
              <div className="muted mt-0.5 text-[12.5px]">
                The account owner signs in themselves. Threadline asks for identity, read, submit,
                privatemessages, history and edit.
              </div>
              {blocked ? (
                <button type="button" className="btn self-start" disabled>
                  Sign in with Reddit
                </button>
              ) : (
                <a href="/api/auth/reddit/start" className="btn btn-dark self-start">
                  Sign in with Reddit
                </a>
              )}
            </div>
          )}
        </Step>

        <form action={action} className="flex flex-col gap-4">
          <input type="hidden" name="fingerprint" value={fingerprint} />
          <Step n={2}>
            <div className="flex w-full flex-col gap-2">
              <div className="font-semibold">Who owns this account?</div>
              <input className="field" value={p.ownerName} readOnly aria-label="Owner" />
              {p.alreadyOwns ? (
                <p
                  role="alert"
                  className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-[12.5px] text-bad"
                  data-testid="one-account-refusal"
                >
                  You already own u/{p.alreadyOwns}. Each person can connect one Reddit account.
                </p>
              ) : !p.canConnect ? (
                <p role="alert" className="m-0 text-xs text-bad">
                  Viewers can’t connect accounts.
                </p>
              ) : (
                <div className="muted text-xs">
                  One account per real person. The account is connected to you, the person signing in.
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
              Finish connecting
            </button>
          </fieldset>
          <FormMessage state={state} />
        </form>
      </div>
    </aside>
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
