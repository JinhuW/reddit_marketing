/**
 * `profile.signIn` (plan 0003): prepare a profile's browser for its assigned account, in one tab.
 *
 * 1. `cookies` → `context.addCookies` (the profile's persistent context keeps them on its volume).
 * 2. Read `me.json` exactly like `profile.whoami`.
 * 3. Nobody signed in and `credentials` given → fill `<redditOrigin>/login/`, then the 2FA code from
 *    `totpSecret` when Reddit asks for one, and read `me.json` again.
 * 4. Navigate the same tab to `startUrl` and keep it open, so the live (VNC) view shows it.
 *
 * Result data: `WhoamiData`. A captcha, an e-mail check, a 2FA step without a secret, or a login that neither
 * succeeds nor fails in time → `needs_human` with the tab kept for the take-over. A rejected password or code →
 * `error` `signin_rejected`.
 *
 * Cookies, the password, the 2FA secret and codes are credentials: they never reach a log line, an error message
 * or the result. The password, secret and long cookie values are added to `ctx.secrets` so log scrubbing catches
 * an accidental leak too.
 */
import { setTimeout as sleep } from 'node:timers/promises';
import type { CmdOf, WhoamiData } from '@threadline/shared';
import type { Locator, Page } from 'playwright-core';
import type { HandlerContext, HandlerResult } from '../registry';
import { signIn as sel } from './selectors';
import { ActionError, type Session, errMessage, goto, redactUrl } from './session';
import { needsHuman } from './submit-comment';
import { totp, totpMsLeft } from './totp';
import { type Wall, detectWall } from './walls';
import { whoami } from './whoami';

export type SignInCmd = CmdOf<'profile.signIn'>;

export interface SignInOptions {
  redditOrigin: string;
  /** How long to wait for Reddit to answer one login / 2FA submit. */
  confirmTimeoutMs: number;
  /** Poll interval while waiting for that answer; default 250 ms. */
  pollMs?: number;
  /** Don't type a 2FA code with less than this left in its 30 s window; default 3 s. */
  totpMinMsLeft?: number;
}

/** Cookie values shorter than this are not worth scrubbing ("1", "true", ...). */
const SCRUB_MIN_COOKIE = 12;

export function loginUrl(redditOrigin: string): string {
  return new URL('/login/', redditOrigin).toString();
}

export async function signIn(
  session: Session,
  cmd: SignInCmd,
  ctx: Pick<HandlerContext, 'log' | 'secrets' | 'deadlineAt' | 'signal'>,
  opts: SignInOptions,
): Promise<HandlerResult> {
  const { page } = session;
  const creds = cmd.credentials;
  if (creds) {
    ctx.secrets.add(creds.password);
    ctx.secrets.add(creds.totpSecret);
  }

  if (cmd.cookies?.length) {
    for (const c of cmd.cookies) if (c.value.length >= SCRUB_MIN_COOKIE) ctx.secrets.add(c.value);
    try {
      await page.context().addCookies(cmd.cookies);
    } catch {
      // Playwright's message can quote the offending cookie; keep it out.
      throw new ActionError('cookies_rejected', 'the browser refused the imported cookies');
    }
    ctx.log.info({ count: cmd.cookies.length }, 'cookies imported');
  }

  let who = await whoami(session, { kind: 'profile.whoami', profileId: cmd.profileId }, opts);
  if (who.outcome !== 'ok') return who;

  if (!loggedIn(who) && creds) {
    ctx.log.info('nobody signed in; filling the login form');
    const login = await logIn(session, creds, ctx, opts);
    if (login) return login;
    who = await whoami(session, { kind: 'profile.whoami', profileId: cmd.profileId }, opts);
    if (who.outcome !== 'ok') return who;
    ctx.log.info({ loggedIn: loggedIn(who) }, 'login form submitted');
  }

  // The start tab is a convenience: a slow or broken start page must not lose the identity just read.
  session.keepPage();
  try {
    await goto(session, cmd.startUrl);
  } catch (err) {
    ctx.log.warn({ url: redactUrl(cmd.startUrl), err: errMessage(err) }, 'start tab did not load');
  }
  return who;
}

function loggedIn(r: HandlerResult): boolean {
  return (r.data as WhoamiData | undefined)?.loggedIn === true;
}

type Creds = NonNullable<SignInCmd['credentials']>;

/**
 * Fills the login form and the 2FA step. Resolves `null` once Reddit has left the login page (the caller then
 * reads `me.json`), or the `needs_human` result to return. Throws `signin_rejected` on a refused password / code.
 */
async function logIn(
  session: Session,
  creds: Creds,
  ctx: Pick<HandlerContext, 'log' | 'deadlineAt' | 'signal'>,
  opts: SignInOptions,
): Promise<HandlerResult | null> {
  const { page } = session;
  await goto(session, loginUrl(opts.redditOrigin));

  const early = await blockingWall(page);
  if (early) return needsHuman(session, early, false);
  if (!onLoginPage(page)) return null; // Reddit sent us on: the cookies were enough after all.

  const user = visible(page, sel.username);
  const pass = visible(page, sel.password);
  try {
    await user.waitFor({ state: 'visible', timeout: session.stepTimeout() });
    await pass.waitFor({ state: 'visible', timeout: session.stepTimeout() });
  } catch {
    if (await visible(page, sel.challenge).count()) return needsHuman(session, 'captcha', false);
    throw new ActionError(
      'login_form_not_found',
      'the Reddit login form did not show a username and password field',
    );
  }
  await user.fill(creds.username);
  await pass.fill(creds.password);
  let base = await baseline(page);
  await submit(page, pass);

  let otpSent = false;
  for (;;) {
    const state = await awaitAnswer(page, base, ctx, opts);
    switch (state) {
      case 'left':
        return null;
      case 'captcha':
      case 'verification':
        return needsHuman(session, state, false);
      case 'timeout':
        // Neither in nor refused: leave the tab so the owner can see what Reddit is showing.
        return needsHuman(session, 'login', false);
      case 'rejected':
        throw new ActionError(
          'signin_rejected',
          otpSent
            ? 'Reddit rejected the 2FA code; check the account 2FA secret'
            : 'Reddit rejected the username or password',
        );
      case 'otp': {
        if (otpSent)
          throw new ActionError(
            'signin_rejected',
            'Reddit asked for the 2FA code again; check the account 2FA secret',
          );
        if (!creds.totpSecret) {
          ctx.log.info('Reddit asks for a 2FA code and the account has no 2FA secret');
          return needsHuman(session, 'verification', false);
        }
        const field = visible(page, sel.otp);
        let code: string;
        const minLeft = opts.totpMinMsLeft ?? 3_000;
        if (totpMsLeft() < minLeft) await sleep(totpMsLeft() + 100);
        try {
          code = totp(creds.totpSecret);
        } catch {
          throw new ActionError('totp_secret_invalid', 'the account 2FA secret is not valid base32');
        }
        await field.fill(code);
        base = await baseline(page);
        await submit(page, field);
        otpSent = true;
        break;
      }
    }
  }
}

type Answer = 'left' | 'otp' | 'rejected' | 'captcha' | 'verification' | 'timeout';

/** What the page showed just before a submit: errors / 2FA fields already there are not its answer. */
interface Baseline {
  errors: number;
  otp: number;
}

async function baseline(page: Page): Promise<Baseline> {
  return {
    errors: await safe(() => visibleErrors(page), 0),
    otp: await safe(() => page.locator(sel.otp).filter({ visible: true }).count(), 0),
  };
}

/** Polls the page until Reddit answers a submit. Errors while the page navigates are retried. */
async function awaitAnswer(
  page: Page,
  base: Baseline,
  ctx: Pick<HandlerContext, 'deadlineAt' | 'signal'>,
  opts: SignInOptions,
): Promise<Answer> {
  const until = Math.min(Date.now() + opts.confirmTimeoutMs, ctx.deadlineAt - 500);
  const pollMs = opts.pollMs ?? 250;
  for (;;) {
    await sleep(pollMs);
    if (ctx.signal.aborted) throw new ActionError('aborted', 'command deadline passed during sign-in');
    const answer = await safe(async (): Promise<Answer | null> => {
      const wall = await blockingWall(page);
      if (wall) return wall;
      if (!onLoginPage(page)) return 'left';
      if ((await visibleErrors(page)) > base.errors) return 'rejected';
      if ((await page.locator(sel.otp).filter({ visible: true }).count()) > base.otp) return 'otp';
      return null;
    }, null);
    if (answer) return answer;
    if (Date.now() >= until) return 'timeout';
  }
}

/** A captcha challenge or an e-mail check. The login page itself (and its 2FA field) is not a wall here. */
async function blockingWall(page: Page): Promise<Extract<Wall, 'captcha' | 'verification'> | null> {
  if ((await visible(page, sel.challenge).count()) > 0) return 'captcha';
  if ((await page.locator(sel.emailCheck).count()) > 0) return 'verification';
  const wall = await detectWall(page);
  // detectWall's verification selector also matches the login page's 2FA field; trust only the path there.
  if (wall === 'verification' && !onLoginPage(page)) return 'verification';
  return null;
}

function onLoginPage(page: Page): boolean {
  try {
    return /^\/(login|account\/login)(\/|$)/.test(new URL(page.url()).pathname);
  } catch {
    return false;
  }
}

function visible(page: Page, selector: string): Locator {
  return page.locator(selector).filter({ visible: true }).first();
}

async function visibleErrors(page: Page): Promise<number> {
  const byRole = await page.locator(sel.error).filter({ visible: true, hasText: /\S/ }).count();
  const byText = await page.getByText(sel.errorText).filter({ visible: true }).count();
  return byRole + byText;
}

/** Clicks the visible submit button, or presses Enter in `field` when there is none. */
async function submit(page: Page, field: Locator): Promise<void> {
  const button = visible(page, sel.submit);
  if ((await button.count()) > 0) await button.click();
  else await field.press('Enter');
}

async function safe<T>(fn: () => Promise<T>, fallback: T): Promise<T> {
  try {
    return await fn();
  } catch {
    return fallback;
  }
}
