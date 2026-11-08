import { prisma } from '@threadline/db';
import { QUEUES } from '@threadline/shared';
import type { Job, Queue } from 'bullmq';
import { log } from '../log';
import { type PostReader, RedditError, type RedditPost, defaultReader } from '../reddit/client';

/** Pure keyword match: any include term and no exclude term (case-insensitive). Returns the matched term. */
export function matchKeywords(text: string, include: string[], exclude: string[]): string | null {
  const t = text.toLowerCase();
  if (exclude.some((x) => x && t.includes(x.toLowerCase()))) return null;
  return include.find((x) => x && t.includes(x.toLowerCase())) ?? null;
}

/**
 * Post columns from a RedditPost. Score and comment count are unknown for the public feed (undefined):
 * 0 on insert, and an update leaves the stored counts alone instead of zeroing them.
 */
export function postColumns(p: RedditPost) {
  const counts = {
    ...(p.ups === undefined ? {} : { upvotes: p.ups }),
    ...(p.num_comments === undefined ? {} : { comments: p.num_comments }),
  };
  return {
    create: {
      authorUsername: p.author,
      title: p.title,
      body: p.selftext,
      url: `https://www.reddit.com${p.permalink}`,
      upvotes: p.ups ?? 0,
      comments: p.num_comments ?? 0,
      postedAt: new Date(p.created_utc * 1000),
    },
    update: counts,
  };
}

let shared: PostReader | null = null;
/** One reader per process, so the public feed's throttle and 429 backoff cover every poll job. */
function processReader(): PostReader {
  shared ??= defaultReader();
  return shared;
}

/**
 * reddit.poll — every 10 min per KeywordGroup (docs/PLAN.md §5 step 1). With a Reddit app configured it uses
 * the app's client-credentials token (no owner account spends quota on searching); without one it reads each
 * subreddit's public Atom feed (docs/plans/0002-browser-mode.md). A subreddit that fails (private, banned,
 * 5xx) is logged and skipped; a 429 fails the job so BullMQ retries it with backoff.
 */
export async function redditPoll(
  job: Job<{ keywordGroupId: string }>,
  scoreQueue: Pick<Queue, 'add'>,
  reader: PostReader = processReader(),
) {
  const group = await prisma.keywordGroup.findUnique({ where: { id: job.data.keywordGroupId } });
  if (!group) return { skipped: 'group not found' };
  let upserted = 0;
  const failed: string[] = [];
  for (const subName of group.subreddits) {
    const sub = await prisma.subreddit.findFirst({
      where: { workspaceId: group.workspaceId, name: subName },
    });
    if (!sub) continue;
    let posts: RedditPost[];
    try {
      posts = await reader.newPosts(subName);
    } catch (e) {
      if (e instanceof RedditError && e.status === 429) throw e;
      // name and status only: an error message could quote a proxy URL
      log.warn(
        {
          sub: subName,
          reader: reader.kind,
          status: e instanceof RedditError ? e.status : (e as Error).name,
        },
        'reddit.poll: subreddit skipped',
      );
      failed.push(subName);
      continue;
    }
    for (const p of posts) {
      const kw = matchKeywords(`${p.title}\n${p.selftext}`, group.include, group.exclude);
      if (!kw) continue;
      const cols = postColumns(p);
      const post = await prisma.post.upsert({
        where: { workspaceId_redditId: { workspaceId: group.workspaceId, redditId: p.name } },
        create: { workspaceId: group.workspaceId, redditId: p.name, subredditId: sub.id, ...cols.create },
        update: { ...cols.update, fetchedAt: new Date() },
        include: { opportunity: { select: { id: true } } },
      });
      upserted++;
      if (!post.opportunity)
        await scoreQueue.add(
          'score',
          { postId: post.id, keywordGroupId: group.id, matched: kw },
          { jobId: `post-${post.id}`, attempts: 2 },
        );
    }
  }
  log.info({ group: group.name, reader: reader.kind, upserted, failed: failed.length }, 'reddit.poll done');
  return { upserted, failed };
}

export const POLL_QUEUE = QUEUES.redditPoll;
