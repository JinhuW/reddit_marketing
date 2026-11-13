'use client';

import {
  addAccountAction,
  assignAccountAction,
  saveCredentialsAction,
  signInNowAction,
  unassignAccountAction,
} from '@/lib/actions/browsers';
import { useActionState, useState } from 'react';
import { Msg } from './BrowserControls';
import { BrowserSettings } from './BrowserSettings';
import type { ActionState } from './action-state';
import type { ProfileView } from './view';

/** An account of the workspace that is in no browser (the "Assign" picker). */
export interface AssignableAccount {
  id: string;
  label: string;
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[5px] text-[12.5px]">
      <label htmlFor={id} className="text-xs font-semibold">
        {label}
      </label>
      {children}
    </div>
  );
}

function Fold({
  label,
  open,
  testId,
  children,
}: { label: string; open?: boolean; testId: string; children: React.ReactNode }) {
  return (
    <details className="group flex flex-col" open={open} data-testid={testId}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
        <span aria-hidden className="inline-block text-ink-3 transition-transform group-open:rotate-90">
          ›
        </span>
        {label}
      </summary>
      <div className="mt-2.5 flex flex-col gap-2.5">{children}</div>
    </details>
  );
}

/** Password + 2FA inputs. Write-only: never pre-filled, never sent back; React clears them after each submit. */
function SecretInputs({
  idPrefix,
  hasPassword = false,
  hasTotp = false,
}: { idPrefix: string; hasPassword?: boolean; hasTotp?: boolean }) {
  return (
    <>
      <Field id={`${idPrefix}-pw`} label="Password">
        <input
          id={`${idPrefix}-pw`}
          name="password"
          type="password"
          className="field"
          autoComplete="off"
          placeholder={hasPassword ? '•••• saved' : 'Reddit password'}
        />
      </Field>
      <Field id={`${idPrefix}-totp`} label="2FA secret">
        <input
          id={`${idPrefix}-totp`}
          name="totp"
          type="password"
          className="field num"
          autoComplete="off"
          spellCheck={false}
          placeholder={hasTotp ? '•••• saved' : 'e.g. GDKI AX2L WCTA C3JC (optional)'}
        />
      </Field>
    </>
  );
}

/**
 * Plan 0003: the browser's account. With none: assign an account that is in no browser, or add one the way an
 * anti-detect browser's account dialog does (platform, username, password, 2FA secret). With one: who it is,
 * whether a password / 2FA secret is saved, Unassign, and a write-only form to change them. "Sign in now" queues
 * `profile.signIn` and opens the live view.
 */
export function AccountSection({
  p,
  canEdit,
  assignable,
}: {
  p: ProfileView;
  canEdit: boolean;
  assignable: AssignableAccount[];
}) {
  const [signIn, signInAct, signingIn] = useActionState<ActionState | null, FormData>(signInNowAction, null);
  const [assign, assignAct, assigning] = useActionState<Stamped | null, FormData>(
    stamp(assignAccountAction),
    null,
  );
  const [add, addAct, adding] = useActionState<Stamped | null, FormData>(stamp(addAccountAction), null);
  const [unassign, unassignAct, unassigning] = useActionState<Stamped | null, FormData>(
    stamp(unassignAccountAction),
    null,
  );
  const [cred, credAct, savingCred] = useActionState<Stamped | null, FormData>(
    stamp(saveCredentialsAction),
    null,
  );
  // One message for the account forms: the branch that rendered an action's form may be gone after it ran
  // (unassign swaps to the "add" branch), so only the newest result is shown, below both branches.
  const latest = newest([assign, add, unassign, cred]);
  // Kept across a refused submit (React resets uncontrolled fields after every action).
  const [username, setUsername] = useState('');
  const a = p.accountInfo;
  const chip = !a
    ? { cls: 'chip-mid', label: 'No account' }
    : a.identified || a.authMode !== 'browser'
      ? { cls: 'chip-ok', label: 'Signed in' }
      : { cls: 'chip-warn', label: 'Waiting for sign-in' };

  return (
    <section
      className="flex flex-col gap-2.5 border-b border-line-soft px-[18px] py-4 text-[12.5px]"
      aria-labelledby={`acct-h-${p.id}`}
      data-testid="account-section"
    >
      <div className="flex flex-wrap items-center gap-2">
        <h3 id={`acct-h-${p.id}`} className="m-0 text-[12.5px] font-semibold">
          Account
        </h3>
        <span className={`chip ${chip.cls}`}>{chip.label}</span>
        <div className="flex-1" />
        {canEdit ? (
          <form action={signInAct}>
            <input type="hidden" name="profileId" value={p.id} />
            <button type="submit" className="btn btn-dark !h-7" disabled={signingIn}>
              {signingIn ? 'Queuing…' : 'Sign in now'}
            </button>
          </form>
        ) : null}
      </div>
      <Msg s={signIn} />

      {a ? (
        <>
          <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5">
            <dt className="text-muted">Platform</dt>
            <dd className="m-0 font-medium">reddit.com</dd>
            <dt className="text-muted">Username</dt>
            <dd className="m-0 font-medium" data-testid="account-username">
              {a.username ? `u/${a.username}` : 'Not known until someone signs in'}
            </dd>
            <dt className="text-muted">Owner</dt>
            <dd className="m-0 font-medium">{a.ownerName}</dd>
            {a.authMode === 'browser' ? (
              <>
                <dt className="text-muted">Password</dt>
                <dd className="m-0">
                  <span className={`chip ${a.hasPassword ? 'chip-ok' : 'chip-mid'}`}>
                    {a.hasPassword ? 'Saved' : 'Not saved'}
                  </span>
                </dd>
                <dt className="text-muted">2FA secret</dt>
                <dd className="m-0">
                  <span className={`chip ${a.hasTotp ? 'chip-ok' : 'chip-mid'}`}>
                    {a.hasTotp ? 'Saved' : 'Not set'}
                  </span>
                </dd>
              </>
            ) : (
              <>
                <dt className="text-muted">Sign-in</dt>
                <dd className="m-0 font-medium">Reddit authorization</dd>
              </>
            )}
          </dl>
          {canEdit && a.authMode === 'browser' ? (
            <Fold
              label="Change password or 2FA secret"
              open={cred?.ok === false}
              testId="account-credentials"
            >
              <form action={credAct} className="flex flex-col gap-2.5">
                <input type="hidden" name="profileId" value={p.id} />
                <div className="grid grid-cols-2 gap-2">
                  <SecretInputs idPrefix={`cred-${p.id}`} hasPassword={a.hasPassword} hasTotp={a.hasTotp} />
                </div>
                <div className="flex flex-wrap gap-x-4 gap-y-1.5">
                  {a.hasPassword ? (
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" name="clearPassword" className="m-0 accent-[var(--ink)]" />
                      Remove saved password
                    </label>
                  ) : null}
                  {a.hasTotp ? (
                    <label className="flex items-center gap-1.5 text-xs">
                      <input type="checkbox" name="clearTotp" className="m-0 accent-[var(--ink)]" />
                      Remove saved 2FA secret
                    </label>
                  ) : null}
                </div>
                <p className="muted m-0 text-[11.5px]">
                  Encrypted and never shown again. Leave blank to keep what is saved.
                </p>
                <button type="submit" className="btn !h-7 self-start" disabled={savingCred}>
                  {savingCred ? 'Saving…' : 'Update sign-in details'}
                </button>
              </form>
            </Fold>
          ) : null}
          {canEdit ? (
            <form action={unassignAct} className="flex flex-wrap items-center gap-2">
              <input type="hidden" name="profileId" value={p.id} />
              <button type="submit" className="btn btn-ghost !h-[26px] !px-2" disabled={unassigning}>
                Unassign account
              </button>
              <span className="muted text-xs">The account and the browser both stay.</span>
            </form>
          ) : null}
        </>
      ) : canEdit ? (
        <>
          <p className="muted m-0 text-xs">
            One account per browser. Assign one that is in no browser, or add one with its sign-in details.
          </p>
          {assignable.length ? (
            <form action={assignAct} className="flex items-end gap-2">
              <input type="hidden" name="profileId" value={p.id} />
              <Field id={`assign-${p.id}`} label="Assign an account">
                <select id={`assign-${p.id}`} name="accountId" className="field" defaultValue="">
                  <option value="" disabled>
                    Pick an account
                  </option>
                  {assignable.map((x) => (
                    <option key={x.id} value={x.id}>
                      {x.label}
                    </option>
                  ))}
                </select>
              </Field>
              <button type="submit" className="btn !h-[34px]" disabled={assigning}>
                Assign
              </button>
            </form>
          ) : null}
          <Fold
            label={assignable.length ? 'Or add an account' : 'Add an account'}
            open={!assignable.length || add?.ok === false}
            testId="add-account"
          >
            <form action={addAct} className="flex flex-col gap-2.5">
              <input type="hidden" name="profileId" value={p.id} />
              <input type="hidden" name="platform" value="reddit.com" />
              <div className="grid grid-cols-2 gap-2">
                <Field id={`plat-${p.id}`} label="Platform">
                  <select id={`plat-${p.id}`} className="field" value="reddit.com" disabled>
                    <option value="reddit.com">reddit.com</option>
                  </select>
                </Field>
                <Field id={`user-${p.id}`} label="Username">
                  <input
                    id={`user-${p.id}`}
                    name="username"
                    className="field"
                    autoComplete="off"
                    spellCheck={false}
                    placeholder="without u/"
                    value={username}
                    onChange={(e) => setUsername(e.target.value)}
                    required
                  />
                </Field>
                <SecretInputs idPrefix={`add-${p.id}`} />
              </div>
              <p className="muted m-0 text-[11.5px]">
                Password and 2FA secret are encrypted and used only to sign this browser in to Reddit. Leave
                them blank to sign in by hand over the live view. The account can’t post until the browser has
                signed in as this username.
              </p>
              <button type="submit" className="btn btn-primary !h-7 self-start" disabled={adding}>
                {adding ? 'Adding…' : 'Add account'}
              </button>
            </form>
          </Fold>
        </>
      ) : (
        <p className="muted m-0 text-xs">No account in this browser.</p>
      )}
      <Msg s={latest} />
      <BrowserSettings p={p} canEdit={canEdit} />
    </section>
  );
}

type Stamped = ActionState & { at: number };

/** Adds the time an action finished, so {@link newest} can pick the latest of several forms' results. */
function stamp(
  action: (prev: ActionState | null, fd: FormData) => Promise<ActionState>,
): (prev: Stamped | null, fd: FormData) => Promise<Stamped> {
  return async (prev, fd) => ({ ...(await action(prev, fd)), at: Date.now() });
}

function newest(states: (Stamped | null)[]): Stamped | null {
  return states.reduce<Stamped | null>((a, b) => (b && (!a || b.at > a.at) ? b : a), null);
}
