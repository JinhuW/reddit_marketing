/**
 * Maps an agent `result` to Threadline state (docs/plans/0001-infra-implementation.md §4 T20).
 *
 *   ok            → `profile.started` / `profile.stopped` audit for start/stop; for `profile.whoami` the signed-in
 *                   identity is recorded on a browser-mode account (applyWhoami; a duplicate is final); for
 *                   `profile.signIn` (plan 0003) the cookies that were sent are marked imported first, then the
 *                   same identity handling runs
 *   posted        → `drafts.markPosted` (writes `draft.posted`), once: a replayed result for a draft that is
 *                   already posted changes nothing
 *   needs_human   → pause the account (`needs_human`) and notify its owner; the draft stays approved. A browser
 *                   with no account (plan 0003) has nothing to pause: logged only
 *   license_denied→ pause the account (`license_denied`) and write `profile.license_denied`
 *   proxy_failed  → pause the account (`proxy_failed`)
 *   error (action)→ final failure: the agent caches action results (errors included) per cmdId and replays them,
 *                   so a retry cannot change it; the draft is marked failed so a human can look and re-approve
 *   error (other) → retryable (RetryableOutcomeError): the agent does NOT cache errors of non-action kinds, so a
 *                   BullMQ retry of a failed profile.start/stop/testProxy/health.check really runs again (e.g. CDP
 *                   not ready yet on a cold start). Codes in FINAL_NON_ACTION_CODES (config/seat refusals a
 *                   retry within the backoff window cannot fix) stay final
 *   error deadline_exceeded → NOT final: the agent reports it shortly before the deadline while its handler keeps
 *                   running, and does not cache it. Thrown as a retryable NodeTimeout (§3.4), so the retry under
 *                   the same cmdId gets the in-flight or cached real result (a slow post is recorded as posted,
 *                   never as failed)
 *
 * Only `error.code` from the agent is recorded or logged: agent messages may quote page text or proxy URLs.
 */
import { accounts, audit, browsers, drafts, prisma } from '@threadline/db';
import {
  type BrowserJob,
  type PauseReason,
  PostedData,
  type Result,
  TestProxyData,
  WhoamiData,
} from '@threadline/shared';
import { log as rootLog } from '../log';
import { NodeError } from './hub';

export type BrowserJobOutcome =
  | { outcome: 'ok'; kind: BrowserJob['kind']; data?: unknown }
  | { outcome: 'posted'; draftId: string; postedRedditId: string; alreadyPosted: boolean }
  | { outcome: 'needs_human' | 'license_denied' | 'proxy_failed'; paused: boolean; accountId: string | null }
  | { outcome: 'error'; code: string };

/** Everything outcomes.ts writes. Injected in tests; defaults are the db repos. */
export interface OutcomeDeps {
  markPosted: (draftId: string, postedRedditId: string) => Promise<unknown>;
  markFailed: (draftId: string, error: string) => Promise<unknown>;
  draftStatus: (workspaceId: string, draftId: string) => Promise<string | null>;
  pauseAccount: typeof browsers.pauseAccount;
  writeAudit: (input: Parameters<typeof audit.writeAudit>[0]) => Promise<unknown>;
  /** accounts.completeBrowserIdentity: writes `account.connected`; throws AccountConflictError on a duplicate. */
  completeIdentity: (
    workspaceId: string,
    accountId: string,
    who: accounts.BrowserIdentity,
  ) => Promise<{ changed: boolean; username: string }>;
  /** browsers.markCookiesImported: clears the pending cookies only if they are still the ones that were sent. */
  markCookiesImported: (workspaceId: string, profileId: string, cookiesEnc: string) => Promise<unknown>;
  /** browsers.setStatus: the Status chip on the Browsers screen. */
  setStatus: (
    workspaceId: string,
    profileId: string,
    status: 'idle' | 'running' | 'error',
  ) => Promise<unknown>;
  /** browsers.recordProxyTest: the "Last connection test" box. */
  recordProxyTest: (workspaceId: string, profileId: string, test: browsers.ProxyTest) => Promise<unknown>;
  /** browsers.purgeProfile / resetProfileData: what follows a `profile.remove` the node carried out. */
  purgeProfile: (workspaceId: string, profileId: string) => Promise<unknown>;
  resetProfileData: (workspaceId: string, profileId: string) => Promise<unknown>;
  now: () => Date;
  notifyNeedsHuman: (input: {
    workspaceId: string;
    memberId: string;
    draftId: string | null;
    profileId: string;
    node: string;
    text: string;
  }) => Promise<unknown>;
}

export const defaultOutcomeDeps: OutcomeDeps = {
  markPosted: (id, redditId) => drafts.markPosted(id, redditId),
  markFailed: (id, error) => drafts.markFailed(id, error),
  draftStatus: async (ws, id) => (await drafts.get(ws, id))?.status ?? null,
  pauseAccount: (input) => browsers.pauseAccount(input),
  writeAudit: (input) => audit.writeAudit(input),
  // Same shape post.publish writes for NeedsBrowser (there is no notifications repo yet; see DECISIONS).
  completeIdentity: (ws, accountId, who) => accounts.completeBrowserIdentity(ws, accountId, who),
  markCookiesImported: (ws, profileId, cookiesEnc) => browsers.markCookiesImported(ws, profileId, cookiesEnc),
  setStatus: (ws, profileId, status) => browsers.setStatus(ws, profileId, status),
  recordProxyTest: (ws, profileId, test) => browsers.recordProxyTest(ws, profileId, test),
  purgeProfile: (ws, profileId) => browsers.purgeProfile(ws, profileId, null),
  resetProfileData: (ws, profileId) => browsers.resetProfileData(ws, profileId, null),
  now: () => new Date(),
  notifyNeedsHuman: (n) =>
    prisma.notification.create({
      data: {
        workspaceId: n.workspaceId,
        memberId: n.memberId,
        kind: 'needs_human',
        payload: { draftId: n.draftId, profileId: n.profileId, node: n.node, text: n.text },
      },
    }),
};

export interface OutcomeContext {
  job: BrowserJob;
  /** cmdId = BullMQ job id */
  cmdId: string;
  node: string;
  /** null only for `health.check` */
  profile: Pick<browsers.DispatchProfile, 'id' | 'name' | 'accountId' | 'account'> | null;
  /**
   * `profile.signIn` only: the encrypted cookie JSON that went out in the command (null = none were sent). Still
   * encrypted; never logged. Passed to markCookiesImported on `ok`.
   */
  sentCookiesEnc?: string | null;
}

/** Refusals and failures that must not be retried. The dispatcher turns these into BullMQ UnrecoverableError. */
export class FinalOutcomeError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'FinalOutcomeError';
  }
}

/** A non-action `error` the agent did not cache: BullMQ retries the job (same cmdId) and the agent runs it again. */
export class RetryableOutcomeError extends Error {
  readonly retryable = true;
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'RetryableOutcomeError';
  }
}

/** Non-action error codes that a retry cannot fix (node config, CloakBrowser seat tier, node capacity). */
export const FINAL_NON_ACTION_CODES: ReadonlySet<string> = new Set([
  'no_handler',
  'not_implemented',
  'bad_config',
  'seat_limit',
  'max_profiles',
]);

/**
 * `profile.signIn` error codes a retry cannot fix (plan 0003). Final, so BullMQ never repeats a rejected login:
 * re-submitting a wrong password or 2FA code risks Reddit locking the account. The account is not paused; the
 * owner fixes the stored credentials or cookies and signs in again. `login_form_not_found` and `aborted` stay
 * retryable (nothing was submitted).
 */
export const FINAL_SIGN_IN_CODES: ReadonlySet<string> = new Set([
  'signin_rejected',
  'totp_secret_invalid',
  'cookies_rejected',
]);

const PAUSE_TEXT: Record<'needs_human' | 'license_denied' | 'proxy_failed', string> = {
  needs_human: 'Reddit asked for verification in the browser',
  license_denied: 'CloakBrowser license check failed on the node',
  proxy_failed: 'the proxy failed on the node',
};

const isAction = (j: BrowserJob): j is Extract<BrowserJob, { draftId: string }> =>
  j.kind === 'action.submitComment' || j.kind === 'action.sendDm';

export async function applyOutcome(
  ctx: OutcomeContext,
  result: Result,
  deps: OutcomeDeps = defaultOutcomeDeps,
  log: typeof rootLog = rootLog,
): Promise<BrowserJobOutcome> {
  const { job } = ctx;
  const l = log.child({ component: 'gateway.outcomes', node: ctx.node, cmdId: ctx.cmdId, kind: job.kind });

  switch (result.outcome) {
    case 'ok': {
      if (ctx.profile && (job.kind === 'profile.start' || job.kind === 'profile.stop')) {
        await deps.writeAudit({
          workspaceId: job.workspaceId,
          actorMemberId: null,
          action: job.kind === 'profile.start' ? 'profile.started' : 'profile.stopped',
          targetType: 'BrowserProfile',
          targetId: ctx.profile.id,
          accountId: ctx.profile.accountId,
          meta: { item: ctx.profile.name, node: ctx.node, reason: job.reason },
        });
        await deps.setStatus(
          job.workspaceId,
          ctx.profile.id,
          job.kind === 'profile.start' ? 'running' : 'idle',
        );
      }
      if (job.kind === 'profile.remove' && ctx.profile) {
        // The volume is gone on the node; only now does the database follow.
        if (job.then === 'purge') await deps.purgeProfile(job.workspaceId, ctx.profile.id);
        else await deps.resetProfileData(job.workspaceId, ctx.profile.id);
        l.info({ profileId: ctx.profile.id, then: job.then }, 'profile volume removed');
        return { outcome: 'ok', kind: job.kind, data: { then: job.then } };
      }
      if (job.kind === 'profile.testProxy' && ctx.profile) {
        const t = TestProxyData.safeParse(result.data);
        if (!t.success) {
          l.error({ code: 'bad_test_data' }, 'testProxy result does not match the protocol');
          throw new FinalOutcomeError('bad_test_data', 'the node returned an unreadable connection test');
        }
        // The page and the agent must leave through the same address, or the browser is not on the proxy.
        const same = t.data.pageIp === t.data.agentIp;
        const test: browsers.ProxyTest = {
          ok: same,
          ...(same ? {} : { error: 'ip_mismatch' }),
          ip: t.data.pageIp,
          ...(t.data.latencyMs === undefined ? {} : { latencyMs: t.data.latencyMs }),
          ...(t.data.redditOk === undefined ? {} : { redditOk: t.data.redditOk }),
          ...(t.data.geo ?? {}),
          // Same form as the Region column shows elsewhere: "Boston, US".
          ...(t.data.geo?.city
            ? { city: [t.data.geo.city, t.data.geo.country].filter(Boolean).join(', ') }
            : {}),
          testedAt: deps.now().toISOString(),
        };
        await deps.recordProxyTest(job.workspaceId, ctx.profile.id, test);
        return { outcome: 'ok', kind: job.kind, data: { ok: same } };
      }
      if (job.kind === 'profile.whoami') return applyWhoami(ctx, result.data, deps, l);
      if (job.kind === 'profile.signIn') {
        // The agent imports cookies before anything else, so `ok` means they are in the profile's own volume.
        if (ctx.profile && ctx.sentCookiesEnc) {
          await deps.markCookiesImported(job.workspaceId, ctx.profile.id, ctx.sentCookiesEnc);
          l.info({ profileId: ctx.profile.id }, 'cookies imported');
        }
        return applyWhoami(ctx, result.data, deps, l);
      }
      if (isAction(job)) {
        // An action that "succeeded" without posting is a contract breach: never guess, let a human look.
        l.error('action returned ok instead of posted');
        throw new FinalOutcomeError('action_not_posted', 'agent returned ok for an action without posting');
      }
      return { outcome: 'ok', kind: job.kind, ...(result.data === undefined ? {} : { data: result.data }) };
    }

    case 'posted': {
      if (!isAction(job)) {
        l.error('posted outcome for a non-action command');
        throw new FinalOutcomeError('unexpected_outcome', `posted is not a valid outcome for ${job.kind}`);
      }
      const parsed = PostedData.safeParse(result.data);
      // The comment/DM exists on Reddit even if the agent could not read its id: record it as posted
      // (so nothing re-sends it) with a marker id a human can resolve.
      const postedRedditId = parsed.success ? parsed.data.fullname : `unknown:${ctx.cmdId}`;
      if (!parsed.success) l.warn('posted result without a fullname');
      const status = await deps.draftStatus(job.workspaceId, job.draftId);
      if (status === 'posted') {
        l.info({ draftId: job.draftId }, 'draft already posted; replayed result ignored');
        return { outcome: 'posted', draftId: job.draftId, postedRedditId, alreadyPosted: true };
      }
      await deps.markPosted(job.draftId, postedRedditId);
      l.info({ draftId: job.draftId, postedRedditId }, 'draft posted through the browser');
      return { outcome: 'posted', draftId: job.draftId, postedRedditId, alreadyPosted: false };
    }

    case 'needs_human':
    case 'license_denied':
    case 'proxy_failed': {
      const reason: PauseReason = result.outcome;
      const p = ctx.profile;
      if (p && job.kind === 'profile.testProxy' && reason === 'proxy_failed') {
        await deps.recordProxyTest(job.workspaceId, p.id, {
          ok: false,
          error: result.error?.code ?? 'proxy_failed',
          testedAt: deps.now().toISOString(),
        });
      }
      if (!p) {
        l.warn({ outcome: reason }, 'pause outcome without a profile');
        return { outcome: reason, paused: false, accountId: null };
      }
      if (reason === 'license_denied') {
        await deps.writeAudit({
          workspaceId: job.workspaceId,
          actorMemberId: null,
          action: 'profile.license_denied',
          targetType: 'BrowserProfile',
          targetId: p.id,
          accountId: p.accountId,
          meta: { item: p.name, node: ctx.node, ...(result.error?.code ? { code: result.error.code } : {}) },
        });
      }
      const account = p.account;
      if (!account) {
        // Plan 0003: a browser with no account (e.g. a sign-in run that only imported cookies). Nothing to pause.
        l.warn({ outcome: reason, profileId: p.id }, 'browser has no account; nothing paused');
        return { outcome: reason, paused: false, accountId: null };
      }
      const accountId = account.id;
      const paused = await deps.pauseAccount({
        workspaceId: job.workspaceId,
        accountId,
        reason,
        detail: result.error?.code ? `${ctx.node}: ${result.error.code}` : ctx.node,
      });
      if (reason === 'needs_human') {
        await deps.notifyNeedsHuman({
          workspaceId: job.workspaceId,
          memberId: account.ownerMemberId,
          draftId: isAction(job) ? job.draftId : null,
          profileId: p.id,
          node: ctx.node,
          text: `${PAUSE_TEXT.needs_human} for u/${account.username}. Take over the browser to continue.`,
        });
      }
      l.warn({ outcome: reason, accountId, changed: paused.changed }, 'account paused');
      return { outcome: reason, paused: paused.changed, accountId };
    }

    case 'error': {
      const code = result.error?.code ?? 'agent_error';
      if (code === 'deadline_exceeded') {
        // Synthetic and uncached: the handler may still finish (and post). Retry; never mark the draft failed.
        l.warn({ code }, 'agent reported its deadline; retrying for the real result');
        throw new NodeError('NodeTimeout', ctx.node, ctx.cmdId, 'agent reported deadline_exceeded');
      }
      l.warn({ code }, 'agent returned error');
      if (!isAction(job)) {
        if (job.kind === 'profile.signIn' && FINAL_SIGN_IN_CODES.has(code)) {
          if (code === 'signin_rejected')
            l.warn(
              { profileId: ctx.profile?.id, accountId: ctx.profile?.accountId, code },
              'Reddit rejected the stored password or 2FA code; not retried, update the credentials',
            );
          throw new FinalOutcomeError(code, `sign-in failed on ${ctx.node}: ${code}`);
        }
        // Not cached by the agent: a retry really retries. Only refusals a retry cannot fix are final.
        if (FINAL_NON_ACTION_CODES.has(code))
          throw new FinalOutcomeError(code, `agent error on ${ctx.node}: ${code}`);
        throw new RetryableOutcomeError(code, `agent error on ${ctx.node}: ${code} (retrying)`);
      }
      // The agent caches action errors and replays them for the same cmdId: final.
      const status = await deps.draftStatus(job.workspaceId, job.draftId);
      if (status === 'approved' || status === 'scheduled')
        await deps.markFailed(job.draftId, `Browser action failed on ${ctx.node}: ${code}`);
      throw new FinalOutcomeError(code, `agent error on ${ctx.node}: ${code}`);
    }
  }
}

/**
 * `profile.whoami` / `profile.signIn` → `ok`. Nobody signed in: no change. A browser with no account (plan 0003):
 * logged only. Signed in: a browser-mode account gets its identity
 * (`accounts.completeBrowserIdentity`, idempotent; writes `account.connected`); an OAuth account keeps the
 * identity from its token. A refusal (that Reddit user is already connected in the workspace, or the profile
 * is signed in as another user than the account) is final. Logs carry codes only, never the username.
 */
async function applyWhoami(
  ctx: OutcomeContext,
  data: unknown,
  deps: OutcomeDeps,
  l: typeof rootLog,
): Promise<BrowserJobOutcome> {
  const p = ctx.profile;
  const kind = ctx.job.kind === 'profile.signIn' ? 'profile.signIn' : 'profile.whoami';
  if (!p) throw new FinalOutcomeError('unexpected_outcome', `${kind} without a profile`);
  const parsed = WhoamiData.safeParse(data);
  if (!parsed.success) {
    l.error({ code: 'bad_whoami_data' }, 'whoami result does not match the protocol');
    throw new FinalOutcomeError('bad_whoami_data', 'the node returned an unreadable whoami result');
  }
  const who = parsed.data;
  if (!who.loggedIn) {
    l.info({ accountId: p.accountId }, 'not signed in');
    return { outcome: 'ok', kind, data: { loggedIn: false } };
  }
  if (!p.account) {
    l.info(
      { profileId: p.id, code: 'no_account' },
      'signed in, but the browser has no account; nothing recorded',
    );
    return { outcome: 'ok', kind, data: { loggedIn: true, changed: false } };
  }
  if (p.account.authMode !== 'browser') {
    l.info(
      { accountId: p.accountId, code: 'oauth_account' },
      'whoami on an OAuth account; identity unchanged',
    );
    return { outcome: 'ok', kind, data: { loggedIn: true, changed: false } };
  }
  try {
    const r = await deps.completeIdentity(ctx.job.workspaceId, p.account.id, {
      name: who.name,
      id: who.id,
      ...(who.totalKarma === undefined ? {} : { totalKarma: who.totalKarma }),
      ...(who.createdUtc === undefined ? {} : { createdUtc: who.createdUtc }),
    });
    l.info({ accountId: p.accountId, changed: r.changed }, 'browser identity recorded');
    return {
      outcome: 'ok',
      kind,
      data: { loggedIn: true, changed: r.changed, username: r.username },
    };
  } catch (e) {
    if (!(e instanceof accounts.AccountConflictError)) throw e; // e.g. the database: retried by BullMQ
    l.warn({ accountId: p.accountId, code: 'identity_conflict' }, 'browser identity refused');
    throw new FinalOutcomeError(
      'identity_conflict',
      'This Reddit user is already connected in the workspace, or the profile is signed in as another user than the account (identity_conflict).',
    );
  }
}
