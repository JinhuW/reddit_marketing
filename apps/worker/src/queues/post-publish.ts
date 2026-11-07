import { PolicyError, assertPublishable } from '@threadline/agents';
import { drafts, prisma } from '@threadline/db';
import { type Job, UnrecoverableError } from 'bullmq';
import { log } from '../log';
import { NeedsBrowser, RedditClient, RedditError } from '../reddit/client';

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
  | { status: 'needs_human'; reason: string };

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
): Promise<PublishOutcome> {
  const d = await drafts.get(workspaceId, draftId);
  if (!d) return { status: 'skipped', reason: 'draft not found' };
  if (d.status === 'posted') return { status: 'skipped', reason: 'already posted' };

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

  const account = await prisma.redditAccount.findUniqueOrThrow({
    where: { id: d.accountId },
    select: { id: true, oauthTokenEnc: true },
  });
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
    if (e instanceof NeedsBrowser) {
      // Verification / captcha: the owner takes over in the browser profile (M6). Draft stays approved.
      const owner = await prisma.redditAccount.findUnique({
        where: { id: d.accountId },
        select: { ownerMemberId: true, browserProfile: { select: { id: true } } },
      });
      if (owner)
        await prisma.notification.create({
          data: {
            workspaceId,
            memberId: owner.ownerMemberId,
            kind: 'needs_human',
            payload: {
              draftId: d.id,
              profileId: owner.browserProfile?.id ?? null,
              text: `Reddit asked for verification: ${e.message}`,
            },
          },
        });
      return { status: 'needs_human', reason: e.message };
    }
    throw e;
  }

  await drafts.markPosted(d.id, postedRedditId, now);
  log.info({ draftId: d.id, postedRedditId }, 'draft posted');
  return { status: 'posted', postedRedditId };
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
