/**
 * startFakeCdpTarget(): a stand-in for a `tl-profile-<id>` container's browser.
 *
 * It launches Playwright's bundled Chromium with `--remote-debugging-port` (like the CloakBrowser container's
 * CDP on 9222) and serves the Reddit fixture pages from a local HTTP server, so node-agent actions can
 * `chromium.connectOverCDP(target.cdpUrl)` and drive real pages: open a composer, type, submit, read the new
 * item's fullname, and hit verification / login / captcha walls on cue. Nothing leaves 127.0.0.1.
 */
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { type IncomingMessage, type Server, type ServerResponse, createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { type BrowserContext, chromium } from 'playwright-core';
import { FIXTURE_IDS, type RedditPage, readRedditPage } from './fixtures';
import { Recorder, TestkitTimeoutError, delay } from './wait';

export type Wall = 'verification' | 'login' | 'captcha';

export type Submission =
  | { kind: 'comment'; parent: string; text: string; fullname: string }
  | { kind: 'dm'; to: string; subject: string; text: string; fullname: string };

export interface FakeCdpTargetOptions {
  /** IP the fixture site reports to an in-page `fetch('/ip')` (the "page exit IP"). */
  pageIp?: string;
  /** Wall to show from the start (see `setWall`). */
  wall?: Wall | null;
  /** Chromium binary; defaults to `TESTKIT_CHROMIUM_PATH`, else Playwright's bundled one. */
  executablePath?: string;
  headless?: boolean;
}

export interface FakeCdpTarget {
  /** `http://127.0.0.1:<port>`: pass to `chromium.connectOverCDP`. */
  readonly cdpUrl: string;
  readonly cdpPort: number;
  /** Origin of the fixture site. */
  readonly baseUrl: string;
  readonly urls: {
    thread: string;
    /** single-comment permalink with the reply composer open under `t1_kx1aa02` */
    commentPermalink: string;
    dmCompose: string;
    login: string;
    verify: string;
    /** JSON `{ ip }` with `pageIp` */
    ip: string;
  };
  /** Comments and DMs the fixture site accepted. */
  readonly submissions: Recorder<Submission>;
  /** Every request the fixture site served, as `METHOD /path`. */
  readonly requests: Recorder<string>;
  /**
   * Show a wall instead of content pages: `login` and `verification` redirect there (302 with `dest`),
   * `captcha` serves the challenge in place. Submit endpoints answer 403 while a wall is up.
   */
  setWall(wall: Wall | null): void;
  setPageIp(ip: string): void;
  /** The next comment/DM submit answers with this HTTP status (default 500). */
  failNextSubmit(status?: number): void;
  close(): Promise<void>;
}

function chromiumPath(explicit?: string): string | undefined {
  return explicit ?? (process.env.TESTKIT_CHROMIUM_PATH || undefined);
}

let probe: Promise<boolean> | null = null;

/**
 * Resolves true when Playwright can launch Chromium here (the bundled headless shell, or
 * `TESTKIT_CHROMIUM_PATH`). Use it to skip browser tests where no browser is installed:
 * `describe.skipIf(!(await canLaunchChromium()))`. The probe runs once per process.
 */
export function canLaunchChromium(): Promise<boolean> {
  probe ??= chromium
    .launch({ executablePath: chromiumPath(), headless: true })
    .then(async (b) => {
      await b.close();
      return true;
    })
    .catch(() => false);
  return probe;
}

const THREAD_PATH = `/r/${FIXTURE_IDS.subreddit}/comments/1abc2de/looking_for_an_asana_alternative/`;

export async function startFakeCdpTarget(opts: FakeCdpTargetOptions = {}): Promise<FakeCdpTarget> {
  const state = { wall: opts.wall ?? null, pageIp: opts.pageIp ?? '203.0.113.10', failNext: 0, seq: 0 };
  const submissions = new Recorder<Submission>();
  const requests = new Recorder<string>();

  const server = await startFixtureServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://fixture.local');
    const path = url.pathname;
    requests.push(`${req.method} ${path}`);
    const html = (page: RedditPage, status = 200) => {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      res.end(readRedditPage(page));
    };
    const json = (status: number, body: unknown) => {
      res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
      res.end(JSON.stringify(body));
    };
    const content = (page: RedditPage) => {
      if (state.wall === 'captcha') return html('captchaWall');
      if (state.wall) {
        const to = state.wall === 'login' ? '/login/' : '/account/verify/';
        res.writeHead(302, { location: `${to}?dest=${encodeURIComponent(url.pathname + url.search)}` }).end();
        return;
      }
      html(page);
    };

    if (req.method === 'GET') {
      if (path === '/ip') return json(200, { ip: state.pageIp });
      if (path === '/login/') return html('loginWall');
      if (path === '/account/verify/') return html('verificationWall');
      if (path === '/message/compose/') return content('dmCompose');
      const m = path.match(/^\/r\/[^/]+\/comments\/[^/]+\/[^/]+\/(?:([^/]+)\/)?$/);
      if (m) return content(m[1] ? 'commentBox' : 'thread');
      res.writeHead(404).end();
      return;
    }

    if (req.method === 'POST' && (path === '/svc/shreddit/comment' || path === '/api/compose')) {
      const body = JSON.parse((await readBody(req)) || '{}') as Record<string, unknown>;
      if (state.wall) return json(403, { error: 'forbidden' });
      if (state.failNext) {
        const status = state.failNext;
        state.failNext = 0;
        return json(status, { error: 'failed' });
      }
      state.seq += 1;
      const suffix = `tk${state.seq.toString(36).padStart(4, '0')}`;
      if (path === '/svc/shreddit/comment') {
        const fullname = `t1_${suffix}`;
        submissions.push({
          kind: 'comment',
          parent: String(body.parent ?? ''),
          text: String(body.text ?? ''),
          fullname,
        });
        return json(200, { fullname });
      }
      const fullname = `t4_${suffix}`;
      submissions.push({
        kind: 'dm',
        to: String(body.to ?? ''),
        subject: String(body.subject ?? ''),
        text: String(body.text ?? ''),
        fullname,
      });
      return json(200, { fullname });
    }
    res.writeHead(405).end();
  });
  const baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

  const executablePath = chromiumPath(opts.executablePath);
  const userDataDir = await mkdtemp(join(tmpdir(), 'tl-testkit-cdp-'));
  let context: BrowserContext | null = null;
  try {
    context = await chromium.launchPersistentContext(userDataDir, {
      executablePath,
      headless: opts.headless ?? true,
      args: ['--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1', '--no-first-run'],
    });
    const cdpPort = await readDevToolsPort(userDataDir);
    const cdpUrl = `http://127.0.0.1:${cdpPort}`;
    await waitForCdp(cdpUrl);
    const ctx = context;
    return {
      cdpUrl,
      cdpPort,
      baseUrl,
      urls: {
        thread: `${baseUrl}${THREAD_PATH}`,
        commentPermalink: `${baseUrl}${THREAD_PATH}kx1aa02/`,
        dmCompose: `${baseUrl}/message/compose/`,
        login: `${baseUrl}/login/`,
        verify: `${baseUrl}/account/verify/`,
        ip: `${baseUrl}/ip`,
      },
      submissions,
      requests,
      setWall: (wall) => {
        state.wall = wall;
      },
      setPageIp: (ip) => {
        state.pageIp = ip;
      },
      failNextSubmit: (status = 500) => {
        state.failNext = status;
      },
      close: async () => {
        await ctx.close().catch(() => {});
        server.closeAllConnections();
        await new Promise<void>((r) => server.close(() => r()));
        await rm(userDataDir, { recursive: true, force: true });
      },
    };
  } catch (err) {
    await context?.close().catch(() => {});
    server.close();
    await rm(userDataDir, { recursive: true, force: true });
    throw err;
  }
}

async function startFixtureServer(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
): Promise<Server> {
  const server = createServer((req, res) => {
    handler(req, res).catch(() => {
      if (!res.headersSent) res.writeHead(500);
      res.end();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => resolve());
  });
  return server;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** Chromium writes the chosen port to `<userDataDir>/DevToolsActivePort` when started with port 0. */
async function readDevToolsPort(userDataDir: string, timeoutMs = 10_000): Promise<number> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const text = await readFile(join(userDataDir, 'DevToolsActivePort'), 'utf8').catch(() => '');
    const port = Number.parseInt(text.split('\n')[0] ?? '', 10);
    if (port > 0) return port;
    await delay(50);
  }
  throw new TestkitTimeoutError('DevToolsActivePort', timeoutMs);
}

async function waitForCdp(cdpUrl: string, timeoutMs = 10_000): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const ok = await fetch(`${cdpUrl}/json/version`)
      .then((r) => r.ok)
      .catch(() => false);
    if (ok) return;
    await delay(50);
  }
  throw new TestkitTimeoutError(`CDP at ${cdpUrl}`, timeoutMs);
}
