import 'server-only';
import { type DraftGenerateJob, type PostPublishJob, QUEUES, type QueueName } from '@threadline/shared';
import { Queue } from 'bullmq';

const g = globalThis as unknown as { __tlQueues?: Map<string, Queue> };
const queues = (g.__tlQueues ??= new Map());

function connection() {
  const url = new URL(process.env.REDIS_URL ?? 'redis://localhost:6379');
  return {
    host: url.hostname,
    port: Number(url.port || 6379),
    password: url.password || undefined,
    maxRetriesPerRequest: null,
  };
}

function queue(name: QueueName): Queue {
  let q = queues.get(name);
  if (!q) {
    q = new Queue(name, { connection: connection() });
    queues.set(name, q);
  }
  return q;
}

/** Producers for the web app. Job ids are the idempotency keys from docs/PLAN.md §9. */
export const enqueue = {
  postPublish: (data: PostPublishJob, delayMs = 0) =>
    queue(QUEUES.postPublish).add('publish', data, {
      jobId: `draft:${data.draftId}`,
      delay: delayMs,
      attempts: 3,
      backoff: { type: 'exponential', delay: 30_000 },
      removeOnComplete: 1000,
    }),
  draftGenerate: (data: DraftGenerateJob, version: number) =>
    queue(QUEUES.draftGenerate).add('generate', data, {
      jobId: `draft:${data.draftId ?? data.opportunityId ?? data.conversationId}:v${version}`,
      attempts: 2,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 1000,
    }),
};
