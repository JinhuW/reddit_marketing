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
export function NewBrowserForm({
  proxies,
  groups = [],
  tags = [],
}: {
  proxies: { id: string; label: string }[];
  groups?: { id: string; name: string }[];
  tags?: { id: string; name: string }[];
}) {
  const [state, act, pending] = useActionState<ActionState | null, FormData>(createBrowserAction, null);
  const fingerprint = useDeviceFingerprint();
  // Controlled, so a refused submit (bad cookie JSON, bad URL) keeps what was typed.
  const [name, setName] = useState('');
  const [proxyId, setProxyId] = useState('');
  const [startUrl, setStartUrl] = useState('');
  const [cookies, setCookies] = useState('');
  // Plan 0004: how many, and where they go in the list.
  const [count, setCount] = useState('1');
  const [groupId, setGroupId] = useState('');
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [extra, setExtra] = useState('');
  const many = Number(count) > 1;

  return (
    <form action={act} className="panel flex flex-col gap-4 px-[18px] py-4" data-testid="new-browser-form">
      <input type="hidden" name="fingerprint" value={fingerprint} />
      <Field
        id="nb-count"
        label="How many"
        hint="1 to 50. More than one makes numbered copies: Shop 1, Shop 2, … each with its own fingerprint."
      >
        <input
          id="nb-count"
          name="count"
          type="number"
          min={1}
          max={50}
          className="field num max-w-[120px]"
          value={count}
          onChange={(e) => setCount(e.target.value)}
        />
      </Field>
      <Field
        id="nb-name"
        label="Name"
        hint={many ? 'Each browser gets a number after it.' : 'Optional. Empty = your first name · Chrome.'}
      >
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
          {proxies.length ? (
            <option value="__random_unused__">Random proxy no browser uses yet</option>
          ) : null}
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
      <Field id="nb-extra" label="More start tabs" hint="Optional. One address per line, up to 9.">
        <textarea
          id="nb-extra"
          name="extraStartUrls"
          className="field min-h-[52px] resize-y py-2 leading-snug"
          spellCheck={false}
          value={extra}
          onChange={(e) => setExtra(e.target.value)}
        />
      </Field>
      {groups.length ? (
        <Field id="nb-group" label="Group">
          <select
            id="nb-group"
            name="groupId"
            className="field"
            value={groupId}
            onChange={(e) => setGroupId(e.target.value)}
          >
            <option value="">No group</option>
            {groups.map((g) => (
              <option key={g.id} value={g.id}>
                {g.name}
              </option>
            ))}
          </select>
        </Field>
      ) : null}
      {tags.length ? (
        <div className="flex flex-col gap-[5px] text-[12.5px]">
          <span className="text-xs font-semibold">Tags</span>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5">
            {tags.map((t) => (
              <label key={t.id} className="flex items-center gap-1.5">
                <input
                  type="checkbox"
                  name="tagIds"
                  value={t.id}
                  className="m-0 accent-[var(--ink)]"
                  checked={tagIds.includes(t.id)}
                  onChange={(e) =>
                    setTagIds((cur) => (e.target.checked ? [...cur, t.id] : cur.filter((x) => x !== t.id)))
                  }
                />
                {t.name}
              </label>
            ))}
          </div>
        </div>
      ) : null}
      <Field id="nb-notes" label="Notes">
        <input
          id="nb-notes"
          name="notes"
          className="field"
          maxLength={2000}
          value={notes}
          onChange={(e) => setNotes(e.target.value)}
        />
      </Field>
      <Field
        id="nb-cookies"
        label="Cookie"
        hint="Optional, for one browser. A cookie export: JSON, a cookies.txt file, or name=value pairs. Stored encrypted, imported on the first sign-in, never shown again."
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
          {pending ? 'Creating…' : many ? `Create ${count} browsers` : 'Create browser'}
        </button>
        <span className="muted text-xs">A node is picked for it automatically.</span>
      </div>
    </form>
  );
}
