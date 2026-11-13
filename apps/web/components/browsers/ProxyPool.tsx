'use client';

import {
  addProxyAction,
  bulkAddProxiesAction,
  proxyBulkAction,
  updateProxyAction,
} from '@/lib/actions/browser-proxies';
import Link from 'next/link';
import { startTransition, useActionState, useEffect, useState } from 'react';
import { Msg } from './BrowserControls';
import type { ActionState } from './action-state';
import type { ProxyRow } from './proxy-view';

export const PROXY_FORM = 'proxy-bulk-form';
const boxes = () => [
  ...document.querySelectorAll<HTMLInputElement>(`input[name="ids"][form="${PROXY_FORM}"]`),
];
const PASTE_HINT = `gate.example.com:7000:username:password
username:password@203.0.113.5:8080
socks5://username:password@203.0.113.9:1080 {US mobile 3} [https://vendor.example/change-ip?token=…]`;

type Act = (prev: ActionState | null, form: FormData) => Promise<ActionState>;
/**
 * A form that keeps what was typed when its submit is refused. Once the page is interactive `onSubmit` sends the
 * data itself, because a form `action` makes React reset the fields afterwards. `action` stays set as well: it
 * is what a click before hydration runs, and without it the browser would submit a plain GET and put the typed
 * login in the URL.
 */
function useKeepingForm(fn: Act) {
  const [state, run, busy] = useActionState<ActionState | null, FormData>(fn, null);
  // Set once the page is interactive; tests wait for it before typing.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  const onSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    startTransition(() => run(data));
  };
  return { state, busy, form: { action: run, onSubmit, 'data-ready': ready ? 'true' : undefined } };
}

function F({
  id,
  label,
  children,
  wide,
}: { id: string; label: string; children: React.ReactNode; wide?: boolean }) {
  return (
    <div className={`flex flex-col gap-[5px] ${wide ? 'sm:col-span-2' : ''}`}>
      <label htmlFor={id} className="text-xs font-semibold">
        {label}
      </label>
      {children}
    </div>
  );
}

function ProxyFields({ p, idp, editing }: { p?: ProxyRow['edit']; idp: string; editing?: boolean }) {
  return (
    <div className="grid gap-2.5 sm:grid-cols-2">
      <F id={`${idp}-label`} label="Name">
        <input
          id={`${idp}-label`}
          name="label"
          className="field"
          maxLength={80}
          defaultValue={p?.label}
          placeholder="US mobile 3"
        />
      </F>
      <F id={`${idp}-protocol`} label="Type">
        <select id={`${idp}-protocol`} name="protocol" className="field" defaultValue={p?.protocol ?? 'http'}>
          <option value="http">HTTP</option>
          <option value="socks5">SOCKS5</option>
        </select>
      </F>
      <F id={`${idp}-host`} label="Host">
        <input
          id={`${idp}-host`}
          name="host"
          className="field"
          defaultValue={p?.host}
          placeholder="gate.example.com"
          required
        />
      </F>
      <F id={`${idp}-port`} label="Port">
        <input
          id={`${idp}-port`}
          name="port"
          className="field num"
          inputMode="numeric"
          defaultValue={p?.port}
          placeholder="7000"
          required
        />
      </F>
      <F id={`${idp}-user`} label="Username">
        <input
          id={`${idp}-user`}
          name="username"
          className="field"
          autoComplete="off"
          placeholder={editing ? 'Leave empty to keep' : ''}
        />
      </F>
      <F id={`${idp}-pass`} label="Password">
        <input
          id={`${idp}-pass`}
          name="password"
          type="password"
          className="field"
          autoComplete="new-password"
          placeholder={editing ? 'Leave empty to keep' : ''}
        />
      </F>
      <F id={`${idp}-sticky`} label="IP">
        <select
          id={`${idp}-sticky`}
          name="sticky"
          className="field"
          defaultValue={p && !p.sticky ? 'rotate' : 'sticky'}
        >
          <option value="sticky">Sticky: one IP</option>
          <option value="rotate">Rotating</option>
        </select>
      </F>
      <F id={`${idp}-region`} label="Region">
        <input
          id={`${idp}-region`}
          name="region"
          className="field"
          maxLength={120}
          defaultValue={p?.region}
          placeholder="Boston, US"
        />
      </F>
      <F id={`${idp}-refresh`} label="Change-IP link" wide>
        <input
          id={`${idp}-refresh`}
          name="refreshUrl"
          className="field"
          inputMode="url"
          autoComplete="off"
          placeholder={editing ? 'Leave empty to keep' : 'https://… (mobile proxies)'}
        />
      </F>
      <F id={`${idp}-notes`} label="Notes" wide>
        <input id={`${idp}-notes`} name="notes" className="field" maxLength={500} defaultValue={p?.notes} />
      </F>
      {p ? <input type="hidden" name="provider" value={p.provider} /> : null}
    </div>
  );
}

/** "Add proxies" (plan 0004 phase 3): one typed in, or a pasted list. */
export function AddProxies() {
  const one = useKeepingForm(addProxyAction);
  const many = useKeepingForm(bulkAddProxiesAction);
  const [lines, setLines] = useState('');
  useEffect(() => {
    if (many.state?.ok) setLines('');
  }, [many.state]);
  return (
    <section
      className="panel grid gap-5 px-[18px] py-4 text-[12.5px] lg:grid-cols-2"
      data-testid="add-proxies"
    >
      <form {...many.form} className="flex flex-col gap-2.5">
        <h2 className="m-0 text-[13px] font-semibold">Bulk add</h2>
        <label htmlFor="px-lines" className="muted text-xs">
          One proxy per line. Optional: a note in {'{ }'} and a change-IP link in [ ].
        </label>
        <textarea
          id="px-lines"
          name="lines"
          className="field num min-h-[132px] resize-y py-2 font-mono text-[11.5px] leading-snug"
          spellCheck={false}
          autoComplete="off"
          placeholder={PASTE_HINT}
          value={lines}
          onChange={(e) => setLines(e.target.value)}
        />
        <div className="flex items-center gap-2">
          <label htmlFor="px-default" className="muted text-xs">
            Lines with no scheme are
          </label>
          <select id="px-default" name="protocol" className="field !h-7 !w-auto" defaultValue="http">
            <option value="http">HTTP</option>
            <option value="socks5">SOCKS5</option>
          </select>
          <div className="flex-1" />
          <button type="submit" className="btn btn-primary !h-7" disabled={many.busy}>
            {many.busy ? 'Adding…' : 'Add proxies'}
          </button>
        </div>
        <Msg s={many.state} />
      </form>
      <form {...one.form} className="flex flex-col gap-2.5">
        <h2 className="m-0 text-[13px] font-semibold">Add one</h2>
        <ProxyFields idp="px-new" />
        <button type="submit" className="btn !h-7 self-start" disabled={one.busy}>
          {one.busy ? 'Adding…' : 'Add proxy'}
        </button>
        <Msg s={one.state} />
      </form>
    </section>
  );
}

/** The edit panel, opened with `?edit=<id>`. Empty login and link fields keep what is stored. */
export function EditProxy({ row }: { row: ProxyRow }) {
  const f = useKeepingForm(updateProxyAction);
  return (
    <section className="panel flex flex-col gap-3 px-[18px] py-4 text-[12.5px]" data-testid="edit-proxy">
      <div className="flex items-center gap-2">
        <h2 className="m-0 text-[13px] font-semibold">Edit {row.title}</h2>
        <span className="muted text-xs">
          {row.browsers
            ? `Used by ${row.browsers} ${row.browsers === 1 ? 'browser' : 'browsers'}: they get the change at their next start.`
            : 'No browser uses this proxy.'}
        </span>
        <div className="flex-1" />
        <Link href="/browsers/proxies" className="btn btn-ghost !h-7">
          Close
        </Link>
      </div>
      <form {...f.form} className="flex max-w-[640px] flex-col gap-2.5">
        <input type="hidden" name="id" value={row.id} />
        <ProxyFields p={row.edit} idp="px-edit" editing />
        <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
          <span className="muted text-xs">
            Login: {row.hasLogin ? 'saved' : 'none'} · Change-IP link: {row.hasRefreshUrl ? 'saved' : 'none'}
          </span>
          {row.hasLogin ? (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="clearLogin" className="m-0 accent-[var(--ink)]" />
              Remove the saved login
            </label>
          ) : null}
          {row.hasRefreshUrl ? (
            <label className="flex items-center gap-1.5">
              <input type="checkbox" name="clearRefresh" className="m-0 accent-[var(--ink)]" />
              Remove the change-IP link
            </label>
          ) : null}
        </div>
        <button type="submit" className="btn btn-primary !h-7 self-start" disabled={f.busy}>
          {f.busy ? 'Saving…' : 'Save proxy'}
        </button>
        <Msg s={f.state} />
      </form>
    </section>
  );
}

function Op({
  op,
  children,
  danger,
  disabled,
}: { op: string; children: string; danger?: boolean; disabled: boolean }) {
  return (
    <button
      type="submit"
      name="op"
      value={op}
      className={`btn !h-7 ${danger ? 'text-bad' : ''}`}
      disabled={disabled}
    >
      {children}
    </button>
  );
}

/** Bulk bar of the pool. The row checkboxes join this form through their `form` attribute. */
export function ProxyBulkBar({ isAdmin }: { isAdmin: boolean }) {
  const [state, act, busy] = useActionState<ActionState | null, FormData>(proxyBulkAction, null);
  const [count, setCount] = useState(0);
  useEffect(() => {
    const recount = () => setCount(boxes().filter((b) => b.checked).length);
    recount();
    document.addEventListener('change', recount);
    return () => document.removeEventListener('change', recount);
  }, []);
  useEffect(() => {
    if (!state?.ok) return;
    for (const b of boxes()) b.checked = false;
    const all = document.querySelector<HTMLInputElement>('input[data-select-all-proxies]');
    if (all) all.checked = false;
    setCount(0);
  }, [state]);
  const none = count === 0 || busy;
  return (
    <div
      className="flex flex-col gap-2 border-b border-line-soft px-[18px] py-2.5"
      data-testid="proxy-bulk-bar"
    >
      <form id={PROXY_FORM} action={act} className="flex flex-wrap items-center gap-2 text-[12.5px]">
        <span className="num font-semibold" aria-live="polite" data-testid="proxy-count">
          {count} selected
        </span>
        <Op op="check" disabled={none}>
          Check
        </Op>
        <Op op="rotate" disabled={none}>
          Change IP
        </Op>
        <Op op="delete" danger disabled={none}>
          Delete
        </Op>
        {isAdmin ? (
          <Op op="delete_detach" danger disabled={none}>
            Delete even if in use
          </Op>
        ) : null}
      </form>
      <Msg s={state} />
    </div>
  );
}

export function SelectAllProxies() {
  return (
    <input
      type="checkbox"
      data-select-all-proxies
      aria-label="Select every proxy"
      className="m-0 h-[15px] w-[15px] accent-[var(--ink)]"
      onChange={(e) => {
        for (const b of boxes()) b.checked = e.currentTarget.checked;
        document.dispatchEvent(new Event('change'));
      }}
    />
  );
}
