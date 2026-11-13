'use client';

import { newFingerprintAction, saveFingerprintAction } from '@/lib/actions/browser-list';
import {
  CPU_OPTIONS,
  GPU_OPTIONS,
  MEMORY_OPTIONS,
  SCREEN_PRESETS,
  localeForCountry,
} from '@threadline/shared';
import { startTransition, useActionState, useEffect, useState } from 'react';
import { Msg } from './BrowserControls';
import type { ActionState } from './action-state';
import type { ProfileView } from './view';

const GPU_LABEL: Record<string, string> = { intel: 'Intel', nvidia: 'NVIDIA', amd: 'AMD' };
const PERSONA_LABEL: Record<string, string> = { windows: 'Windows', macos: 'macOS', linux: 'Linux' };

function Row({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="grid grid-cols-[110px_minmax(0,1fr)] items-center gap-x-2.5">
      <label htmlFor={id} className="text-muted">
        {label}
      </label>
      <div className="flex min-w-0 items-center gap-1.5">{children}</div>
    </div>
  );
}

/**
 * Drawer "Browser fingerprint" (plan 0004 phase 2). The settings a person may change are a form; what the seed
 * decides (canvas, WebGL, audio, fonts, the GPU model) is listed as fixed. A new seed or GPU vendor needs the
 * browser's data cleared, because the volume is locked to the fingerprint it first ran with.
 */
export function FingerprintSection({
  p,
  canEdit,
  canReset = canEdit,
}: {
  p: ProfileView;
  canEdit: boolean /** a new fingerprint deletes data: control, not just management */;
  canReset?: boolean;
}) {
  const [saved, save, saving] = useActionState<ActionState | null, FormData>(saveFingerprintAction, null);
  const [renewed, renew, renewing] = useActionState<ActionState | null, FormData>(newFingerprintAction, null);
  const f = p.fp;
  const [tzMode, setTzMode] = useState(f.tzMode);
  const [localeMode, setLocaleMode] = useState(f.localeMode);
  // Controlled: React clears uncontrolled fields after an action, and a refused submit must keep the choice.
  const [gpu, setGpu] = useState(f.gpu);
  const [confirmed, setConfirmed] = useState(false);
  // One confirmation per new fingerprint: a finished one unticks the box.
  useEffect(() => {
    if (renewed?.ok) setConfirmed(false);
  }, [renewed]);
  // The browser's own list of time zones, for suggestions; the server validates whatever is sent.
  const [zones, setZones] = useState<string[]>([]);
  useEffect(() => {
    try {
      setZones(Intl.supportedValuesOf('timeZone'));
    } catch {
      // older browser: free text still works
    }
  }, []);
  const proxyLocale = localeForCountry(f.proxyCountry);
  const id = (k: string) => `fp-${k}-${p.id}`;

  return (
    <div className="flex flex-col gap-2.5 text-[12.5px]" data-testid="fingerprint">
      <div className="font-semibold">Browser fingerprint</div>
      <dl className="m-0 grid grid-cols-[110px_minmax(0,1fr)] gap-x-2.5 gap-y-1.5">
        <dt className="m-0 text-muted">Device</dt>
        <dd className="m-0 font-medium">
          {PERSONA_LABEL[f.persona] ?? f.persona} · {GPU_LABEL[f.gpu] ?? f.gpu} graphics
        </dd>
        <dt className="m-0 text-muted">From the seed</dt>
        <dd className="m-0">Canvas, WebGL, audio, fonts, client rects, GPU model</dd>
        <dt className="m-0 text-muted">Cookies</dt>
        <dd className="m-0">
          Kept between sessions
          {p.capturedAt
            ? ` · since ${new Date(p.capturedAt).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`
            : ''}
        </dd>
      </dl>

      <form
        // Re-seeded when the saved values change (a save here, or a new fingerprint).
        key={JSON.stringify(f)}
        // Sent by `onSubmit` once the page is interactive, so a refused save keeps what was typed (a form
        // `action` resets the fields). `action` stays as what a click before hydration runs.
        action={save}
        onSubmit={(e) => {
          e.preventDefault();
          const data = new FormData(e.currentTarget);
          startTransition(() => save(data));
        }}
        className="flex flex-col gap-2 rounded-[12px] border border-line-soft px-3.5 py-3"
      >
        <input type="hidden" name="profileId" value={p.id} />
        <fieldset className="m-0 flex flex-col gap-2 border-0 p-0" disabled={!canEdit}>
          <Row id={id('screen')} label="Screen">
            <input
              id={id('screen')}
              name="screen"
              className="field num !h-7"
              defaultValue={f.screen}
              list={id('screens')}
              placeholder="1920x1080"
              required
            />
            <datalist id={id('screens')}>
              {SCREEN_PRESETS.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
          </Row>
          <Row id={id('tzMode')} label="Time zone">
            <select
              id={id('tzMode')}
              name="tzMode"
              className="field !h-7"
              value={tzMode}
              onChange={(e) => setTzMode(e.target.value as typeof tzMode)}
            >
              <option value="custom">Custom</option>
              <option value="proxy">Match proxy IP</option>
            </select>
          </Row>
          {/* Always submitted: it is the fallback while the proxy has no test yet. */}
          <div className={tzMode === 'proxy' ? 'hidden' : 'pl-[120px]'}>
            <input
              name="tz"
              className="field !h-7"
              defaultValue={f.tz}
              list={id('zones')}
              aria-label="Custom time zone"
              placeholder="America/New_York"
              required
            />
            <datalist id={id('zones')}>
              {zones.map((z) => (
                <option key={z} value={z} />
              ))}
            </datalist>
          </div>
          {tzMode === 'proxy' ? (
            <p className="muted m-0 pl-[120px] text-[11.5px]">
              {f.proxyZone
                ? `The last proxy test says ${f.proxyZone}.`
                : `No proxy test yet: ${f.tz} is used until one runs.`}
            </p>
          ) : null}
          <Row id={id('localeMode')} label="Language">
            <select
              id={id('localeMode')}
              name="localeMode"
              className="field !h-7"
              value={localeMode}
              onChange={(e) => setLocaleMode(e.target.value as typeof localeMode)}
            >
              <option value="custom">Custom</option>
              <option value="proxy">Match proxy IP</option>
            </select>
          </Row>
          <div className={localeMode === 'proxy' ? 'hidden' : 'pl-[120px]'}>
            <input
              name="locale"
              className="field !h-7"
              defaultValue={f.locale}
              aria-label="Custom language"
              placeholder="en-US"
              required
            />
          </div>
          {localeMode === 'proxy' ? (
            <p className="muted m-0 pl-[120px] text-[11.5px]">
              {proxyLocale
                ? `The last proxy test says ${f.proxyCountry}: ${proxyLocale}.`
                : `No usable proxy test yet: ${f.locale} is used until one runs.`}
            </p>
          ) : null}
          <Row id={id('cpu')} label="CPU cores">
            <select id={id('cpu')} name="cpu" className="field !h-7" defaultValue={f.cpu ?? ''}>
              <option value="">From the seed</option>
              {CPU_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Row>
          <Row id={id('mem')} label="Memory">
            <select id={id('mem')} name="memoryGb" className="field !h-7" defaultValue={f.memoryGb ?? ''}>
              <option value="">From the seed</option>
              {MEMORY_OPTIONS.map((n) => (
                <option key={n} value={n}>
                  {n} GB
                </option>
              ))}
            </select>
          </Row>
          <Row id={id('webrtc')} label="WebRTC">
            <select id={id('webrtc')} name="webrtc" className="field !h-7" defaultValue={f.webrtc}>
              <option value="disable_udp">Proxy only: no address leaks</option>
              <option value="replace">Replace with the proxy IP</option>
              <option value="real" disabled={f.behindProxy}>
                Real{f.behindProxy ? ' (not behind a proxy)' : ''}
              </option>
            </select>
          </Row>
          <label className="flex items-center gap-2 pl-[120px]">
            <input
              type="checkbox"
              name="noise"
              defaultChecked={f.noise}
              className="m-0 accent-[var(--ink)]"
            />
            Canvas, WebGL and audio noise
          </label>
          {canEdit ? (
            <div className="flex items-center gap-2">
              <button type="submit" className="btn !h-7" disabled={saving}>
                {saving ? 'Saving…' : 'Save fingerprint'}
              </button>
              <span className="muted text-[11.5px]">Applies at the next start.</span>
            </div>
          ) : null}
        </fieldset>
        <Msg s={saved} />
      </form>

      {canReset ? (
        <details className="rounded-[12px] border border-line-soft px-3.5 py-2.5">
          <summary className="cursor-pointer font-semibold">New fingerprint</summary>
          <form
            // Sent by `onSubmit`: a form `action` makes React reset the fields afterwards, which would silently
            // put the graphics choice and the confirmation back after a refused submit.
            action={renew}
            onSubmit={(e) => {
              e.preventDefault();
              const data = new FormData(e.currentTarget);
              startTransition(() => renew(data));
            }}
            className="mt-2.5 flex flex-col gap-2"
          >
            <input type="hidden" name="profileId" value={p.id} />
            <p className="muted m-0 text-xs leading-normal">
              Makes this browser a different device: a new seed, so a new canvas, WebGL, audio and font
              fingerprint. Its cookies, cache and sign-in are deleted first, because a device that changes
              hardware under the same cookies stands out.
            </p>
            <Row id={id('gpu')} label="Graphics">
              <select
                id={id('gpu')}
                name="gpu"
                className="field !h-7"
                value={gpu}
                onChange={(e) => setGpu(e.target.value)}
              >
                {[...new Set([...GPU_OPTIONS, f.gpu])].map((g) => (
                  <option key={g} value={g}>
                    {GPU_LABEL[g] ?? g}
                  </option>
                ))}
              </select>
            </Row>
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                name="confirm"
                className="m-0 accent-[var(--ink)]"
                checked={confirmed}
                onChange={(e) => setConfirmed(e.target.checked)}
              />
              Delete this browser’s cookies and sign-in
            </label>
            <button type="submit" className="btn !h-7 self-start text-bad" disabled={renewing}>
              {renewing ? 'Working…' : 'New fingerprint'}
            </button>
          </form>
          <Msg s={renewed} />
        </details>
      ) : null}
      <div className="muted text-xs leading-normal">
        First copied from {p.ownerFirst}’s own device when they{' '}
        {p.accountInfo ? 'connected the account' : 'created the browser'}. Threadline keeps it stable between
        sessions.
      </div>
    </div>
  );
}
