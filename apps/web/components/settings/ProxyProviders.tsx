'use client';

import { deleteProxyProviderAction, saveProxyProviderAction } from '@/lib/actions/settings';
import { useActionState, useState } from 'react';
import type { ActionState } from './action-state';

/** A workspace proxy provider as Settings shows it. Never includes credentials. */
export interface ProviderRow {
  id: string;
  name: string;
  protocol: 'http' | 'socks5';
  host: string;
  portFrom: number | null;
  portTo: number | null;
  region: string | null;
  hasUsername: boolean;
  hasPassword: boolean;
  portsInUse: { port: number; profileName: string }[];
}

function Status({ s }: { s: ActionState | null }) {
  if (!s) return null;
  return (
    <p
      role={s.ok ? 'status' : 'alert'}
      className={`m-0 rounded-[9px] px-3 py-2 text-[12.5px] ${s.ok ? 'bg-ok-soft text-ok' : 'bg-bad-soft text-bad'}`}
    >
      {s.message}
    </p>
  );
}

function F({
  id,
  label,
  children,
  grow,
}: { id: string; label: string; children: React.ReactNode; grow?: boolean }) {
  return (
    <div className={`flex flex-col gap-1 text-xs font-semibold ${grow ? 'min-w-[180px] flex-1' : ''}`}>
      <label htmlFor={id}>{label}</label>
      {children}
    </div>
  );
}

function ProviderForm({ row, onDone }: { row: ProviderRow | null; onDone: () => void }) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(async (prev, form) => {
    const r = await saveProxyProviderAction(prev, form);
    if (r.ok) onDone();
    return r;
  }, null);
  return (
    <form
      action={action}
      className="flex flex-col gap-3 border-b border-line-soft px-[18px] py-3"
      aria-label={row ? `Edit ${row.name}` : 'Add a proxy provider'}
      data-testid="provider-form"
    >
      {row ? <input type="hidden" name="id" value={row.id} /> : null}
      <div className="flex flex-wrap items-end gap-2">
        <F id="pv-name" label="Name" grow>
          <input
            id="pv-name"
            name="name"
            required
            className="field"
            defaultValue={row?.name}
            placeholder="Decodo"
          />
        </F>
        <F id="pv-protocol" label="Protocol">
          <select
            id="pv-protocol"
            name="protocol"
            className="field !w-auto"
            defaultValue={row?.protocol ?? 'http'}
          >
            <option value="http">HTTP</option>
            <option value="socks5">SOCKS5</option>
          </select>
        </F>
        <F id="pv-host" label="Host" grow>
          <input
            id="pv-host"
            name="host"
            required
            className="field"
            defaultValue={row?.host}
            placeholder="isp.decodo.com"
          />
        </F>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <F id="pv-ports-from" label="Ports from">
          <input
            id="pv-ports-from"
            name="portFrom"
            className="field num !w-[96px]"
            inputMode="numeric"
            defaultValue={row?.portFrom ?? ''}
            placeholder="10001"
          />
        </F>
        <F id="pv-ports-to" label="Ports to">
          <input
            id="pv-ports-to"
            name="portTo"
            className="field num !w-[96px]"
            inputMode="numeric"
            defaultValue={row?.portTo ?? ''}
            placeholder="10100"
          />
        </F>
        <F id="pv-region" label="Region" grow>
          <input
            id="pv-region"
            name="region"
            className="field"
            defaultValue={row?.region ?? ''}
            placeholder="Optional, e.g. US"
          />
        </F>
      </div>
      <div className="flex flex-wrap items-end gap-2">
        <F id="pv-username" label="Username" grow>
          <input
            id="pv-username"
            name="username"
            className="field"
            autoComplete="off"
            placeholder={row?.hasUsername ? '•••• saved' : 'Not set'}
            aria-describedby="provider-cred-note"
          />
        </F>
        <F id="pv-password" label="Password" grow>
          <input
            id="pv-password"
            name="password"
            type="password"
            className="field"
            autoComplete="new-password"
            placeholder={row?.hasPassword ? '•••• saved' : 'Not set'}
            aria-describedby="provider-cred-note"
          />
        </F>
        <button type="submit" className="btn btn-primary !h-[34px]" disabled={pending}>
          {pending ? 'Saving…' : row ? 'Save provider' : 'Add provider'}
        </button>
        <button type="button" className="btn !h-[34px]" onClick={onDone}>
          Cancel
        </button>
      </div>
      <p id="provider-cred-note" className="muted m-0 text-[11.5px]">
        One username and password for every port. Encrypted and never shown; leave blank to keep the saved
        value. Leave the port range empty to type any port per profile.
      </p>
      <Status s={state} />
    </form>
  );
}

function DeleteButton({ row }: { row: ProviderRow }) {
  const [state, action, pending] = useActionState<ActionState | null, FormData>(
    deleteProxyProviderAction,
    null,
  );
  const inUse = row.portsInUse.length > 0;
  return (
    <form action={action} className="inline-flex flex-col items-end gap-1">
      <input type="hidden" name="id" value={row.id} />
      <button
        type="submit"
        className="btn btn-ghost !h-[26px] !px-2"
        disabled={pending || inUse}
        title={inUse ? 'Move its profiles to another proxy first' : undefined}
        aria-label={`Delete ${row.name}`}
      >
        Delete
      </button>
      {state && !state.ok ? (
        <span role="alert" className="text-xs text-bad">
          {state.message}
        </span>
      ) : null}
    </form>
  );
}

export function ProxyProviders({ rows }: { rows: ProviderRow[] }) {
  // null = closed, 'new' = add form, otherwise the id being edited
  const [editing, setEditing] = useState<string | null>(null);
  const close = () => setEditing(null);
  const editRow = rows.find((r) => r.id === editing) ?? null;
  return (
    <section className="panel" aria-labelledby="proxies-h">
      <div className="sect-h">
        <h2 id="proxies-h">Proxies</h2>
        <span className="muted text-xs">
          {rows.length === 1 ? '1 provider' : `${rows.length} providers`} · each account gets its own port
        </span>
        <div className="flex-1" />
        <button
          type="button"
          className="btn"
          aria-expanded={editing === 'new'}
          onClick={() => setEditing((v) => (v === 'new' ? null : 'new'))}
        >
          Add provider
        </button>
      </div>
      {editing ? <ProviderForm key={editing} row={editRow} onDone={close} /> : null}
      {rows.length ? (
        <div className="overflow-x-auto px-2 pt-1 pb-1.5">
          <table className="tbl" data-testid="provider-table">
            <thead>
              <tr>
                <th>Provider</th>
                <th>Host</th>
                <th>Ports</th>
                <th>Credentials</th>
                <th>In use</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id} data-provider={r.name}>
                  <td>
                    <div className="font-medium">{r.name}</div>
                    {r.region ? <div className="muted text-[11.5px]">{r.region}</div> : null}
                  </td>
                  <td>
                    <div>{r.host}</div>
                    <div className="muted text-[11.5px]">{r.protocol === 'socks5' ? 'SOCKS5' : 'HTTP'}</div>
                  </td>
                  <td className="num whitespace-nowrap">
                    {r.portFrom != null && r.portTo != null ? `${r.portFrom}–${r.portTo}` : 'Any'}
                  </td>
                  <td>
                    <span className={`chip ${r.hasUsername || r.hasPassword ? 'chip-ok' : 'chip-mid'}`}>
                      {r.hasUsername || r.hasPassword ? 'Saved' : 'Not set'}
                    </span>
                  </td>
                  <td data-testid="ports-in-use">
                    {r.portsInUse.length ? (
                      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 text-[12.5px]">
                        {r.portsInUse.map((u) => (
                          <li key={`${u.port}-${u.profileName}`}>
                            <span className="num font-medium">{u.port}</span>{' '}
                            <span className="muted">· {u.profileName}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <span className="muted">None</span>
                    )}
                  </td>
                  <td className="whitespace-nowrap text-right">
                    <div className="inline-flex items-start gap-1">
                      <button
                        type="button"
                        className="btn btn-ghost !h-[26px] !px-2"
                        aria-label={`Edit ${r.name}`}
                        onClick={() => setEditing(r.id)}
                      >
                        Edit
                      </button>
                      <DeleteButton row={r} />
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <p className="muted m-0 px-[18px] pt-2 pb-3.5 text-[13px]">
          No proxy provider yet. Add one (for example Decodo: host, port range, one username and password),
          then pick a port for each profile on the Browsers screen.
        </p>
      )}
    </section>
  );
}
