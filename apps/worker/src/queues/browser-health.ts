/**
 * browser.health (docs/PLAN.md §9; docs/plans/0001-infra-implementation.md T25) and the producer side of the
 * per-node browser queues.
 *
 * Every 2 minutes: one `health.check` job per online node on `browser.<node>`, and the seats reported by the
 * previous window's check are recorded on the node. The gateway consumes `browser.<node>`; this module only
 * produces. `browser.health` itself does not run in the core role (roles/core.ts NOT_CORE): the core role
 * schedules it and the gateway role runs it through `browserHealthPlugin()`.
 */
import { nodes } from '@threadline/db';
import {
  type BrowserJob,
  BrowserJobSchema,
  NodeName,
  QUEUES,
  Seats,
  browserJobId,
  browserQueue,
} from '@threadline/shared';
import { type Job, Queue, Worker } from 'bullmq';
import { redisConnection } from '../connection';
import type { GatewayPlugin } from '../gateway/index';
import { log } from '../log';

export const HEALTH_EVERY_MS = 2 * 60_000;

/** States in which a job will still run (or is running) on a node. */
const PENDING = ['waiting', 'active', 'delayed', 'prioritized', 'waiting-children', 'paused'] as const;

/**
 * The gateway fails a job with a message starting with this when it refused it before sending anything to the
 * node (approval gate, paused account, profile not ready). Only such a job may be queued again under a new id.
 */
export const DISPATCH_REFUSED_PREFIX = 'refused: ';

export interface BrowserJobInfo {
  state: string;
  returnvalue: unknown;
  finishedOn?: number;
  /** Set for a failed job: the gateway's error message (DISPATCH_REFUSED_PREFIX = refused before sending). */
  failedReason?: string;
}

export interface AddOptions {
  /** BullMQ attempts. Retrying an action is safe: the agent replays the stored result for a known cmdId. */
  attempts?: number;
  /** How long finished jobs stay in Redis; their ids dedupe re-adds for that long. */
  keepSec?: number;
  /** Milliseconds the job sits in `delayed` before the gateway may take it. It counts as in flight meanwhile. */
  delay?: number;
}

/**
 * Producer for `browser.<node>` queues. Payloads are validated with the strict `BrowserJobSchema`, so nothing
 * but ids can ride in a job (no secrets; the gateway loads and decrypts at dispatch time).
 */
export interface BrowserQueues {
  /** Adds the job unless one with this id exists in any state. Resolves true when it was added. */
  add(nodeName: string, job: BrowserJob, jobId: string, opts?: AddOptions): Promise<boolean>;
  get(nodeName: string, jobId: string): Promise<BrowserJobInfo | null>;
  /** Whether any browser action for this draft is waiting or running on the node. */
  inFlight(nodeName: string, draftId: string): Promise<boolean>;
  close(): Promise<void>;
}

export function createBrowserQueues(connection = redisConnection()): BrowserQueues {
  const queues = new Map<string, Queue>();
  const q = (nodeName: string) => {
    const name = browserQueue(NodeName.parse(nodeName));
    let x = queues.get(name);
    if (!x) {
      x = new Queue(name, { connection });
      queues.set(name, x);
    }
    return x;
  };
  return {
    async add(nodeName, job, jobId, opts = {}) {
      const queue = q(nodeName);
      if (await queue.getJob(jobId)) return false;
      const keep = opts.keepSec ?? 7 * 24 * 3600;
      await queue.add(job.kind, BrowserJobSchema.parse(job), {
        jobId,
        attempts: opts.attempts ?? 1,
        delay: opts.delay,
        backoff: { type: 'exponential', delay: 30_000 },
        removeOnComplete: { age: keep },
        removeOnFail: { age: keep },
      });
      return true;
    },
    async get(nodeName, jobId) {
      const job = await q(nodeName).getJob(jobId);
      if (!job) return null;
      return {
        state: await job.getState(),
        returnvalue: job.returnvalue,
        finishedOn: job.finishedOn,
        ...(job.failedReason ? { failedReason: job.failedReason } : {}),
      };
    },
    async inFlight(nodeName, draftId) {
      const jobs = await q(nodeName).getJobs([...PENDING], 0, 500);
      return jobs.some((j) => j?.data?.draftId === draftId && String(j.data.kind).startsWith('action.'));
    },
    async close() {
      await Promise.all([...queues.values()].map((x) => x.close()));
      queues.clear();
    },
  };
}

/** In-memory `BrowserQueues` for tests: same dedupe, validation and in-flight rules, no Redis. */
export function memoryBrowserQueues() {
  type Entry = { node: string; id: string; job: BrowserJob; opts: AddOptions } & BrowserJobInfo;
  const jobs = new Map<string, Entry>();
  const key = (node: string, id: string) => `${NodeName.parse(node)}/${id}`;
  const queues: BrowserQueues & {
    jobs: Map<string, Entry>;
    finish(node: string, id: string, rv: unknown): void;
    fail(node: string, id: string, failedReason: string): void;
  } = {
    jobs,
    async add(node, job, id, opts = {}) {
      if (jobs.has(key(node, id))) return false;
      jobs.set(key(node, id), {
        node,
        id,
        job: BrowserJobSchema.parse(job),
        opts,
        state: opts.delay ? 'delayed' : 'waiting',
        returnvalue: null,
      });
      return true;
    },
    async get(node, id) {
      const e = jobs.get(key(node, id));
      return e
        ? {
            state: e.state,
            returnvalue: e.returnvalue,
            finishedOn: e.finishedOn,
            ...(e.failedReason ? { failedReason: e.failedReason } : {}),
          }
        : null;
    },
    async inFlight(node, draftId) {
      return [...jobs.values()].some(
        (e) =>
          e.node === node &&
          'draftId' in e.job &&
          e.job.draftId === draftId &&
          (PENDING as readonly string[]).includes(e.state),
      );
    },
    async close() {},
    /** Marks a job completed with the gateway's return value. */
    finish(node, id, rv) {
      const e = jobs.get(key(node, id));
      if (!e) throw new Error(`no job ${id} on ${node}`);
      Object.assign(e, { state: 'completed', returnvalue: rv, finishedOn: Date.now() });
    },
    /** Marks a job failed with the gateway's error message. */
    fail(node, id, failedReason) {
      const e = jobs.get(key(node, id));
      if (!e) throw new Error(`no job ${id} on ${node}`);
      Object.assign(e, { state: 'failed', returnvalue: null, failedReason, finishedOn: Date.now() });
    },
  };
  return queues;
}

let shared: BrowserQueues | null = null;
/** One producer per process for the queue processors that do not get one injected. */
export function sharedBrowserQueues(): BrowserQueues {
  shared ??= createBrowserQueues();
  return shared;
}
export async function closeSharedBrowserQueues(): Promise<void> {
  const s = shared;
  shared = null;
  await s?.close();
}

/** `health.check` result as the gateway stores it: the agent's `HealthData`, bare or under `data`. */
export function seatsFromResult(rv: unknown): Seats | null {
  if (!rv || typeof rv !== 'object') return null;
  const r = rv as { seats?: unknown; data?: { seats?: unknown } | null };
  const parsed = Seats.safeParse(r.seats ?? r.data?.seats);
  return parsed.success ? parsed.data : null;
}

export interface BrowserHealthDeps {
  browser?: BrowserQueues;
  now?: Date;
}

/** browser.health job: enqueue this window's checks, record seats from the last window's. */
export async function browserHealth(_job?: Job, deps: BrowserHealthDeps = {}) {
  const browser = deps.browser ?? sharedBrowserQueues();
  const now = deps.now ?? new Date();
  const bucket = Math.floor(now.getTime() / HEALTH_EVERY_MS);
  let enqueued = 0;
  let recorded = 0;
  for (const n of await nodes.listOnline()) {
    const job: BrowserJob = { kind: 'health.check', workspaceId: n.workspaceId };
    // retries 0 (PLAN §9): a missed check is replaced by the next window's
    if (await browser.add(n.name, job, browserJobId(job, String(bucket)), { attempts: 1, keepSec: 3600 }))
      enqueued++;

    const prev = await browser.get(n.name, browserJobId(job, String(bucket - 1)));
    const seats = prev?.state === 'completed' ? seatsFromResult(prev.returnvalue) : null;
    if (seats) {
      // Seen when it answered; never move lastSeenAt backwards past a newer heartbeat.
      const seenAt = Math.max(prev?.finishedOn ?? 0, n.lastSeenAt?.getTime() ?? 0) || now.getTime();
      await nodes.recordHeartbeat(n.id, seats, new Date(seenAt));
      recorded++;
    }
  }
  return { enqueued, recorded };
}

/**
 * Runs the browser.health processor inside the gateway role (`startGateway({ plugins: [browserHealthPlugin()] })`).
 */
export function browserHealthPlugin(): GatewayPlugin {
  return {
    name: QUEUES.browserHealth,
    start() {
      const connection = redisConnection();
      const browser = createBrowserQueues(connection);
      const worker = new Worker(QUEUES.browserHealth, (j) => browserHealth(j, { browser }), {
        connection,
        concurrency: 1,
      });
      worker.on('failed', (job, err) =>
        log.error({ queue: QUEUES.browserHealth, jobId: job?.id, err: err.message }, 'job failed'),
      );
      return async () => {
        await worker.close();
        await browser.close();
      };
    },
  };
}
