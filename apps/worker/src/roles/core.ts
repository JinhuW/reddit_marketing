/**
 * `SERVICE_ROLE=core` (default): every queue in docs/PLAN.md §9 except `browser.health`, which belongs to the
 * browser path (docs/plans/0001-infra-implementation.md T25). The only process that holds Reddit tokens.
 * Jobs are idempotent on their natural key (jobId).
 */
import { prisma } from '@threadline/db';
import { QUEUES, type QueueName } from '@threadline/shared';
import { type Job, Queue, Worker } from 'bullmq';
import { redisConnection } from '../connection';
import { log } from '../log';
import { attributionRollup } from '../queues/attribution-rollup';
import { HEALTH_EVERY_MS, closeSharedBrowserQueues } from '../queues/browser-health';
import { draftGenerate } from '../queues/draft-generate';
import { opportunityScore } from '../queues/opportunity-score';
import { postPublish } from '../queues/post-publish';
import { redditPoll } from '../queues/reddit-poll';
import { sessionIdle } from '../queues/session-idle';
import type { RoleHandle } from './role';

/** Queues that never run in the core role. */
export const NOT_CORE = [QUEUES.browserHealth] as const;
export type CoreQueueName = Exclude<QueueName, (typeof NOT_CORE)[number]>;

type Processor = (job: Job) => Promise<unknown>;
const notYet =
  (milestone: string): Processor =>
  async (job) => {
    log.info({ queue: job.queueName, milestone }, 'queue registered; processor ships in a later milestone');
    return { skipped: milestone };
  };

type QueueFor = (name: QueueName) => Queue;

export function coreProcessors(q: QueueFor): Record<CoreQueueName, { fn: Processor; concurrency: number }> {
  return {
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
    [QUEUES.sessionIdle]: { fn: sessionIdle, concurrency: 1 },
    [QUEUES.reportWeekly]: { fn: notYet('M5'), concurrency: 1 },
  };
}

async function schedule(q: QueueFor) {
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
  // Scheduled here, processed by the gateway role (queues/browser-health.ts browserHealthPlugin). Retries 0.
  await q(QUEUES.browserHealth).upsertJobScheduler(
    'health',
    { every: HEALTH_EVERY_MS },
    { name: 'health', data: {}, opts: { attempts: 1, removeOnComplete: 100, removeOnFail: 100 } },
  );
}

export async function startCore(): Promise<RoleHandle> {
  const connection = redisConnection();
  const queues = new Map<QueueName, Queue>();
  const q: QueueFor = (name) => {
    let x = queues.get(name);
    if (!x) {
      x = new Queue(name, { connection });
      queues.set(name, x);
    }
    return x;
  };

  const workers = Object.entries(coreProcessors(q)).map(([name, { fn, concurrency }]) => {
    const w = new Worker(name, fn, { connection, concurrency });
    w.on('failed', (job, err) => log.error({ queue: name, jobId: job?.id, err: err.message }, 'job failed'));
    return w;
  });
  await schedule(q);
  log.info({ queues: workers.length }, 'core role started');

  return {
    role: 'core',
    async stop() {
      // Workers first so in-flight jobs finish, then the producer queues they may still enqueue to.
      await Promise.all(workers.map((w) => w.close()));
      await Promise.all([...queues.values()].map((x) => x.close()));
      await closeSharedBrowserQueues();
    },
  };
}
