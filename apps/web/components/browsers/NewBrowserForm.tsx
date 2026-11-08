'use client';

import { createBrowserAction } from '@/lib/actions/browsers';
import { useDeviceFingerprint } from '@/lib/use-device-fingerprint';
import { useActionState, useState } from 'react';
import { Msg } from './BrowserControls';
import { COOKIE_PLACEHOLDER } from './BrowserSettings';
import type { ActionState } from './action-state';

function Field({
  id,
  label,
  hint,
  children,
}: { id: string; label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-col gap-[5px] text-[12.5px]">
      <label htmlFor={id} className="text-xs font-semibold">
        {label}
      </label>
      {children}
      {hint ? <span className="muted text-[11.5px]">{hint}</span> : null}
    </div>
  );
}

/**
 * New browser (plan 0003): name, proxy (saved or none), start tab and cookie JSON. The node is picked
 * automatically; the fingerprint follows this device, as in the account connect flow.
 */
export function NewBrowserForm({ proxies }: { proxies: { id: string; label: string }[] }) {
  const [state, act, pending] = useActionState<ActionState | null, FormData>(createBrowserAction, null);
  const fingerprint = useDeviceFingerprint();
  // Controlled, so a refused submit (bad cookie JSON, bad URL) keeps what was typed.
  const [name, setName] = useState('');
  const [proxyId, setProxyId] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [cookies, setCookies] = useState('');

  return (
    <form action={act} className="panel flex flex-col gap-4 px-[18px] py-4" data-testid="new-browser-form">
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <Field id="nb-name" label="Name" hint="Optional. Empty = your first name · Chrome.">
        <input
          id="nb-name"
          name="name"
          className="field"
          maxLength={80}
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field
        id="nb-proxy"
        label="Proxy"
        hint="Saved proxies of this workspace. You can enter a proxy for this browser later."
      >
        <select
          id="nb-proxy"
          name="proxyId"
          className="field"
          value={proxyId}
          onChange={(e) => setProxyId(e.target.value)}
        >
          <option value="">No proxy · direct connection</option>
          {proxies.map((x) => (
            <option key={x.id} value={x.id}>
              {x.label}
            </option>
          ))}
        </select>
      </Field>
      <Field id="nb-start" label="Start tab" hint="Opens on every sign-in. Empty = reddit.com.">
        <input
          id="nb-start"
          name="startUrl"
          className="field"
          inputMode="url"
          placeholder="https://www.reddit.com/"
          value={startUrl}
          onChange={(e) => setStartUrl(e.target.value)}
        />
      </Field>
      <Field
        id="nb-cookies"
        label="Cookie"
        hint="Optional. The JSON export of a cookie extension or another browser tool. Stored encrypted, imported on the first sign-in, never shown again."
      >
        <textarea
          id="nb-cookies"
          name="cookies"
          className="field min-h-[120px] resize-y py-2 font-mono text-[11.5px] leading-snug"
          spellCheck={false}
          autoComplete="off"
          placeholder={COOKIE_PLACEHOLDER}
          value={cookies}
          onChange={(e) => setCookies(e.target.value)}
        />
      </Field>
      <Msg s={state} />
      <div className="flex items-center gap-2 border-t border-line-soft pt-3.5">
        <button type="submit" className="btn btn-primary" disabled={pending}>
          {pending ? 'Creating…' : 'Create browser'}
        </button>
        <span className="muted text-xs">A node is picked for it automatically.</span>
      </div>
    </form>
  );
}
