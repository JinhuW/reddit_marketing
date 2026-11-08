// What the probe reads from a page. The page script is a string so this package needs no DOM types; it uses a
// plain JS hash because crypto.subtle is missing on non-secure pages such as about:blank.
import { isIP } from 'node:net';
import { type CdpClient, type ProxyAuth, evaluate, navigate, openPage } from './cdp.ts';

export interface Reading {
  webdriver: boolean | null;
  userAgent: string;
  platform: string;
  languages: string[];
  timezone: string;
  hardwareConcurrency: number;
  deviceMemory: number | null;
  screen: { width: number; height: number; dpr: number; colorDepth: number };
  clientHints: {
    brands: string[];
    mobile: boolean;
    platform: string;
    platformVersion: string | null;
    architecture: string | null;
    model: string | null;
    fullVersionList: string[];
  } | null;
  webgl: { vendor: string | null; renderer: string | null } | null;
  canvasHash: string | null;
  audioHash: string | null;
  /** IP the page sees, from `ipUrl`; null when the probe ran offline. */
  exitIp: string | null;
  secureContext: boolean;
}

export const PAGE_SCRIPT = String.raw`(async () => {
  const hash = (s) => {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < s.length; i++) {
      const c = s.charCodeAt(i);
      h1 = Math.imul(h1 ^ c, 2654435761);
      h2 = Math.imul(h2 ^ c, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0');
  };
  const out = {
    webdriver: navigator.webdriver ?? null,
    userAgent: navigator.userAgent,
    platform: navigator.platform,
    languages: Array.from(navigator.languages || []),
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: navigator.deviceMemory ?? null,
    screen: { width: screen.width, height: screen.height, dpr: devicePixelRatio, colorDepth: screen.colorDepth },
    clientHints: null,
    webgl: null,
    canvasHash: null,
    audioHash: null,
    secureContext: !!window.isSecureContext,
  };
  if (navigator.userAgentData) {
    const d = navigator.userAgentData;
    let high = {};
    try {
      high = await d.getHighEntropyValues(['platformVersion', 'architecture', 'model', 'fullVersionList']);
    } catch {}
    out.clientHints = {
      brands: d.brands.map((b) => b.brand + '/' + b.version),
      mobile: d.mobile,
      platform: d.platform,
      platformVersion: high.platformVersion ?? null,
      architecture: high.architecture ?? null,
      model: high.model ?? null,
      fullVersionList: (high.fullVersionList || []).map((b) => b.brand + '/' + b.version),
    };
  }
  try {
    const gl = document.createElement('canvas').getContext('webgl');
    if (gl) {
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      out.webgl = {
        vendor: ext ? gl.getParameter(ext.UNMASKED_VENDOR_WEBGL) : gl.getParameter(gl.VENDOR),
        renderer: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER),
      };
    }
  } catch {}
  try {
    const c = document.createElement('canvas');
    c.width = 280; c.height = 60;
    const x = c.getContext('2d');
    x.textBaseline = 'top';
    x.font = '16px Arial';
    x.fillStyle = '#f60';
    x.fillRect(100, 1, 62, 20);
    x.fillStyle = '#069';
    x.fillText('Threadline probe \u{1F600} 漢字 <canvas>', 2, 15);
    x.fillStyle = 'rgba(102, 204, 0, 0.7)';
    x.fillText('Threadline probe \u{1F600} 漢字 <canvas>', 4, 17);
    x.beginPath(); x.arc(50, 30, 20, 0, Math.PI * 2); x.stroke();
    out.canvasHash = hash(c.toDataURL());
  } catch {}
  try {
    const ctx = new OfflineAudioContext(1, 5000, 44100);
    const osc = ctx.createOscillator();
    osc.type = 'triangle';
    osc.frequency.value = 10000;
    const comp = ctx.createDynamicsCompressor();
    osc.connect(comp); comp.connect(ctx.destination); osc.start(0);
    const buf = await ctx.startRendering();
    const data = buf.getChannelData(0);
    let s = '';
    for (let i = 4500; i < 5000; i++) s += data[i].toFixed(8);
    out.audioHash = hash(s);
  } catch {}
  return out;
})()`;

/** First IPv4 or IPv6 address in a page body (ipify answers `{"ip":"…"}`, others plain text). */
export function parseIp(text: string): string | null {
  for (const token of text.split(/[^0-9a-fA-F:.]+/)) {
    const t = token.replace(/^[:.]+|[:.]+$/g, (m) => (m === '::' ? m : ''));
    if (t && isIP(t)) return t;
  }
  return null;
}

/**
 * Opens a page, loads `ipUrl` (when given) so the exit IP is read from the page and the readings run in a secure
 * context, then returns the readings.
 */
export async function readPage(
  client: CdpClient,
  opts: { ipUrl: string | null; auth?: ProxyAuth },
): Promise<Reading> {
  const sessionId = await openPage(client, opts.auth);
  let exitIp: string | null = null;
  if (opts.ipUrl) {
    await navigate(client, sessionId, opts.ipUrl);
    exitIp = parseIp(
      await evaluate<string>(client, sessionId, 'document.body ? document.body.innerText : ""'),
    );
  }
  const r = await evaluate<Omit<Reading, 'exitIp'>>(client, sessionId, PAGE_SCRIPT);
  return { ...r, exitIp };
}
