import { PolicyError, assertPublishable } from '@threadline/agents';
import { browsers, drafts, prisma } from '@threadline/db';
import { type BrowserJob, type DraftType, browserJobId } from '@threadline/shared';
import { type Job, UnrecoverableError } from 'bullmq';
import { log } from '../log';
import { NeedsBrowser, RedditClient, RedditError } from '../reddit/client';
import { type BrowserQueues, DISPATCH_REFUSED_PREFIX, sharedBrowserQueues } from './browser-health';

/** What post.publish needs from Reddit. Injected so tests never call the live API. */
export interface Poster {
  comment(parentFullname: string, text: string): Promise<string>;
  submit(subreddit: string, title: string, text: string): Promise<string>;
  compose(to: string, subject: string, text: string): Promise<string>;
}

type PosterFactory = (account: { id: string; oauthTokenEnc: string | null }) => Poster;
const redditPoster: PosterFactory = (a) => RedditClient.forAccount(a);

export type PublishOutcome =
  | { status: 'posted'; postedRedditId: string }
  | { status: 'skipped'; reason: string }
  | { status: 'refused'; reason: string; failures: string[] }
  /** Browser-mode account: the draft went to its node's browser queue; the gateway posts it (and re-checks). */
  | { status: 'queued'; node: string; jobId: string }
  | {
      status: 'needs_human';
      reason: string;
      /** set when the draft went to its node's browser queue; null when the account was paused instead */
      fallback: { node: string; jobId: string } | null;
    };

/**
 * Browser fallback (PLAN §14: "on by default for DMs and verification recovery only"). Only draft types with a
 * browser action can fall back: a comment (verification recovery) and a DM. A `post` never goes to the browser.
 */
export const BROWSER_FALLBACK_ACTION: Partial<
  Record<DraftType, Extract<BrowserJob['kind'], 'action.submitComment' | 'action.sendDm'>>
> = { comment: 'action.submitComment', dm: 'action.sendDm' };

/** Attempts for a browser action job: the agent replays a stored result per cmdId, so a retry never posts twice. */
export const FALLBACK_ATTEMPTS = 3;

/** Why a `post` draft of a browser-mode account fails (plan 0002: there is no browser action for new threads). */
export const BROWSER_POST_UNSUPPORTED = 'New threads are not supported in browser mode; nothing was sent.';

/** The draft's account with its pause state and its profile's node. */
interface AccountForPublish {
  id: string;
  username: string;
  ownerMemberId: string;
  authMode: string;
  oauthTokenEnc: string | null;
  pausedReason: string | null;
  browserProfile: { id: string; node: { name: string } | null } | null;
}

function loadAccountForPublish(accountId: string): Promise<AccountForPublish> {
  return prisma.redditAccount.findUniqueOrThrow({
    where: { id: accountId },
    select: {
      id: true,
      username: true,
      ownerMemberId: true,
      authMode: true,
      oauthTokenEnc: true,
      pausedReason: true,
      browserProfile: { select: { id: true, node: { select: { name: true } } } },
    },
  });
}

/** The browser job for a draft, or null when its type has no browser action. */
export function fallbackJob(
  d: { id: string; workspaceId: string; type: string },
  profileId: string,
): BrowserJob | null {
  const kind = BROWSER_FALLBACK_ACTION[d.type as DraftType];
  return kind ? { kind, workspaceId: d.workspaceId, profileId, draftId: d.id } : null;
}

/**
 * Publish one draft. This is the ONLY code path that posts to Reddit, and it refuses unless
 * assertPublishable passes: status approved/scheduled, an approver who could approve, and every
 * block rule re-evaluated at post time (daily limit, link rule, disclosure, eligibility, DM engagement).
 */
export async function publishDraft(
  workspaceId: string,
  draftId: string,
  makePoster: PosterFactory = redditPoster,
  now: Date = new Date(),
  browser?: BrowserQueues,
): Promise<PublishOutcome> {
  const d = await drafts.get(workspaceId, draftId);
  if (!d) return { status: 'skipped', reason: 'draft not found' };
  if (d.status === 'posted') return { status: 'skipped', reason: 'already posted' };

  const account = await loadAccountForPublish(d.accountId);
  // A paused account (any PauseReason) posts nothing until resumed; the draft keeps its status.
  if (account.pausedReason)
    return { status: 'skipped', reason: `account u/${account.username} is paused (${account.pausedReason})` };
  // The browser has this draft: posting through the API too could post it twice.
  const node = account.browserProfile?.node?.name;
  if (node && (await (browser ?? sharedBrowserQueues()).inFlight(node, d.id)))
    return { status: 'skipped', reason: `browser fallback in progress on ${node}` };

  const checks = await drafts.evaluate(d, now);
  try {
    assertPublishable(d, await drafts.approverCouldApprove(d), checks, now);
  } catch (e) {
    if (!(e instanceof PolicyError)) throw e;
    // Not yet due is not a failure: leave the draft scheduled.
    if (/Scheduled time/.test(e.message)) return { status: 'skipped', reason: e.message };
    if (d.status === 'approved' || d.status === 'scheduled') await drafts.markFailed(d.id, e.message);
    return { status: 'refused', reason: e.message, failures: e.failures };
  }

  // Browser mode (plan 0002): the Reddit API is never called; the gateway's approval gate checks again.
  if (account.authMode === 'browser') return publishInBrowser(d, account, browser);

  const poster = makePoster(account);
  let postedRedditId: string;
  try {
    if (d.type === 'comment') {
      const parent =
        d.opportunity?.post.redditId ??
        [...(d.conversation?.messages ?? [])].reverse().find((m) => m.direction === 'in' && m.redditId)
          ?.redditId;
      if (!parent) throw new UnrecoverableError('comment draft has no thread or message to reply to');
      postedRedditId = await poster.comment(parent, d.body);
    } else if (d.type === 'post') {
      const sub = drafts.draftSubreddit(d);
      if (!sub) throw new UnrecoverableError('post draft has no subreddit');
      postedRedditId = await poster.submit(sub.name, d.title ?? d.body.split('\n')[0]!.slice(0, 280), d.body);
    } else {
      const to = d.conversation?.lead.redditUser.username;
      if (!to) throw new UnrecoverableError('DM draft has no recipient');
      postedRedditId = await poster.compose(to, 'Re: your question', d.body);
    }
  } catch (e) {
    if (e instanceof NeedsBrowser) return needsBrowser(d, account, e.message, browser);
    throw e;
  }

  await drafts.markPosted(d.id, postedRedditId, now);
  log.info({ draftId: d.id, postedRedditId }, 'draft posted');
  return { status: 'posted', postedRedditId };
}

/** How often a browser-mode draft is queued again after the gateway refused it before sending anything. */
export const MAX_BROWSER_REQUEUES = 3;

/**
 * Browser-mode account, draft approved and publishable: a comment or DM goes to its node's browser queue with
 * the same job id and attempts as the verification fallback (so the sweep and a fallback never queue it
 * twice); a `post` is marked failed (no browser action for new threads).
 *
 * When that job id already finished and the draft is still approved: if the gateway refused it before sending
 * anything (failedReason starts with DISPATCH_REFUSED_PREFIX, e.g. the account was paused at dispatch time and
 * has been resumed since), it is queued again as `<id>-r<n>`, at most MAX_BROWSER_REQUEUES times. Anything
 * else (it may have reached Reddit) is never re-sent: the owner is notified and the account paused with
 * `needs_human`, as the fallback does. The same pause applies with no profile or no node. The draft stays
 * approved in those cases.
 */
async function publishInBrowser(
  d: { id: string; workspaceId: string; type: string; status: string },
  account: AccountForPublish,
  browser: BrowserQueues | undefined,
): Promise<PublishOutcome> {
  const profileId = account.browserProfile?.id ?? null;
  const node = account.browserProfile?.node?.name ?? null;
  if (!BROWSER_FALLBACK_ACTION[d.type as DraftType]) {
    if (d.status === 'approved' || d.status === 'scheduled')
      await drafts.markFailed(d.id, BROWSER_POST_UNSUPPORTED);
    log.info({ draftId: d.id, type: d.type }, 'browser mode: draft type has no browser action');
    return { status: 'refused', reason: BROWSER_POST_UNSUPPORTED, failures: ['browser_mode'] };
  }
  const job = profileId ? fallbackJob(d, profileId) : null;
  if (job && profileId && node) {
    const q = browser ?? sharedBrowserQueues();
    for (let n = 0; n <= MAX_BROWSER_REQUEUES; n++) {
      const jobId = browserJobId(job, n === 0 ? undefined : `r${n}`);
      if (await q.add(node, job, jobId, { attempts: FALLBACK_ATTEMPTS })) {
        log.info({ draftId: d.id, node, jobId }, 'browser mode: draft queued on its node');
        return { status: 'queued', node, jobId };
      }
      const prev = await q.get(node, jobId);
      // Still queued or running: the sweep runs every minute, so this is the normal case while a job waits.
      if (prev && prev.state !== 'failed' && prev.state !== 'completed') {
        log.info({ draftId: d.id, node, jobId, state: prev.state }, 'browser mode: draft already queued');
        return { status: 'skipped', reason: `already queued on ${node}` };
      }
      if (prev?.state !== 'failed' || !prev.failedReason?.startsWith(DISPATCH_REFUSED_PREFIX)) break;
    }
    // Not in flight (checked above) and not a clean refusal: it may have reached Reddit. A human has to look.
    return pauseForHuman(
      d,
      account,
      `the browser on ${node} already tried this draft`,
      `The browser on ${node} already tried this draft for u/${account.username}. Check the draft, then resume the account.`,
      profileId,
    );
  }
  return pauseForHuman(
    d,
    account,
    profileId ? 'the browser profile has no node assigned' : 'the account has no browser profile',
    `u/${account.username} has ${profileId ? 'no browser node assigned' : 'no browser profile'}; assign one on the Browsers screen, then resume the account.`,
    profileId,
  );
}

/** Notifies the owner and pauses the account with `needs_human` (the minute sweep then leaves it alone). */
async function pauseForHuman(
  d: { id: string; workspaceId: string },
  account: AccountForPublish,
  reason: string,
  text: string,
  profileId: string | null,
): Promise<PublishOutcome> {
  await prisma.notification.create({
    data: {
      workspaceId: d.workspaceId,
      memberId: account.ownerMemberId,
      kind: 'needs_human',
      payload: { draftId: d.id, profileId, fallback: false, text },
    },
  });
  await browsers.pauseAccount({
    workspaceId: d.workspaceId,
    accountId: account.id,
    reason: 'needs_human',
    detail: `draft ${d.id}: ${reason}`.slice(0, 500),
  });
  log.info({ draftId: d.id }, 'browser mode: account paused for a human');
  return { status: 'needs_human', reason, fallback: null };
}

/**
 * Reddit asked for verification. The owner is notified as before; then either the draft goes to its node's
 * browser queue (comment/DM, profile on a node, not tried in the browser yet), or the account is paused with
 * `needs_human` so the minute sweep stops retrying it until someone hands the browser back or resumes it.
 * The draft stays approved either way. The gateway re-checks approval before it sends any action to a node.
 */
async function needsBrowser(
  d: { id: string; workspaceId: string; type: string },
  account: AccountForPublish,
  reason: string,
  browser: BrowserQueues | undefined,
): Promise<PublishOutcome> {
  const profileId = account.browserProfile?.id ?? null;
  const node = account.browserProfile?.node?.name ?? null;
  const job = profileId ? fallbackJob(d, profileId) : null;
  let fallback: { node: string; jobId: string } | null = null;
  if (job && node) {
    const jobId = browserJobId(job);
    // An existing id means the browser already tried this draft (any state): a human has to step in now.
    if (await (browser ?? sharedBrowserQueues()).add(node, job, jobId, { attempts: FALLBACK_ATTEMPTS }))
      fallback = { node, jobId };
  }

  await prisma.notification.create({
    data: {
      workspaceId: d.workspaceId,
      memberId: account.ownerMemberId,
      kind: 'needs_human',
      payload: {
        draftId: d.id,
        profileId,
        fallback: fallback !== null,
        text: fallback
          ? `Reddit asked for verification: ${reason}. Retrying in the browser on ${fallback.node}.`
          : `Reddit asked for verification: ${reason}`,
      },
    },
  });
  if (!fallback)
    await browsers.pauseAccount({
      workspaceId: d.workspaceId,
      accountId: account.id,
      reason: 'needs_human',
      detail: `draft ${d.id}: ${reason}`.slice(0, 500),
    });
  log.info({ draftId: d.id, fallback }, 'draft needs the browser');
  return { status: 'needs_human', reason, fallback };
}

/** post.publish job: one draft (enqueued on approve), or a sweep of due scheduled drafts (every minute). */
export async function postPublish(job: Job<{ workspaceId?: string; draftId?: string; sweep?: boolean }>) {
  if (job.data.sweep) {
    const due = await drafts.dueForPublishing();
    const results = [];
    for (const d of due) results.push(await publishOne(d.workspaceId, d.id));
    return { swept: due.length, results };
  }
  if (!job.data.workspaceId || !job.data.draftId) throw new UnrecoverableError('missing draftId');
  return publishOne(job.data.workspaceId, job.data.draftId);
}

async function publishOne(workspaceId: string, draftId: string) {
  try {
    return await publishDraft(workspaceId, draftId);
  } catch (e) {
    if (e instanceof RedditError && e.status === 429) throw e; // retried with backoff
    if (e instanceof UnrecoverableError) {
      await drafts.markFailed(draftId, e.message);
      throw e;
    }
    throw e;
  }
}
