import { prisma } from '@threadline/db';
import { QUEUES } from '@threadline/shared';
import type { Job, Queue } from 'bullmq';
import { log } from '../log';
import { RedditClient, type RedditPost } from '../reddit/client';

/** Pure keyword match: any include term and no exclude term (case-insensitive). Returns the matched term. */
export function matchKeywords(text: string, include: string[], exclude: string[]): string | null {
  const t = text.toLowerCase();
  if (exclude.some((x) => x && t.includes(x.toLowerCase()))) return null;
  return include.find((x) => x && t.includes(x.toLowerCase())) ?? null;
}

/**
 * reddit.poll — every 10 min per KeywordGroup (docs/PLAN.md §5 step 1). Uses the app's
 * client-credentials token so no owner account spends quota on searching.
 */
export async function redditPoll(job: Job<{ keywordGroupId: string }>, scoreQueue: Queue) {
  const group = await prisma.keywordGroup.findUnique({ where: { id: job.data.keywordGroupId } });
  if (!group) return { skipped: 'group not found' };
  const reddit = RedditClient.app();
  let upserted = 0;
  for (const subName of group.subreddits) {
    const sub = await prisma.subreddit.findFirst({
      where: { workspaceId: group.workspaceId, name: subName },
    });
    if (!sub) continue;
    const listing = await reddit.newPosts(subName);
    for (const { data: p } of listing.data.children as { data: RedditPost }[]) {
      const kw = matchKeywords(`${p.title}\n${p.selftext}`, group.include, group.exclude);
      if (!kw) continue;
      const post = await prisma.post.upsert({
        where: { workspaceId_redditId: { workspaceId: group.workspaceId, redditId: p.name } },
        create: {
          workspaceId: group.workspaceId,
          redditId: p.name,
          subredditId: sub.id,
          authorUsername: p.author,
          title: p.title,
          body: p.selftext,
          url: `https://www.reddit.com${p.permalink}`,
          upvotes: p.ups,
          comments: p.num_comments,
          postedAt: new Date(p.created_utc * 1000),
        },
        update: { upvotes: p.ups, comments: p.num_comments, fetchedAt: new Date() },
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
  log.info({ group: group.name, upserted }, 'reddit.poll done');
  return { upserted };
}

export const POLL_QUEUE = QUEUES.redditPoll;
