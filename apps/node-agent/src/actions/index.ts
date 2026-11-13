/**
 * Playwright actions over CDP (plan §4 T22): `action.submitComment`, `action.sendDm`, `profile.testProxy`, and
 * `profile.whoami` (plan 0002: the signed-in Reddit identity, read from `me.json` in the profile's own context), and
 * `profile.signIn` (plan 0003: cookie import, login form + TOTP, start tab).
 *
 * Each command connects to the profile's container browser, works in its own tab, and maps what happened to a
 * `BrowserOutcome`: `posted` with the new item's fullname, `needs_human` for verification / captcha / login walls
 * (the tab stays open for the VNC take-over), `proxy_failed`, or `error` with a stable code. Actions on one
 * profile run one at a time.
 */
import type { CmdKind, CmdOf } from '@threadline/shared';
import type { HandlerContext, HandlerMap, HandlerResult } from '../registry';
import type { HumanOptions } from './human';
import { type ProxyLookup, profileProxies } from './proxy-store';
import { proxyAuthWatchers } from './proxy-watch';
import { sendDm } from './send-dm';
import { ActionError, type Session, defaultCdpUrl, errMessage, openSession } from './session';
import { signIn } from './sign-in';
import { submitComment } from './submit-comment';
import { DEFAULT_GEO_URL, DEFAULT_IP_URL, testProxy } from './test-proxy';
import { whoami } from './whoami';

export { profileProxies, ProfileProxies, type ProxyLookup } from './proxy-store';
export { attachProxyAuth } from './proxy-auth';
export { ProxyAuthWatchers, proxyAuthWatchers } from './proxy-watch';
export { fetchViaProxy, openTunnel } from './proxy-fetch';
export { ActionError, defaultCdpUrl } from './session';
export { detectWall, type Wall } from './walls';

export interface ActionOptions {
  /** CDP endpoint of a profile's browser; default `http://tl-profile-<id>:9222`. */
  cdpUrlFor?: (profileId: string) => string;
  /** Proxy a profile was started with; default {@link profileProxies}. */
  proxyFor?: ProxyLookup;
  /** Whether the profile-lifetime proxy-auth watcher covers a profile; default {@link proxyAuthWatchers}. */
  proxyWatched?: (profileId: string) => boolean;
  /** Where DMs are composed and `me.json` is read; default `https://www.reddit.com`. */
  redditOrigin?: string;
  /** IP echo for the connection test; default {@link DEFAULT_IP_URL}. */
  ipUrl?: string;
  /**
   * Geo lookup for the connection test, fetched through the proxy. Default {@link DEFAULT_GEO_URL}; with a custom
   * `ipUrl` and no `geoUrl` the lookup and the Reddit reachability check are skipped (tests stay offline).
   */
  geoUrl?: string | null;
  /** Cap for one Playwright step; default 15 s. */
  stepTimeoutMs?: number;
  /** How long to wait for Reddit to show a submitted item (or answer a login submit); default 20 s. */
  confirmTimeoutMs?: number;
  /** Pacing of clicks and typing ({@link HumanOptions}); tests pass a no-op sleep. */
  human?: HumanOptions;
}

type ActionKind = Extract<
  CmdKind,
  'action.submitComment' | 'action.sendDm' | 'profile.testProxy' | 'profile.whoami' | 'profile.signIn'
>;

export function createActionHandlers(options: ActionOptions = {}): Pick<HandlerMap, ActionKind> {
  const o = {
    cdpUrlFor: options.cdpUrlFor ?? defaultCdpUrl,
    proxyFor: options.proxyFor ?? profileProxies.lookup,
    proxyWatched:
      options.proxyWatched ?? (options.proxyFor ? () => false : (id: string) => proxyAuthWatchers.covers(id)),
    redditOrigin: options.redditOrigin ?? 'https://www.reddit.com',
    ipUrl: options.ipUrl ?? DEFAULT_IP_URL,
    geoUrl: options.geoUrl !== undefined ? options.geoUrl : options.ipUrl ? null : DEFAULT_GEO_URL,
    checkReddit: options.geoUrl !== undefined || !options.ipUrl,
    stepTimeoutMs: options.stepTimeoutMs ?? 15_000,
    confirmTimeoutMs: options.confirmTimeoutMs ?? 20_000,
    human: options.human,
  };
  const locks = new ProfileLocks();

  function action<C extends { profileId: string }>(
    run: (session: Session, cmd: C, ctx: HandlerContext) => Promise<HandlerResult>,
  ): (cmd: C, ctx: HandlerContext) => Promise<HandlerResult> {
    return (cmd, ctx) =>
      locks.run(cmd.profileId, async () => {
        const log = ctx.log.child({ profileId: cmd.profileId });
        let session: Session | undefined;
        try {
          session = await openSession(cmd.profileId, { ...ctx, log }, o);
          return await run(session, cmd, { ...ctx, log });
        } catch (err) {
          return toResult(err, ctx.signal);
        } finally {
          await session?.close();
        }
      });
  }

  return {
    'action.submitComment': action((s, cmd: CmdOf<'action.submitComment'>) => submitComment(s, cmd, o)),
    'action.sendDm': action((s, cmd: CmdOf<'action.sendDm'>) => sendDm(s, cmd, o)),
    'profile.testProxy': action(async (s, cmd: CmdOf<'profile.testProxy'>, ctx) => {
      const proxy = o.proxyFor(cmd.profileId);
      if (proxy === undefined) {
        throw new ActionError(
          'proxy_unknown',
          'this agent has no proxy on record for the profile; restart the profile to test its proxy',
        );
      }
      return testProxy(s, cmd, {
        ipUrl: o.ipUrl,
        proxy,
        signal: ctx.signal,
        geoUrl: o.geoUrl,
        redditUrl: o.checkReddit ? new URL('/robots.txt', o.redditOrigin).toString() : null,
      });
    }),
    'profile.whoami': action((s, cmd: CmdOf<'profile.whoami'>) => whoami(s, cmd, o)),
    'profile.signIn': action((s, cmd: CmdOf<'profile.signIn'>, ctx) => signIn(s, cmd, ctx, o)),
  };
}

function toResult(err: unknown, signal: AbortSignal): HandlerResult {
  if (err instanceof ActionError) {
    return { outcome: err.outcome, error: { code: err.code, message: err.message } };
  }
  if (signal.aborted)
    return { outcome: 'error', error: { code: 'aborted', message: 'command deadline passed' } };
  return {
    outcome: 'error',
    error: { code: 'action_failed', message: errMessage(err).split('\n')[0] ?? '' },
  };
}

/** Serializes actions per profile: two commands typing into one browser would corrupt both. */
class ProfileLocks {
  private readonly tails = new Map<string, Promise<unknown>>();

  run<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(profileId) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => {});
    this.tails.set(profileId, tail);
    void tail.then(() => {
      if (this.tails.get(profileId) === tail) this.tails.delete(profileId);
    });
    return next;
  }
}
