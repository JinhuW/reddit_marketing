'use client';

import { Icon } from '@/components/ui/icon';
import { attachProxyAction, runProxyTestAction, saveProxyAction } from '@/lib/actions/browsers';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { AccountSection, type AssignableAccount } from './AccountSection';
import { BrowserControls } from './BrowserControls';
import { BrowserSettings } from './BrowserSettings';
import { CookieTools } from './CookieTools';
import { FingerprintSection } from './FingerprintSection';
import { DeleteProfile, ProfileDetails } from './ProfileDetails';
import type { ActionState } from './action-state';
import type { ProfileView } from './view';

const PROVIDERS = ['Bright Data', 'Oxylabs', 'Own server'];

function Kv({ rows }: { rows: [string, React.ReactNode][] }) {
  return (
    <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-1.5 text-[12.5px]">
      {rows.map(([k, v]) => (
        <div key={k} className="contents">
          <dt className="m-0 text-muted">{k}</dt>
          <dd className="m-0 font-medium">{v}</dd>
        </div>
      ))}
    </dl>
  );
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

export interface SavedProxy {
  id: string;
  label: string;
}

export function ProfileEditor({
  p,
  canEdit,
  canManage = canEdit,
  isAdmin = false,
  nodeOptions = [],
  savedProxies = [],
  currentProxyId = null,
  assignable = [],
  groups = [],
  tags = [],
  closeHref = '/browsers',
}: {
  p: ProfileView;
  canEdit: boolean;
  /** may manage (group access, plan 0004 phase 5): details and fingerprint settings; defaults to `canEdit` */
  canManage?: boolean;
  isAdmin?: boolean;
  nodeOptions?: { id: string; label: string }[];
  /** the workspace's proxies (safe fields only), for "Use a saved proxy" */
  savedProxies?: SavedProxy[];
  currentProxyId?: string | null;
  /** accounts this member may put into this browser (only used when it has none) */
  assignable?: AssignableAccount[];
  /** plan 0004: the workspace's groups and tags, for the details section */
  groups?: { id: string; name: string }[];
  tags?: { id: string; name: string; color: string }[];
  /** the list as it was before the drawer opened (filters, sort, page) */
  closeHref?: string;
}) {
  const [save, saveAction, saving] = useActionState<ActionState | null, FormData>(saveProxyAction, null);
  const [test, testAction, testing] = useActionState<ActionState | null, FormData>(runProxyTestAction, null);
  const [attach, attachAction, attaching] = useActionState<ActionState | null, FormData>(
    attachProxyAction,
    null,
  );
  const useFormId = `use-proxy-${p.id}`;
  const [protocol, setProtocol] = useState(p.proxy?.protocol ?? 'none');
  // After "Use" the page re-renders with another proxy behind this profile: re-seed the manual fields from it,
  // so a later Save cannot write the previous proxy's values onto the one just attached.
  const [seededFor, setSeededFor] = useState(currentProxyId);
  if (seededFor !== currentProxyId) {
    setSeededFor(currentProxyId);
    setProtocol(p.proxy?.protocol ?? 'none');
  }
  // The per-profile proxy form is folded away by default; its inputs still submit while closed.
  const [customOpen, setCustomOpen] = useState(false);
  const provider = p.proxy?.provider ?? 'Own server';
  const providers = PROVIDERS.includes(provider) ? PROVIDERS : [provider, ...PROVIDERS];
  const testChip = !p.test ? 'chip-mid' : p.region.mismatch ? 'chip-warn' : 'chip-ok';
  const testLabel = !p.test ? 'Not tested' : p.region.mismatch ? 'Region mismatch' : 'Healthy';
  const disabled = !canEdit;

  return (
    <aside className="panel flex min-w-0 flex-col" aria-labelledby="editor-h" data-testid="profile-editor">
      <div className="sect-h">
        <h2 id="editor-h">{p.name}</h2>
        <span className="muted text-xs">{p.account}</span>
        <div className="flex-1" />
        {canEdit ? (
          <button
            type="submit"
            form={`proxy-form-${p.id}`}
            className="btn btn-primary !h-7"
            disabled={saving}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        ) : null}
        <Link href={closeHref} className="btn btn-ghost !h-7 !px-2" aria-label="Close" title="Close">
          <Icon name="x" size={14} />
        </Link>
      </div>
      <BrowserControls p={p} canEdit={canEdit} isAdmin={isAdmin} nodeOptions={nodeOptions} />
      <AccountSection p={p} canEdit={canEdit} assignable={assignable} />
      <BrowserSettings p={p} canEdit={canEdit} />
      <CookieTools p={p} canEdit={canEdit} />
      <ProfileDetails p={p} canEdit={canManage} groups={groups} tags={tags} />
      <form id={useFormId} action={attachAction} className="hidden">
        <input type="hidden" name="profileId" value={p.id} />
      </form>
      <form key={currentProxyId ?? 'none'} id={`proxy-form-${p.id}`} action={saveAction}>
        <input type="hidden" name="profileId" value={p.id} />
        <div className="flex flex-col gap-4 px-[18px] py-4">
          {save ? (
            <p
              role="status"
              className={`m-0 rounded-[9px] px-3 py-2 text-[12.5px] ${save.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}
            >
              {save.message}
            </p>
          ) : null}
          {!canEdit ? (
            <p className="muted m-0 text-[12.5px]">
              Only an admin or {p.ownerFirst} can change this profile.
            </p>
          ) : null}

          <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0" disabled={disabled}>
            <legend className="mb-2.5 flex items-center gap-2 p-0 text-[12.5px] font-semibold">
              Proxy<span className={`chip ${testChip}`}>{testLabel}</span>
            </legend>
            {savedProxies.length ? (
              <div className="flex items-end gap-2">
                <Field id="saved-proxy" label="Use a saved proxy">
                  <select
                    key={currentProxyId ?? 'none'}
                    id="saved-proxy"
                    name="proxyId"
                    form={useFormId}
                    className="field"
                    defaultValue={currentProxyId ?? ''}
                  >
                    <option value="" disabled>
                      Pick one of the workspace’s proxies
                    </option>
                    {savedProxies.map((x) => (
                      <option key={x.id} value={x.id}>
                        {x.id === currentProxyId ? `${x.label} · in use` : x.label}
                      </option>
                    ))}
                  </select>
                </Field>
                <button type="submit" form={useFormId} className="btn !h-[34px]" disabled={attaching}>
                  Use
                </button>
              </div>
            ) : null}
            {attach ? (
              <p
                role="status"
                className={`m-0 rounded-[9px] px-3 py-2 text-[12.5px] ${attach.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}
              >
                {attach.message}
              </p>
            ) : null}
            <details
              className="group flex flex-col"
              open={customOpen || save?.ok === false}
              onToggle={(e) => setCustomOpen(e.currentTarget.open)}
              data-testid="custom-proxy"
            >
              <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[12.5px] font-medium text-ink-2 [&::-webkit-details-marker]:hidden">
                <span
                  aria-hidden
                  className="inline-block text-ink-3 transition-transform group-open:rotate-90"
                >
                  ›
                </span>
                {savedProxies.length ? 'Or enter a proxy for this profile' : 'Enter a proxy for this profile'}
                {p.proxy?.host ? (
                  <span className="muted num ml-auto truncate text-xs font-normal">
                    {p.proxy.host}
                    {p.proxy.port ? `:${p.proxy.port}` : ''}
                  </span>
                ) : null}
              </summary>
              <div className="mt-2.5 flex flex-col gap-2.5">
                <div
                  role="radiogroup"
                  aria-label="Protocol"
                  className="inline-flex gap-0.5 rounded-[9px] bg-surface-3 p-[3px]"
                >
                  {(['http', 'socks5', 'none'] as const).map((v) => (
                    <label
                      key={v}
                      className={`relative flex h-[26px] flex-1 cursor-pointer items-center justify-center rounded-[7px] px-2.5 text-xs font-medium ${protocol === v ? 'bg-surface text-ink' : 'text-ink-3'}`}
                    >
                      <input
                        type="radio"
                        name="protocol"
                        value={v}
                        checked={protocol === v}
                        onChange={() => setProtocol(v)}
                        className="absolute h-0 w-0 opacity-0"
                      />
                      {v === 'http' ? 'HTTP' : v === 'socks5' ? 'SOCKS5' : 'None'}
                    </label>
                  ))}
                </div>
                <div className="grid grid-cols-[minmax(0,1fr)_88px] gap-2">
                  <Field id="host" label="Host">
                    <input
                      id="host"
                      name="host"
                      className="field"
                      defaultValue={p.proxy?.host}
                      disabled={protocol === 'none'}
                    />
                  </Field>
                  <Field id="port" label="Port">
                    <input
                      id="port"
                      name="port"
                      className="field num"
                      inputMode="numeric"
                      defaultValue={p.proxy?.port}
                      disabled={protocol === 'none'}
                    />
                  </Field>
                </div>
                <div className="grid grid-cols-2 gap-2">
                  <Field id="pu" label="Username">
                    <input
                      id="pu"
                      name="username"
                      className="field"
                      autoComplete="off"
                      placeholder={p.proxy?.hasUsername ? '•••• saved' : 'Not set'}
                      aria-describedby="cred-note"
                    />
                  </Field>
                  <Field id="pp" label="Password">
                    <input
                      id="pp"
                      name="password"
                      type="password"
                      className="field"
                      autoComplete="new-password"
                      placeholder={p.proxy?.hasPassword ? '•••• saved' : 'Not set'}
                      aria-describedby="cred-note"
                    />
                  </Field>
                </div>
                <p id="cred-note" className="muted m-0 text-[11.5px]">
                  Credentials are encrypted and never shown. Leave blank to keep the saved value.
                </p>
                <div className="grid grid-cols-2 gap-2">
                  <Field id="prov" label="Provider">
                    <select id="prov" name="provider" className="field" defaultValue={provider}>
                      {providers.map((o) => (
                        <option key={o}>{o}</option>
                      ))}
                    </select>
                  </Field>
                  <Field id="sess" label="Session">
                    <select
                      id="sess"
                      name="sticky"
                      className="field"
                      defaultValue={p.proxy?.sticky === false ? 'rotate' : 'sticky'}
                    >
                      <option value="sticky">Sticky · same IP 30 days</option>
                      <option value="rotate">Rotate per login</option>
                    </select>
                  </Field>
                </div>
                <Field id="region" label="Region">
                  <input
                    id="region"
                    name="region"
                    className="field"
                    defaultValue={p.proxy?.region}
                    placeholder="e.g. Boston, US"
                  />
                </Field>
                {p.ownerPlace ? (
                  <div className="rounded-[10px] bg-surface-2 px-3 py-2.5 text-[12.5px] leading-snug">
                    <div className="font-medium">Keep region where {p.ownerFirst} actually is</div>
                    <div className="muted text-xs">{p.ownerPlace} · from their account settings</div>
                  </div>
                ) : null}
              </div>
            </details>
          </fieldset>
        </div>
      </form>

      <div className="flex flex-col gap-4 px-[18px] pb-4">
        <div
          className="flex flex-col gap-2 rounded-[12px] border border-line-soft px-3.5 py-3"
          data-testid="connection-test"
        >
          <form action={testAction} className="flex items-center gap-2 text-[12.5px]">
            <input type="hidden" name="profileId" value={p.id} />
            <span className="font-semibold">Last connection test</span>
            <span className="muted">{p.test?.testedAgo ?? 'never'}</span>
            <div className="flex-1" />
            {canEdit ? (
              <button type="submit" className="btn btn-ghost !h-[26px] !px-2" disabled={testing}>
                Test now
              </button>
            ) : null}
          </form>
          {test ? (
            <p role="status" className="muted m-0 text-xs">
              {test.message}
            </p>
          ) : null}
          {p.test?.failed ? (
            <p role="alert" className="m-0 rounded-[9px] bg-warn-soft px-3 py-2 text-xs text-warn">
              The last test failed ({p.test.error ?? 'unknown error'}). Check the proxy host, port and
              sign-in.
            </p>
          ) : null}
          {p.test && p.test.ip !== '—' ? (
            <Kv
              rows={[
                [
                  'Exit IP',
                  <span key="ip" className="num">
                    {p.test.ip}
                  </span>,
                ],
                [
                  'Location',
                  <span key="loc" className="inline-flex flex-wrap items-center gap-1.5">
                    {p.test.location}
                    <span className={`chip ${p.region.mismatch ? 'chip-warn' : 'chip-ok'}`}>
                      {p.region.mismatch ? `owner is in ${p.ownerPlace ?? p.tz}` : 'matches owner'}
                    </span>
                  </span>,
                ],
                [
                  'Latency',
                  <span key="lat" className="num">
                    {p.test.latency}
                  </span>,
                ],
                [
                  'Reddit reachable',
                  <span
                    key="r"
                    className={`chip ${p.test.redditOk == null ? '' : p.test.redditOk ? 'chip-ok' : 'chip-bad'}`}
                  >
                    {p.test.redditOk == null ? 'Not checked' : p.test.redditOk ? 'Yes' : 'No'}
                  </span>,
                ],
              ]}
            />
          ) : p.test ? null : (
            <p className="muted m-0 text-xs">No test has run for this proxy yet.</p>
          )}
          {p.region.mismatch ? (
            <p role="note" className="m-0 rounded-[9px] bg-warn-soft px-3 py-2 text-xs text-warn">
              Region mismatch: the proxy exits in {p.test?.location ?? p.region.label}, but {p.ownerFirst} is
              in {p.ownerPlace ?? p.tz}. Reddit may ask for verification. Pick a proxy near the owner.
            </p>
          ) : null}
        </div>

        <FingerprintSection p={p} canEdit={canManage} canReset={canEdit} />

        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] font-semibold">What the agent may do here</div>
          {[
            { label: 'Read threads and DMs', checked: true, note: null },
            { label: 'Post approved items', checked: true, note: 'after approval only' },
            { label: 'Vote or join subreddits', checked: false, note: 'Never allowed' },
            { label: 'Change account settings', checked: false, note: 'Owner only' },
          ].map((r) => (
            <label key={r.label} className="flex items-center gap-2.5 text-[12.5px]">
              <input
                type="checkbox"
                checked={r.checked}
                readOnly
                disabled
                className="m-0 h-[15px] w-[15px] accent-[var(--ink)]"
              />
              <span className="flex-1">{r.label}</span>
              {r.note ? <span className="chip chip-mid">{r.note}</span> : null}
            </label>
          ))}
          <div className="muted text-xs">
            Take over: Admins and {p.ownerFirst} ({p.accountInfo ? 'account owner' : 'created this browser'}).
            Posting from this browser still needs an approved draft.
          </div>
        </div>

        <div className="flex items-start gap-2 border-t border-line-soft pt-3.5">
          {canEdit ? (
            <>
              <Link href={`/browsers/${p.id}/session`} className="btn">
                Take over browser
              </Link>
              <div className="flex-1" />
              <DeleteProfile p={p} />
            </>
          ) : (
            <span className="muted text-xs">
              Only an admin or {p.accountInfo ? 'the account owner' : 'the browser’s creator'} can take over.
            </span>
          )}
        </div>
      </div>
    </aside>
  );
}
