/**
 * Threadline worker: every queue in docs/PLAN.md §9. The only process that holds Reddit tokens
 * and talks to browser containers. Jobs are idempotent on their natural key (jobId).
 */
import { prisma } from '@threadline/db';
import { QUEUES, type QueueName } from '@threadline/shared';
import { type Job, Queue, Worker } from 'bullmq';
import { redisConnection } from './connection';
import { log } from './log';
import { attributionRollup } from './queues/attribution-rollup';
import { draftGenerate } from './queues/draft-generate';
import { opportunityScore } from './queues/opportunity-score';
import { postPublish } from './queues/post-publish';
import { redditPoll } from './queues/reddit-poll';
import { sessionIdle } from './queues/session-idle';

const connection = redisConnection();
const queues = new Map<QueueName, Queue>();
const q = (name: QueueName) => {
  let x = queues.get(name);
  if (!x) queues.set(name, (x = new Queue(name, { connection })));
  return x;
};

type Processor = (job: Job) => Promise<unknown>;
const notYet =
  (milestone: string): Processor =>
  async (job) => {
    log.info({ queue: job.queueName, milestone }, 'queue registered; processor ships in a later milestone');
    return { skipped: milestone };
  };

const PROCESSORS: Record<QueueName, { fn: Processor; concurrency: number }> = {
  [QUEUES.redditPoll]: { fn: (j) => redditPoll(j, q(QUEUES.opportunityScore)), concurrency: 4 },
  [QUEUES.opportunityScore]: { fn: opportunityScore, concurrency: 4 },
  [QUEUES.draftGenerate]: { fn: draftGenerate, concurrency: 2 },
  // concurrency 1: one post at a time keeps per-account daily limits and ratios exact
  [QUEUES.postPublish]: { fn: postPublish, concurrency: 1 },
  [QUEUES.dmPoll]: { fn: notYet('M4'), concurrency: 1 },
  [QUEUES.commentPoll]: { fn: notYet('M4'), concurrency: 2 },
  [QUEUES.accountStats]: { fn: notYet('M2'), concurrency: 2 },
  [QUEUES.subredditRefresh]: { fn: notYet('M1'), concurrency: 2 },
  [QUEUES.attributionRollup]: { fn: attributionRollup, concurrency: 1 },
  [QUEUES.leadSync]: { fn: notYet('M7'), concurrency: 2 },
  [QUEUES.contextEmbed]: { fn: notYet('M2'), concurrency: 2 },
  [QUEUES.browserHealth]: { fn: notYet('M6'), concurrency: 1 },
  [QUEUES.sessionIdle]: { fn: sessionIdle, concurrency: 1 },
  [QUEUES.reportWeekly]: { fn: notYet('M5'), concurrency: 1 },
};

async function schedule() {
  // Polling needs the Reddit app credentials; skip it cleanly when they are not configured.
  if (process.env.REDDIT_CLIENT_ID) {
    for (const g of await prisma.keywordGroup.findMany({ select: { id: true } }))
      await q(QUEUES.redditPoll).upsertJobScheduler(
        `poll:${g.id}`,
        { every: 10 * 60_000 },
        { name: 'poll', data: { keywordGroupId: g.id } },
      );
  } else log.warn('REDDIT_CLIENT_ID not set: reddit.poll is not scheduled');
  await q(QUEUES.postPublish).upsertJobScheduler(
    'scheduled-drafts',
    { every: 60_000 },
    { name: 'sweep', data: { sweep: true } },
  );
  await q(QUEUES.attributionRollup).upsertJobScheduler(
    'rollup',
    { every: 15 * 60_000 },
    { name: 'rollup', data: {} },
  );
  await q(QUEUES.sessionIdle).upsertJobScheduler('idle', { every: 60_000 }, { name: 'idle', data: {} });
}

async function main() {
  const workers = Object.entries(PROCESSORS).map(([name, { fn, concurrency }]) => {
    const w = new Worker(name, fn, { connection, concurrency });
    w.on('failed', (job, err) => log.error({ queue: name, jobId: job?.id, err: err.message }, 'job failed'));
    return w;
  });
  await schedule();
  log.info({ queues: workers.length }, 'worker started');
  const stop = async () => {
    await Promise.all(workers.map((w) => w.close()));
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

main().catch((e) => {
  log.error(e);
  process.exit(1);
});
