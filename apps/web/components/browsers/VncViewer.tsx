'use client';

import type RFB from '@novnc/novnc/lib/rfb';
import { type ReactNode, useCallback, useEffect, useRef, useState } from 'react';

type ToolId = 'keys' | 'paste' | 'shot' | 'quality' | 'fullscreen';

const TOOLS: { id: ToolId; label: string; d: ReactNode }[] = [
  {
    id: 'keys',
    label: 'Send keyboard shortcut',
    d: (
      <>
        <rect x="1.5" y="4" width="13" height="8" rx="2" />
        <path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" />
      </>
    ),
  },
  {
    id: 'paste',
    label: 'Paste from clipboard',
    d: (
      <>
        <rect x="3.5" y="3" width="9" height="11" rx="1.5" />
        <path d="M6 3V2h4v1" />
      </>
    ),
  },
  {
    id: 'shot',
    label: 'Take screenshot',
    d: (
      <>
        <rect x="2" y="4.5" width="12" height="9" rx="2" />
        <path d="M6 4.5l1-2h2l1 2" />
        <circle cx="8" cy="9" r="2.3" />
      </>
    ),
  },
  { id: 'quality', label: 'Quality settings', d: <path d="M2.5 12.5h11M4 10V7.5M8 10V4M12 10V6" /> },
  {
    id: 'fullscreen',
    label: 'Full screen',
    d: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" />,
  },
];

/** noVNC JPEG quality levels the toolbar cycles through (0–9; 6 is noVNC's default). */
const QUALITY = [
  { level: 6, name: 'Balanced' },
  { level: 9, name: 'Sharp' },
  { level: 3, name: 'Fast' },
] as const;

/** X keysyms for the clipboard shortcuts the viewer forwards itself. */
const XK = { Control_L: 0xffe3, Super_L: 0xffeb } as const;
/** Shortcut letters translated from Cmd to Ctrl, since the remote browser runs on Linux. */
const SHORTCUT_KEYS = new Set(['a', 'c', 'v', 'x', 'z']);

async function readLocalClipboard(): Promise<string> {
  return (await navigator.clipboard?.readText?.().catch(() => '')) ?? '';
}

/** True when the page may read the clipboard without a prompt (so a passive sync stays silent). */
async function clipboardReadGranted(): Promise<boolean> {
  const status = await navigator.permissions
    ?.query({ name: 'clipboard-read' as PermissionName })
    .catch(() => null);
  return status?.state === 'granted';
}

type View =
  | { kind: 'idle' }
  | { kind: 'connecting' }
  | { kind: 'live' }
  | { kind: 'unavailable'; message: string }
  | { kind: 'closed'; message: string };

function statusMessage(status: number | undefined, body: { status?: string } | null): string {
  if (status === 401) return 'Your sign-in expired. Reload the page.';
  if (status === 403) return 'Only an admin or the account owner can open this browser.';
  if (status === 404) return 'This browser profile no longer exists.';
  if (body?.status === 'no_node') return 'This profile is not assigned to a browser node yet.';
  if (body?.status === 'unavailable') return 'Browser nodes are not configured for this workspace.';
  return 'The remote view is not reachable right now.';
}

/**
 * Remote browser view: noVNC's RFB client on the authenticated websocket `/api/vnc/<profileId>` (server.ts →
 * vnc-proxy.ts → node gateway → node agent → the profile container's websockify). It connects only while the
 * viewer holds control: opening the socket takes over the browser, so a watcher without control never connects.
 */
export function VncViewer({
  profileId,
  screen,
  exitLine,
  account,
  hasControl,
}: {
  profileId: string;
  screen: string;
  exitLine: string | null;
  account: string;
  hasControl: boolean;
}) {
  const screenRef = useRef<HTMLDivElement>(null);
  const rfbRef = useRef<RFB | null>(null);
  const [view, setView] = useState<View>({ kind: 'idle' });
  const [quality, setQuality] = useState(0);
  const [attempt, setAttempt] = useState(0);
  /** Last text known to be on both clipboards, so passive syncs do not resend it. */
  const syncedRef = useRef('');

  useEffect(() => {
    if (!hasControl || attempt < 0) {
      setView({ kind: 'idle' });
      return;
    }
    let cancelled = false;
    let rfb: RFB | null = null;
    setView({ kind: 'connecting' });
    (async () => {
      const res = await fetch(`/api/vnc/${profileId}`, { cache: 'no-store' }).catch(() => null);
      if (cancelled) return;
      if (!res?.ok) {
        const body = res ? ((await res.json().catch(() => null)) as { status?: string } | null) : null;
        if (!cancelled) setView({ kind: 'unavailable', message: statusMessage(res?.status, body) });
        return;
      }
      const { default: Rfb } = await import('@novnc/novnc/lib/rfb');
      const target = screenRef.current;
      if (cancelled || !target) return;
      const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      rfb = new Rfb(target, `${proto}//${window.location.host}/api/vnc/${profileId}`, { shared: false });
      rfb.scaleViewport = true;
      rfb.viewOnly = !hasControl;
      rfb.background = '#141518';
      rfb.qualityLevel = QUALITY[0].level;
      rfb.addEventListener('connect', () => {
        if (!cancelled) setView({ kind: 'live' });
      });
      rfb.addEventListener('disconnect', (e) => {
        rfbRef.current = null;
        const clean = (e as CustomEvent<{ clean: boolean }>).detail?.clean;
        if (!cancelled)
          setView({
            kind: 'closed',
            message: clean ? 'The remote view closed.' : 'Lost the connection to the browser.',
          });
      });
      // Remote copy → local clipboard (on by default; x11vnc forwards the browser's CLIPBOARD selection).
      rfb.addEventListener('clipboard', (e) => {
        const text = (e as CustomEvent<{ text: string }>).detail?.text ?? '';
        if (!text) return;
        syncedRef.current = text;
        void navigator.clipboard?.writeText?.(text).catch(() => {});
      });
      rfb.addEventListener('securityfailure', () => {
        if (!cancelled) setView({ kind: 'closed', message: 'The browser refused the display connection.' });
      });
      rfbRef.current = rfb;
      setQuality(0);
    })().catch(() => {
      if (!cancelled) setView({ kind: 'unavailable', message: 'The remote view failed to load.' });
    });
    return () => {
      cancelled = true;
      rfbRef.current = null;
      rfb?.disconnect();
    };
  }, [profileId, hasControl, attempt]);

  const live = view.kind === 'live';

  // Local clipboard → remote, on by default: pasting (Cmd/Ctrl+V) sends the local clipboard first, and
  // pointing at or returning to the view syncs it quietly when clipboard-read is already granted. On macOS,
  // Cmd+A/C/V/X/Z are sent as Ctrl shortcuts because the remote browser runs on Linux.
  useEffect(() => {
    const target = screenRef.current;
    if (!live || !target) return;
    const push = (text: string) => {
      const rfb = rfbRef.current;
      if (!rfb || !text) return;
      rfb.clipboardPasteFrom(text);
      syncedRef.current = text;
    };
    const passiveSync = async () => {
      if (!(await clipboardReadGranted())) return;
      const text = await readLocalClipboard();
      if (text && text !== syncedRef.current) push(text);
    };
    const onKeyDown = (e: KeyboardEvent) => {
      const key = e.key.toLowerCase();
      if (e.altKey || e.shiftKey || !(e.metaKey || e.ctrlKey) || !SHORTCUT_KEYS.has(key)) return;
      if (!e.metaKey && key !== 'v') return; // plain Ctrl shortcuts already reach the remote as-is
      e.preventDefault();
      e.stopPropagation();
      const viaMeta = e.metaKey;
      void (async () => {
        if (key === 'v') push(await readLocalClipboard());
        const rfb = rfbRef.current;
        if (!rfb) return;
        const keysym = key.charCodeAt(0);
        const code = `Key${key.toUpperCase()}`;
        if (viaMeta) {
          rfb.sendKey(XK.Super_L, 'MetaLeft', false);
          rfb.sendKey(XK.Control_L, 'ControlLeft', true);
        }
        rfb.sendKey(keysym, code, true);
        rfb.sendKey(keysym, code, false);
        if (viaMeta) rfb.sendKey(XK.Control_L, 'ControlLeft', false);
      })();
    };
    const onEnter = () => void passiveSync();
    target.addEventListener('keydown', onKeyDown, true);
    target.addEventListener('pointerenter', onEnter);
    window.addEventListener('focus', onEnter);
    void passiveSync();
    return () => {
      target.removeEventListener('keydown', onKeyDown, true);
      target.removeEventListener('pointerenter', onEnter);
      window.removeEventListener('focus', onEnter);
    };
  }, [live]);

  const run = useCallback(
    async (id: ToolId) => {
      if (id === 'fullscreen') {
        await screenRef.current?.parentElement?.requestFullscreen?.().catch(() => {});
        return;
      }
      const rfb = rfbRef.current;
      if (!rfb || !live) return;
      if (id === 'keys') rfb.sendCtrlAltDel();
      else if (id === 'paste') {
        const text = await readLocalClipboard();
        if (text) {
          rfb.clipboardPasteFrom(text);
          syncedRef.current = text;
        }
      } else if (id === 'shot') {
        const a = document.createElement('a');
        a.href = rfb.toDataURL('image/png');
        a.download = `${account.replace(/[^\w.-]+/g, '_')}-${new Date().toISOString().slice(0, 19)}.png`;
        a.click();
      } else if (id === 'quality') {
        const next = (quality + 1) % QUALITY.length;
        rfb.qualityLevel = QUALITY[next]?.level ?? 6;
        setQuality(next);
      }
      rfb.focus();
    },
    [account, live, quality],
  );

  const chip =
    view.kind === 'live'
      ? { dot: 'bg-ok', text: `Live · ${screen}` }
      : view.kind === 'connecting'
        ? { dot: 'bg-[#9A9DA4] animate-pulse', text: `Connecting · ${screen}` }
        : view.kind === 'closed' || view.kind === 'unavailable'
          ? { dot: 'bg-warn', text: `Disconnected · ${screen}` }
          : { dot: 'bg-[#9A9DA4]', text: `Live view off · ${screen}` };
  const failed = view.kind === 'unavailable' || view.kind === 'closed';
  const heading = failed
    ? 'The live view is not connected'
    : view.kind === 'connecting'
      ? 'Connecting to the profile’s display…'
      : 'Live view is off';

  return (
    <section
      className="flex min-w-0 flex-col overflow-hidden rounded-panel bg-[#1A1B1E] text-[#E6E6E2]"
      aria-label="Remote browser"
      data-testid="vnc-viewer"
      data-vnc-state={view.kind}
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[#2C2E33] px-3.5 py-2.5 text-[12.5px]">
        <span className="chip bg-[#2C2E33] text-[#E6E6E2]">
          <span aria-hidden="true" className={`mr-1.5 inline-block h-1.5 w-1.5 rounded-full ${chip.dot}`} />
          {chip.text}
        </span>
        {exitLine ? <span className="text-[#9A9DA4]">{exitLine}</span> : null}
        <div className="flex-1" />
        {TOOLS.map((t) => {
          const title = t.id === 'quality' ? `${t.label} · ${QUALITY[quality]?.name ?? 'Balanced'}` : t.label;
          return (
            <button
              key={t.id}
              type="button"
              aria-label={t.label}
              title={title}
              disabled={t.id !== 'fullscreen' && !live}
              onClick={() => void run(t.id)}
              className="inline-grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#3F4248] bg-[#2C2E33] p-0 text-[#E6E6E2] hover:bg-[#3F4248] disabled:cursor-not-allowed disabled:opacity-50 disabled:hover:bg-[#2C2E33]"
            >
              <svg
                aria-hidden="true"
                viewBox="0 0 16 16"
                width={15}
                height={15}
                fill="none"
                stroke="currentColor"
                strokeWidth={1.75}
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                {t.d}
              </svg>
            </button>
          );
        })}
      </div>
      <div className="relative flex min-h-[560px] flex-1 bg-[#141518]">
        {/* noVNC attaches its canvas here; React renders nothing inside it. */}
        <div ref={screenRef} data-vnc-target={`/api/vnc/${profileId}`} className="absolute inset-0" />
        {live ? null : (
          <div className="absolute inset-0 flex items-center justify-center p-[18px]">
            <div className="flex max-w-[460px] flex-col items-center gap-2 text-center">
              <div
                className={`h-8 w-8 rounded-full border-2 border-[#3F4248] ${view.kind === 'connecting' ? 'animate-pulse' : ''}`}
                aria-hidden="true"
              />
              <div className="text-sm font-semibold">{heading}</div>
              {failed ? (
                <>
                  <p className="m-0 text-[12.5px] leading-relaxed text-[#E6E6E2]" data-testid="vnc-message">
                    {view.message}
                  </p>
                  <button
                    type="button"
                    onClick={() => setAttempt((n) => n + 1)}
                    className="rounded-lg border border-[#3F4248] bg-[#2C2E33] px-3 py-1.5 text-[12.5px] text-[#E6E6E2] hover:bg-[#3F4248]"
                  >
                    Try again
                  </button>
                </>
              ) : view.kind === 'connecting' ? (
                <p className="m-0 text-[12.5px] leading-relaxed text-[#9A9DA4]">
                  The worker starts this profile’s browser container (Chromium with its own proxy and saved
                  login for {account}). The live view appears here once the container is running. You have
                  control; the agent stays paused until you hand back.
                </p>
              ) : (
                <p className="m-0 text-[12.5px] leading-relaxed text-[#9A9DA4]" data-testid="vnc-message">
                  Opening the live view takes the browser over, so it stays closed until you take control.
                </p>
              )}
            </div>
          </div>
        )}
      </div>
      <div className="flex flex-wrap items-center gap-2.5 border-t border-[#2C2E33] px-3.5 py-2.5 text-xs text-[#9A9DA4]">
        <span aria-hidden="true" className="relative inline-block h-[18px] w-[18px] rounded-full bg-accent">
          <span className="absolute inset-1 rounded-full bg-white" />
        </span>
        <span>
          Recording for the audit log · everything you post here still counts toward {account}’s daily limit
        </span>
        <div className="flex-1" />
        <span>Session ends after 15 min idle</span>
      </div>
    </section>
  );
}
