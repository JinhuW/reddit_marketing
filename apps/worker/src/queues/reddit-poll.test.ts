import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { prisma } from '@threadline/db';
import type { Job } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { type PostReader, RedditError, parseAtomFeed } from '../reddit/client';
import { matchKeywords, postColumns, redditPoll } from './reddit-poll';

/** Recorded feed shape (tests/fixtures/reddit-feeds/README.md); never fetched live. */
const FEED = readFileSync(
  fileURLToPath(
    new URL('../../../../tests/fixtures/reddit-feeds/projectmanagement-new.atom.xml', import.meta.url),
  ),
  'utf8',
);

describe('matchKeywords', () => {
  it('matches an include term case-insensitively', () =>
    expect(matchKeywords('Looking for an ASANA alternative', ['asana alternative'], [])).toBe(
      'asana alternative',
    ));
  it('drops posts with an exclude term', () =>
    expect(
      matchKeywords('Asana alternative? Also asana jobs hiring', ['asana alternative'], ['asana jobs']),
    ).toBeNull());
  it('returns null with no match', () => expect(matchKeywords('hello', ['asana'], [])).toBeNull());
});

describe('postColumns', () => {
  const base = {
    name: 't3_a',
    subreddit: 's',
    author: 'u',
    title: 't',
    selftext: 'b',
    permalink: '/r/s/comments/a/t/',
    created_utc: 1_700_000_000,
  };
  it('defaults unknown counts to 0 on insert and leaves them alone on update (public feed)', () => {
    const c = postColumns(base);
    expect(c.create).toMatchObject({
      upvotes: 0,
      comments: 0,
      url: 'https://www.reddit.com/r/s/comments/a/t/',
    });
    expect(c.update).toEqual({});
  });
  it('uses API counts when present', () => {
    expect(postColumns({ ...base, ups: 5, num_comments: 2 }).update).toEqual({ upvotes: 5, comments: 2 });
  });
});

/** Integration against the seeded Postgres: the "Asana alternative" group polls three subreddits. */
describe('redditPoll with the public reader', () => {
  const FIXTURE_IDS = parseAtomFeed(FEED, 'projectmanagement').map((p) => p.name);
  afterAll(async () => {
    await prisma.post.deleteMany({ where: { redditId: { in: FIXTURE_IDS } } });
    await prisma.$disconnect();
  });

  const reader = (fail?: RedditError): PostReader & { asked: string[] } => {
    const asked: string[] = [];
    return {
      kind: 'public',
      asked,
      async newPosts(sub) {
        asked.push(sub);
        if (sub === 'projectmanagement') return parseAtomFeed(FEED, sub);
        if (fail) throw fail;
        return [];
      },
    };
  };

  async function run(r: PostReader) {
    const group = await prisma.keywordGroup.findFirstOrThrow({ where: { name: 'Asana alternative' } });
    const added: unknown[] = [];
    const scoreQueue = { add: async (...args: unknown[]) => added.push(args) } as never;
    const out = await redditPoll(
      { data: { keywordGroupId: group.id } } as Job<{ keywordGroupId: string }>,
      scoreQueue,
      r,
    );
    return { group, out, added };
  }

  it('stores matching feed posts with plain-text bodies and 0 counts, skipping a failing subreddit', async () => {
    const r = reader(new RedditError('feed → 403', 403));
    const { group, out, added } = await run(r);
    expect(r.asked).toEqual(group.subreddits);
    expect(out).toEqual({ upserted: 1, failed: ['productivity', 'startups'] });
    const post = await prisma.post.findFirstOrThrow({
      where: { workspaceId: group.workspaceId, redditId: 't3_1ox9k2q' },
    });
    expect(post).toMatchObject({
      authorUsername: 'ops_kat',
      upvotes: 0,
      comments: 0,
      url: 'https://www.reddit.com/r/projectmanagement/comments/1ox9k2q/asana_alternative_for_a_12person_agency/',
    });
    expect(post.body).toContain('- client approvals');
    expect(post.body).not.toMatch(/<[a-z/]/);
    expect(added).toHaveLength(1);
  });

  it('keeps known counts when the feed has none', async () => {
    const { group } = await run(reader());
    await prisma.post.updateMany({
      where: { workspaceId: group.workspaceId, redditId: 't3_1ox9k2q' },
      data: { upvotes: 42, comments: 7 },
    });
    await run(reader());
    const post = await prisma.post.findFirstOrThrow({
      where: { workspaceId: group.workspaceId, redditId: 't3_1ox9k2q' },
    });
    expect(post).toMatchObject({ upvotes: 42, comments: 7 });
  });

  it('fails the job on a 429 so BullMQ retries it with backoff', async () => {
    await expect(run(reader(new RedditError('rate limited', 429, 60_000)))).rejects.toMatchObject({
      status: 429,
    });
  });
});
