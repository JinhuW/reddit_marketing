/**
 * One action's hold on a profile's browser: `connectOverCDP` to `tl-profile-<id>:9222` (the container's CDP front
 * proxy, apps/browser-profile), a fresh tab in the profile's persistent context, proxy auth over CDP, and teardown.
 *
 * All traffic goes through the page. Never use `context.request` / `APIRequestContext`: it bypasses the
 * browser's credentialed proxy (ADR-0001), so it would leak the node's own IP to Reddit.
 */
import { type Browser, type Page, type Response, chromium } from 'playwright-core';
import type { HandlerContext } from '../registry';
import { attachProxyAuth } from './proxy-auth';
import type { ProxyLookup } from './proxy-store';

export const CDP_PORT = 9222;
export const defaultCdpUrl = (profileId: string) => `http://tl-profile-${profileId}:${CDP_PORT}`;

/** A failure with a stable code for the gateway. `outcome` defaults to `error`. */
export class ActionError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly outcome: 'error' | 'proxy_failed' = 'error',
  ) {
    super(message);
    this.name = 'ActionError';
  }
}

export interface SessionOptions {
  cdpUrlFor: (profileId: string) => string;
  proxyFor: ProxyLookup;
  /** True when the profile-lifetime watcher (`proxy-watch.ts`) already answers proxy challenges for new tabs. */
  proxyWatched?: (profileId: string) => boolean;
  /** Upper bound for one Playwright step (click, wait, navigation). */
  stepTimeoutMs: number;
}

export interface Session {
  page: Page;
  /** Leave the tab open on close (a wall the owner clears over VNC). */
  keepPage(): void;
  /** Milliseconds left before the command's deadline, capped at the step timeout. */
  stepTimeout(): number;
  close(): Promise<void>;
}

export async function openSession(
  profileId: string,
  ctx: Pick<HandlerContext, 'signal' | 'deadlineAt' | 'log'>,
  opts: SessionOptions,
): Promise<Session> {
  const stepTimeout = () => Math.max(1, Math.min(opts.stepTimeoutMs, ctx.deadlineAt - Date.now()));
  if (ctx.signal.aborted)
    throw new ActionError('aborted', 'command deadline passed before the action started');

  let browser: Browser;
  try {
    browser = await chromium.connectOverCDP(opts.cdpUrlFor(profileId), { timeout: stepTimeout() });
  } catch (err) {
    ctx.log.warn({ profileId, err: errMessage(err) }, 'CDP connect failed');
    throw new ActionError('cdp_unreachable', `profile ${profileId} browser is not reachable over CDP`);
  }
  // Disconnecting makes every pending Playwright call reject, which is how an action stops at its deadline.
  const onAbort = () => void browser.close().catch(() => {});
  ctx.signal.addEventListener('abort', onAbort, { once: true });

  let page: Page | undefined;
  let detachAuth: (() => Promise<void>) | undefined;
  let keep = false;
  const close = async () => {
    ctx.signal.removeEventListener('abort', onAbort);
    if (page && !keep) await page.close().catch(() => {});
    else if (detachAuth) await detachAuth();
    // For a CDP-connected browser this only disconnects; the container's Chromium keeps running.
    await browser.close().catch(() => {});
  };

  try {
    const context = browser.contexts()[0];
    if (!context) throw new ActionError('no_context', `profile ${profileId} browser has no default context`);
    page = await context.newPage();
    page.setDefaultTimeout(stepTimeout());
    page.setDefaultNavigationTimeout(stepTimeout());
    const proxy = opts.proxyFor(profileId);
    if (proxy?.username && opts.proxyWatched?.(profileId)) {
      // The watcher enabled Fetch on this tab before it ran; a second Fetch client would answer twice.
    } else if (proxy?.username) {
      detachAuth = (await attachProxyAuth(page, { username: proxy.username, password: proxy.password ?? '' }))
        .detach;
    } else if (proxy === undefined) {
      ctx.log.debug({ profileId }, 'no proxy recorded for profile; proxy challenges will not be answered');
    }
  } catch (err) {
    await close();
    if (err instanceof ActionError) throw err;
    throw new ActionError('cdp_error', `could not open a tab in profile ${profileId}: ${errMessage(err)}`);
  }

  const p = page;
  return {
    page: p,
    keepPage: () => {
      keep = true;
    },
    stepTimeout,
    close,
  };
}

const PROXY_NET_ERRORS =
  /net::ERR_(PROXY_[A-Z_]+|TUNNEL_CONNECTION_FAILED|SOCKS_[A-Z_]+|NO_SUPPORTED_PROXIES)/;

/**
 * Navigate and map network failures: proxy errors (and a 407 page) become `proxy_failed`. Returns the main
 * document's response (null for same-document navigations).
 */
export async function goto(session: Session, url: string): Promise<Response | null> {
  let res: Response | null;
  try {
    res = await session.page.goto(url, {
      waitUntil: 'domcontentloaded',
      timeout: session.stepTimeout(),
    });
  } catch (err) {
    const msg = errMessage(err);
    const proxyErr = msg.match(PROXY_NET_ERRORS);
    if (proxyErr) throw new ActionError('proxy_failed', `proxy error: ${proxyErr[0]}`, 'proxy_failed');
    throw new ActionError('navigation_failed', `could not load ${redactUrl(url)}: ${firstLine(msg)}`);
  }
  if (res?.status() === 407)
    throw new ActionError('proxy_auth_failed', 'proxy rejected the credentials', 'proxy_failed');
  return res;
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function firstLine(s: string): string {
  return s.split('\n')[0] ?? s;
}

/** Origin and path only: query strings may carry ids we do not need in logs. */
export function redactUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname}`;
  } catch {
    return '(invalid url)';
  }
}
