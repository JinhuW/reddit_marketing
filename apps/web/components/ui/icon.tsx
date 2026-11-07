import type { SVGProps } from 'react';

/** Stroke icons from the Threadline artboards (16×16 grid, currentColor). */
const PATHS = {
  home: (
    <>
      <path d="M2 7.5L8 2.5l6 5V13a1 1 0 01-1 1H3a1 1 0 01-1-1z" />
      <path d="M6 14V9h4v5" />
    </>
  ),
  search: (
    <>
      <circle cx="7" cy="7" r="4.5" />
      <path d="M10.5 10.5L14 14" />
    </>
  ),
  check: <path d="M3 8.5l3 3 7-7" />,
  chat: <path d="M2.5 3.5h11v7h-6l-3 2.5v-2.5h-2z" />,
  leads: (
    <>
      <rect x="2" y="2.5" width="12" height="11" rx="2" />
      <path d="M2 6h12M6 6v7.5" />
    </>
  ),
  analytics: <path d="M2.5 13.5h11M4 10.5V7M8 10.5V4M12 10.5V6" />,
  agent: (
    <>
      <circle cx="8" cy="5" r="2.5" />
      <path d="M3 13.5c0-2.8 2.2-4.5 5-4.5s5 1.7 5 4.5" />
    </>
  ),
  browser: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M2 6h12M4.5 4.5h.01M6.5 4.5h.01" />
    </>
  ),
  account: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="7" r="2" />
      <path d="M4.5 12.5c.8-1.5 2-2.3 3.5-2.3s2.7.8 3.5 2.3" />
    </>
  ),
  tracking: (
    <>
      <path d="M2 12l3.5-4 3 2.5L14 4" />
      <path d="M10.5 4H14v3.5" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2" />
      <path d="M8 1.5v2M8 12.5v2M1.5 8h2M12.5 8h2M3.4 3.4l1.4 1.4M11.2 11.2l1.4 1.4M3.4 12.6l1.4-1.4M11.2 4.8l1.4-1.4" />
    </>
  ),
  work: <path d="M3 12.5l.6-2.4L10 3.7a1.4 1.4 0 012 2L5.6 12z" />,
  crm: (
    <>
      <circle cx="6" cy="5.5" r="2.5" />
      <path d="M1.5 13.5c0-2.5 2-4 4.5-4s4.5 1.5 4.5 4M11 6a2 2 0 010 4M14.5 13.5c0-1.8-1-3-2.5-3.5" />
    </>
  ),
  bot: (
    <>
      <rect x="2.5" y="4.5" width="11" height="8" rx="2.5" />
      <path d="M8 2v2.5M6 8.5h.01M10 8.5h.01" />
    </>
  ),
  workspace: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <circle cx="8" cy="8" r="1.5" />
      <path d="M8 2.5V5M8 11v2.5M2.5 8H5M11 8h2.5" />
    </>
  ),
  chevUp: <path d="M4 10l4-4 4 4" />,
  chevDown: <path d="M4 6l4 4 4-4" />,
  chevDownSm: <path d="M5 7l3 3 3-3" />,
  updown: <path d="M5 6l3-3 3 3M5 10l3 3 3-3" />,
  bell: (
    <>
      <path d="M4 11V7.5a4 4 0 018 0V11l1 1.5H3z" />
      <path d="M6.5 13.5a1.5 1.5 0 003 0" />
    </>
  ),
  panel: (
    <>
      <rect x="2" y="3" width="12" height="10" rx="2" />
      <path d="M6 3v10" />
    </>
  ),
  calendar: (
    <>
      <rect x="2.5" y="3.5" width="11" height="10" rx="2" />
      <path d="M2.5 7h11M5.5 2v3M10.5 2v3" />
    </>
  ),
  plus: <path d="M8 3.5v9M3.5 8h9" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.5" />
      <path d="M8 5v3l2 1.5" />
    </>
  ),
  external: (
    <>
      <path d="M9 3h4v4M13 3L7 9" />
      <path d="M11 9.5V13H3V5h3.5" />
    </>
  ),
  sun: (
    <>
      <circle cx="8" cy="8" r="3" />
      <path d="M8 1.5v1.5M8 13v1.5M1.5 8H3M13 8h1.5M3.4 3.4l1 1M11.6 11.6l1 1M3.4 12.6l1-1M11.6 4.4l1-1" />
    </>
  ),
  moon: <path d="M13 9.5A5.5 5.5 0 116.5 3a4.5 4.5 0 006.5 6.5z" />,
  x: <path d="M4 4l8 8M12 4l-8 8" />,
  logo: (
    <>
      <path d="M3 11.5c0-3 2.2-5 5-5s5 2 5 5M5.5 8.5l-1-3M10.5 8.5l1-3" />
      <circle cx="8" cy="3.2" r=".6" />
    </>
  ),
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({
  name,
  size = 16,
  ...rest
}: { name: IconName; size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      aria-hidden="true"
      viewBox="0 0 16 16"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth={1.75}
      strokeLinecap="round"
      strokeLinejoin="round"
      {...rest}
    >
      {PATHS[name]}
    </svg>
  );
}
