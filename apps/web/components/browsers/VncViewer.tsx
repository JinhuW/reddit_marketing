'use client';

import { useRef } from 'react';

const TOOLS = [
  {
    label: 'Send keyboard shortcut',
    d: (
      <>
        <rect x="1.5" y="4" width="13" height="8" rx="2" />
        <path d="M4 7h.01M6.5 7h.01M9 7h.01M11.5 7h.01M5 9.5h6" />
      </>
    ),
  },
  {
    label: 'Paste from clipboard',
    d: (
      <>
        <rect x="3.5" y="3" width="9" height="11" rx="1.5" />
        <path d="M6 3V2h4v1" />
      </>
    ),
  },
  {
    label: 'Take screenshot',
    d: (
      <>
        <rect x="2" y="4.5" width="12" height="9" rx="2" />
        <path d="M6 4.5l1-2h2l1 2" />
        <circle cx="8" cy="9" r="2.3" />
      </>
    ),
  },
  { label: 'Quality settings', d: <path d="M2.5 12.5h11M4 10V7.5M8 10V4M12 10V6" /> },
  { label: 'Full screen', d: <path d="M2.5 6V2.5H6M10 2.5h3.5V6M13.5 10v3.5H10M6 13.5H2.5V10" /> },
];

/**
 * Remote browser view. The screen area is where noVNC's RFB client attaches:
 *
 *   // TODO(M6): import RFB from '@novnc/novnc/lib/rfb';
 *   // const rfb = new RFB(screenRef.current, `${wsOrigin}/api/vnc/${profileId}`, { shared: false });
 *   // rfb.scaleViewport = true; rfb.viewOnly = !hasControl;
 *   // toolbar: rfb.sendCtrlAltDel(), rfb.clipboardPasteFrom(text), rfb.toDataURL(), rfb.qualityLevel = n
 *
 * Until the worker starts the profile's container, /api/vnc/<profileId> answers 503 and this shows the waiting state.
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
  const fullscreen = () => screenRef.current?.parentElement?.requestFullscreen?.().catch(() => {});
  return (
    <section
      className="flex min-w-0 flex-col overflow-hidden rounded-panel bg-[#1A1B1E] text-[#E6E6E2]"
      aria-label="Remote browser"
      data-testid="vnc-viewer"
    >
      <div className="flex flex-wrap items-center gap-2 border-b border-[#2C2E33] px-3.5 py-2.5 text-[12.5px]">
        <span className="chip bg-[#2C2E33] text-[#E6E6E2]">
          <span aria-hidden="true" className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-[#9A9DA4]" />
          Waiting for display · {screen}
        </span>
        {exitLine ? <span className="text-[#9A9DA4]">{exitLine}</span> : null}
        <div className="flex-1" />
        {TOOLS.map((t) => (
          <button
            key={t.label}
            type="button"
            aria-label={t.label}
            title={t.label}
            onClick={t.label === 'Full screen' ? fullscreen : undefined}
            className="inline-grid h-[30px] w-[30px] place-items-center rounded-lg border border-[#3F4248] bg-[#2C2E33] p-0 text-[#E6E6E2] hover:bg-[#3F4248]"
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
        ))}
      </div>
      <div className="flex min-h-[560px] flex-1 items-center justify-center bg-[#141518] p-[18px]">
        <div
          ref={screenRef}
          data-vnc-target={`/api/vnc/${profileId}`}
          className="flex max-w-[460px] flex-col items-center gap-2 text-center"
        >
          <div className="h-8 w-8 animate-pulse rounded-full border-2 border-[#3F4248]" aria-hidden="true" />
          <div className="text-sm font-semibold">Connecting to the profile’s display…</div>
          <p className="m-0 text-[12.5px] leading-relaxed text-[#9A9DA4]">
            The worker starts this profile’s browser container (Chromium with its own proxy and saved login
            for {account}). The live view appears here once the container is running.{' '}
            {hasControl ? 'You have control; the agent stays paused until you hand back.' : 'View only.'}
          </p>
        </div>
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
