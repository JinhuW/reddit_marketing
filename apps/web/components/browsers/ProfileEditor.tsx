'use client';

import { assignProviderPortAction, runProxyTestAction, saveProxyAction } from '@/lib/actions/browsers';
import Link from 'next/link';
import { useActionState, useState } from 'react';
import { BrowserControls } from './BrowserControls';
import type { ActionState } from './action-state';
import { type ProfileView, type ProviderChoice, firstFreePort } from './view';

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

function Status({ s }: { s: ActionState | null }) {
  if (!s) return null;
  return (
    <p
      role="status"
      className={`m-0 rounded-[9px] px-3 py-2 text-[12.5px] ${s.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}
    >
      {s.message}
    </p>
  );
}

/** Provider + port: the profile's port of a workspace provider (Settings → Proxies). */
function ProviderPort({
  formId,
  profileId,
  providers,
  current,
  action,
}: {
  formId: string;
  profileId: string;
  providers: ProviderChoice[];
  current: { providerId: string; port: string } | null;
  action: (f: FormData) => void;
}) {
  const [providerId, setProviderId] = useState(current?.providerId ?? providers[0]?.id ?? '');
  const choice = providers.find((x) => x.id === providerId);
  const ownPort = (id: string) => (current?.providerId === id ? current.port : '');
  const [port, setPort] = useState(ownPort(providerId) || firstFreePort(choice));
  return (
    <form id={formId} action={action} className="flex flex-col gap-2" data-testid="provider-proxy">
      <input type="hidden" name="profileId" value={profileId} />
      <div className="grid grid-cols-[minmax(0,1fr)_168px] gap-2">
        <Field id="proxy-provider" label="Provider">
          <select
            id="proxy-provider"
            name="providerId"
            className="field"
            value={providerId}
            onChange={(e) => {
              const id = e.currentTarget.value;
              setProviderId(id);
              setPort(ownPort(id) || firstFreePort(providers.find((x) => x.id === id)));
            }}
          >
            {providers.map((x) => (
              <option key={x.id} value={x.id} title={x.label}>
                {x.name}
              </option>
            ))}
          </select>
        </Field>
        <Field id="proxy-port" label="Port">
          {choice?.ports ? (
            <select
              id="proxy-port"
              name="port"
              className="field num"
              value={port}
              onChange={(e) => setPort(e.currentTarget.value)}
            >
              <option value="" disabled>
                Pick a port
              </option>
              {choice.ports.map((o) => (
                <option key={o.port} value={o.port} disabled={o.disabled}>
                  {o.label}
                </option>
              ))}
            </select>
          ) : (
            <input
              id="proxy-port"
              name="port"
              className="field num"
              inputMode="numeric"
              value={port}
              onChange={(e) => setPort(e.currentTarget.value)}
            />
          )}
        </Field>
      </div>
      {choice && !choice.ports && choice.usedPorts.length ? (
        <p className="muted m-0 text-[11.5px]">
          In use: {choice.usedPorts.map((u) => `${u.port} · ${u.profileName}`).join(', ')}
        </p>
      ) : null}
      <p className="muted m-0 text-[11.5px]">
        Host and credentials come from the provider in Settings → Proxies. One port per account.
      </p>
    </form>
  );
}

export function ProfileEditor({
  p,
  canEdit,
  isAdmin = false,
  nodeOptions = [],
  providers = [],
}: {
  p: ProfileView;
  canEdit: boolean;
  isAdmin?: boolean;
  nodeOptions?: { id: string; label: string }[];
  /** the workspace's proxy providers (safe fields only) with this profile's port options */
  providers?: ProviderChoice[];
}) {
  const [save, saveAction, saving] = useActionState<ActionState | null, FormData>(saveProxyAction, null);
  const [test, testAction, testing] = useActionState<ActionState | null, FormData>(runProxyTestAction, null);
  const [assign, assignAction, assigning] = useActionState<ActionState | null, FormData>(
    assignProviderPortAction,
    null,
  );
  const providerId = p.proxy?.providerId ?? null;
  // Custom proxy is open when there is no provider, or the profile already uses a one-off proxy.
  const [custom, setCustom] = useState(!providers.length || (p.proxy != null && !providerId));
  const providerFormId = `provider-form-${p.id}`;
  const customFormId = `proxy-form-${p.id}`;
  const own = providerId ? null : p.proxy;
  const [protocol, setProtocol] = useState(own?.protocol ?? (p.proxy ? 'http' : 'none'));
  const provider = own?.provider || 'Own server';
  const services = PROVIDERS.includes(provider) ? PROVIDERS : [provider, ...PROVIDERS];
  const testChip = !p.test ? 'chip-mid' : p.region.mismatch ? 'chip-warn' : 'chip-ok';
  const testLabel = !p.test ? 'Not tested' : p.region.mismatch ? 'Region mismatch' : 'Healthy';
  const disabled = !canEdit;
  const pending = saving || assigning;
  const useCustom = custom || !providers.length;

  return (
    <aside className="panel flex min-w-0 flex-col" aria-labelledby="editor-h" data-testid="profile-editor">
      <div className="sect-h">
        <h2 id="editor-h">{p.name}</h2>
        <span className="muted text-xs">{p.account}</span>
        <div className="flex-1" />
        {canEdit ? (
          <button
            type="submit"
            form={useCustom ? customFormId : providerFormId}
            className="btn btn-primary !h-7"
            disabled={pending}
          >
            {pending ? 'Saving…' : 'Save'}
          </button>
        ) : null}
      </div>
      <BrowserControls p={p} canEdit={canEdit} isAdmin={isAdmin} nodeOptions={nodeOptions} />
      <div className="flex flex-col gap-4 px-[18px] py-4">
        <Status s={useCustom ? save : assign} />
        {!canEdit ? (
          <p className="muted m-0 text-[12.5px]">Only an admin or {p.ownerFirst} can change this profile.</p>
        ) : null}

        <fieldset className="m-0 flex flex-col gap-2.5 border-0 p-0" disabled={disabled}>
          <legend className="mb-2.5 flex items-center gap-2 p-0 text-[12.5px] font-semibold">
            Proxy<span className={`chip ${testChip}`}>{testLabel}</span>
          </legend>
          {providers.length ? (
            <ProviderPort
              formId={providerFormId}
              profileId={p.id}
              providers={providers}
              current={providerId ? { providerId, port: p.proxy?.port ?? '' } : null}
              action={assignAction}
            />
          ) : (
            <p className="muted m-0 text-[11.5px]">
              No proxy provider yet{isAdmin ? ' (add one in Settings → Proxies)' : ''}. Enter a proxy for this
              profile below.
            </p>
          )}
          <details
            open={useCustom}
            onToggle={(e) => setCustom(e.currentTarget.open)}
            className="rounded-[10px] border border-line-soft px-3 py-2"
          >
            <summary className="cursor-pointer text-xs font-semibold">Custom proxy</summary>
            <form
              id={customFormId}
              action={saveAction}
              className="mt-2.5 flex flex-col gap-2.5"
              data-testid="custom-proxy"
            >
              <input type="hidden" name="profileId" value={p.id} />
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
                    defaultValue={own?.host}
                    disabled={protocol === 'none'}
                  />
                </Field>
                <Field id="port" label="Port">
                  <input
                    id="port"
                    name="port"
                    className="field num"
                    inputMode="numeric"
                    defaultValue={own?.port}
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
                    placeholder={own?.hasUsername ? '•••• saved' : 'Not set'}
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
                    placeholder={own?.hasPassword ? '•••• saved' : 'Not set'}
                    aria-describedby="cred-note"
                  />
                </Field>
              </div>
              <p id="cred-note" className="muted m-0 text-[11.5px]">
                Credentials are encrypted and never shown. Leave blank to keep the saved value.
              </p>
              <div className="grid grid-cols-2 gap-2">
                <Field id="prov" label="Service">
                  <select id="prov" name="provider" className="field" defaultValue={provider}>
                    {services.map((o) => (
                      <option key={o}>{o}</option>
                    ))}
                  </select>
                </Field>
                <Field id="sess" label="Session">
                  <select
                    id="sess"
                    name="sticky"
                    className="field"
                    defaultValue={own?.sticky === false ? 'rotate' : 'sticky'}
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
                  defaultValue={own?.region}
                  placeholder="e.g. Boston, US"
                />
              </Field>
            </form>
          </details>
          {p.ownerPlace ? (
            <div className="rounded-[10px] bg-surface-2 px-3 py-2.5 text-[12.5px] leading-snug">
              <div className="font-medium">Keep region where {p.ownerFirst} actually is</div>
              <div className="muted text-xs">{p.ownerPlace} · from their account settings</div>
            </div>
          ) : null}
        </fieldset>
      </div>

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
          {p.test ? (
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
                  <span key="r" className={`chip ${p.test.redditOk ? 'chip-ok' : 'chip-bad'}`}>
                    {p.test.redditOk ? 'Yes · 200' : 'No'}
                  </span>,
                ],
              ]}
            />
          ) : (
            <p className="muted m-0 text-xs">No test has run for this proxy yet.</p>
          )}
          {p.region.mismatch ? (
            <p role="note" className="m-0 rounded-[9px] bg-warn-soft px-3 py-2 text-xs text-warn">
              Region mismatch: the proxy exits in {p.test?.location ?? p.region.label}, but {p.ownerFirst} is
              in {p.ownerPlace ?? p.tz}. Reddit may ask for verification. Pick a proxy near the owner.
            </p>
          ) : null}
        </div>

        <div className="flex flex-col gap-2">
          <div className="text-[12.5px] font-semibold">Browser fingerprint</div>
          <Kv
            rows={[
              ['Device', p.device],
              ['Timezone', p.tz],
              ['Language', p.locale],
              [
                'Cookies',
                `Kept between sessions${p.capturedAt ? ` · logged in since ${new Date(p.capturedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}` : ''}`,
              ],
            ]}
          />
          <div className="muted text-xs leading-normal">
            Copied from {p.ownerFirst}’s own device when they connected the account. Threadline keeps it
            stable; it doesn’t invent a new identity.
          </div>
        </div>

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
            Take over: Admins and {p.ownerFirst} (account owner). Posting from this browser still needs an
            approved draft.
          </div>
        </div>

        <div className="flex gap-2 border-t border-line-soft pt-3.5">
          {canEdit ? (
            <Link href={`/browsers/${p.id}/session`} className="btn">
              Take over browser
            </Link>
          ) : (
            <span className="muted text-xs">Only an admin or the account owner can take over.</span>
          )}
        </div>
      </div>
    </aside>
  );
}
