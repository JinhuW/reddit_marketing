'use client';

import type RFB from '@novnc/novnc/lib/rfb';
import { useRouter } from 'next/navigation';
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
  const router = useRouter();

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
        // The session may have ended (hand-back, or 15 min idle): re-render so the page shows Take over again.
        if (!cancelled) router.refresh();
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
  }, [profileId, hasControl, attempt, router]);

  const live = view.kind === 'live';

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
        const text = await navigator.clipboard?.readText().catch(() => '');
        if (text) rfb.clipboardPasteFrom(text);
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
          : { dot: 'bg-[#9A9DA4]', text: `Waiting for display · ${screen}` };

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
              <div className="text-sm font-semibold" data-testid="vnc-heading">
                {view.kind === 'connecting'
                  ? 'Connecting to the profile’s display…'
                  : view.kind === 'idle'
                    ? 'Not connected'
                    : 'Disconnected'}
              </div>
              {view.kind === 'idle' ? (
                <p className="m-0 text-[12.5px] leading-relaxed text-[#E6E6E2]" data-testid="vnc-message">
                  You don’t have control of this browser, so the live view is off.{' '}
                  <a href="#take-h" className="underline">
                    Take over
                  </a>{' '}
                  to start the browser and open it here.
                </p>
              ) : view.kind === 'unavailable' || view.kind === 'closed' ? (
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
              ) : (
                <p className="m-0 text-[12.5px] leading-relaxed text-[#9A9DA4]">
                  The worker starts this profile’s browser container (Chromium with its own proxy and saved
                  login for {account}). The live view appears here once the container is running. You have
                  control; the agent stays paused until you hand back.
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
