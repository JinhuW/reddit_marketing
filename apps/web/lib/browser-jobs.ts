import 'server-only';
// Web producer for browser-node jobs (docs/plans/0002-browser-mode.md "Commands and jobs").
// The gateway consumes `browserQueue(node.name)`; results land in the DB, and the job's return value is kept
// for a week so the session page can read a `profile.whoami` answer. Payloads never carry secrets.
import { browsers, nodes } from '@threadline/db';
import { type BrowserJob, WhoamiData, browserJobId, browserQueue } from '@threadline/shared';
import { type JobsOptions, Queue } from 'bullmq';

/** The kinds the web app may enqueue. Actions (submitComment/sendDm) are never queued from here. */
export type WebBrowserJobKind =
  | 'profile.start'
  | 'profile.stop'
  | 'profile.whoami'
  | 'profile.signIn'
  | 'profile.testProxy';

export type EnqueueResult = { queued: true; jobId: string; node: string } | { queued: false; reason: string };

/** Same as the gateway's `browserJobOptions` (apps/worker/src/gateway/dispatch.ts): node errors are retryable. */
export const BROWSER_JOB_OPTIONS: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 1_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

/** BullMQ connection from REDIS_URL, including the db index (`/14`), user and TLS (`rediss://`). */
export function redisConnection(url = process.env.REDIS_URL ?? 'redis://localhost:6379') {
  const u = new URL(url);
  const db = Number(u.pathname.replace(/^\//, '') || 0);
  return {
    host: u.hostname,
    port: Number(u.port || 6379),
    username: u.username ? decodeURIComponent(u.username) : undefined,
    password: u.password ? decodeURIComponent(u.password) : undefined,
    db: Number.isInteger(db) ? db : 0,
    ...(u.protocol === 'rediss:' ? { tls: {} } : {}),
    maxRetriesPerRequest: null,
  };
}

/** The part of a BullMQ queue this module uses; tests pass a fake. */
export interface JobQueue {
  add(name: string, data: BrowserJob, opts: JobsOptions): Promise<unknown>;
  getJob(id: string): Promise<
    | {
        getState(): Promise<string>;
        returnvalue: unknown;
        failedReason?: string;
      }
    | undefined
  >;
}

const g = globalThis as unknown as { __tlBrowserQueues?: Map<string, Queue> };
function realQueue(nodeName: string): JobQueue {
  g.__tlBrowserQueues ??= new Map();
  const name = browserQueue(nodeName);
  let q = g.__tlBrowserQueues.get(name);
  if (!q) {
    q = new Queue(name, { connection: redisConnection() });
    g.__tlBrowserQueues.set(name, q);
  }
  return q as unknown as JobQueue;
}

export interface BrowserJobDeps {
  /** profile's node: id, name, status (null = no node / node gone) */
  profileNode: (
    workspaceId: string,
    profileId: string,
  ) => Promise<{ found: boolean; node: { name: string; status: string } | null }>;
  queue: (nodeName: string) => JobQueue;
  now: () => number;
}

const defaultDeps: BrowserJobDeps = {
  profileNode: async (workspaceId, profileId) => {
    const p = await browsers.getProfile(workspaceId, profileId);
    if (!p) return { found: false, node: null };
    if (!p.nodeId) return { found: true, node: null };
    const n = await nodes.getById(p.nodeId);
    return { found: true, node: n && n.workspaceId === workspaceId ? n : null };
  },
  queue: realQueue,
  now: () => Date.now(),
};

/** Why a profile's jobs cannot run now, or null when its node is online. */
export function nodeProblem(node: { name: string; status: string } | null): string | null {
  if (!node) return 'This profile has no browser node yet. An admin can assign one on the Browsers screen.';
  if (node.status !== 'online')
    return `Browser node ${node.name} is ${node.status}. Try again when it is online.`;
  return null;
}

/**
 * Queues `profile.start` / `profile.stop` / `profile.whoami` for a profile on its node's queue. The job id is
 * `browserJobId(job, <time>)`: a UI command may run again after an earlier one finished. Returns
 * `{ queued: false, reason }` when the profile has no node or the node is not online (nothing is queued).
 * Callers check permissions first (canControlProfile).
 */
export async function enqueueProfileJob(
  workspaceId: string,
  profileId: string,
  kind: WebBrowserJobKind,
  deps: BrowserJobDeps = defaultDeps,
): Promise<EnqueueResult> {
  const { found, node } = await deps.profileNode(workspaceId, profileId);
  if (!found) return { queued: false, reason: 'Profile not found.' };
  const problem = nodeProblem(node);
  if (problem || !node) return { queued: false, reason: problem ?? 'No node.' };
  const job: BrowserJob =
    kind === 'profile.start'
      ? { kind, workspaceId, profileId, reason: 'takeover' }
      : kind === 'profile.stop'
        ? { kind, workspaceId, profileId, reason: 'manual' }
        : { kind, workspaceId, profileId };
  const jobId = browserJobId(job, deps.now().toString(36));
  try {
    // A sign-in check / sign-in run is something the person is waiting on: retry twice, not for minutes after the
    // page gave up (and never hammer reddit.com/login).
    const opts =
      kind === 'profile.whoami' || kind === 'profile.signIn' || kind === 'profile.testProxy'
        ? { ...BROWSER_JOB_OPTIONS, attempts: 2 }
        : BROWSER_JOB_OPTIONS;
    await withTimeout(deps.queue(node.name).add(node.name, job, { ...opts, jobId }));
  } catch {
    return { queued: false, reason: 'Could not reach the job queue. Try again in a minute.' };
  }
  return { queued: true, jobId, node: node.name };
}

/**
 * Queues `profile.remove` (plan 0004): the node deletes the browser's container and volume, and the gateway then
 * purges a trashed browser (`purge`) or gives a live one a new fingerprint (`reset`). Returns
 * `{ queued: false, node: false }` when the browser has no node, i.e. there is no volume to delete and the
 * caller can finish in the database itself. Callers check permissions first.
 */
export async function enqueueRemoveJob(
  workspaceId: string,
  profileId: string,
  after: 'purge' | 'reset',
  deps: Pick<BrowserJobDeps, 'queue' | 'now'> = defaultDeps,
): Promise<EnqueueResult | { queued: false; node: false; reason: string }> {
  const p =
    after === 'purge'
      ? await browsers.trashedProfileNode(workspaceId, profileId)
      : await browsers
          .getProfile(workspaceId, profileId)
          .then(async (r) => (r ? { node: r.nodeId ? await nodes.getById(r.nodeId) : null } : null));
  if (!p) return { queued: false, reason: 'Browser not found.' };
  if (!p.node) return { queued: false, node: false, reason: 'No node holds data for this browser.' };
  const problem = nodeProblem(p.node);
  if (problem) return { queued: false, reason: problem };
  const job: BrowserJob = { kind: 'profile.remove', workspaceId, profileId, after };
  const jobId = browserJobId(job, deps.now().toString(36));
  try {
    await withTimeout(
      deps.queue(p.node.name).add(p.node.name, job, { ...BROWSER_JOB_OPTIONS, attempts: 3, jobId }),
    );
  } catch {
    return { queued: false, reason: 'Could not reach the job queue. Try again in a minute.' };
  }
  return { queued: true, jobId, node: p.node.name };
}

/** How long a finished cookie export stays downloadable. */
export const COOKIE_EXPORT_KEEP_SEC = 600;

/**
 * Queues `profile.exportCookies` or `profile.clearData` (plan 0004 phase 4) on the browser's node. An export's
 * return value holds the cookies (encrypted by the gateway), so that job is removed after ten minutes instead
 * of the usual week. Callers check permissions first.
 */
export async function enqueueDataJob(
  workspaceId: string,
  profileId: string,
  what: { kind: 'profile.exportCookies' } | { kind: 'profile.clearData'; cookies: boolean; cache: boolean },
  deps: BrowserJobDeps = defaultDeps,
): Promise<EnqueueResult> {
  const { found, node } = await deps.profileNode(workspaceId, profileId);
  if (!found) return { queued: false, reason: 'Browser not found.' };
  const problem = nodeProblem(node);
  if (problem || !node) return { queued: false, reason: problem ?? 'No node.' };
  const job: BrowserJob = { ...what, workspaceId, profileId };
  const jobId = browserJobId(job, deps.now().toString(36));
  const opts: JobsOptions =
    what.kind === 'profile.exportCookies'
      ? {
          ...BROWSER_JOB_OPTIONS,
          attempts: 2,
          removeOnComplete: { age: COOKIE_EXPORT_KEEP_SEC },
          removeOnFail: { age: 3600 },
        }
      : { ...BROWSER_JOB_OPTIONS, attempts: 2 };
  try {
    await withTimeout(deps.queue(node.name).add(node.name, job, { ...opts, jobId }));
  } catch {
    return { queued: false, reason: 'Could not reach the job queue. Try again in a minute.' };
  }
  return { queued: true, jobId, node: node.name };
}

export type CookieExport =
  | { state: 'pending' }
  | { state: 'gone' }
  | { state: 'failed'; reason: string }
  /** `enc`: the cookies as the gateway encrypted them; decrypt only to hand them to the person who asked */
  | { state: 'done'; enc: string; count: number; truncated: boolean };

/** Reads back a cookie export this browser queued. A job id of another browser or kind reads as `gone`. */
export async function cookieExportStatus(
  workspaceId: string,
  profileId: string,
  jobId: string,
  deps: Pick<BrowserJobDeps, 'queue' | 'profileNode'> = defaultDeps,
): Promise<CookieExport> {
  if (!jobId.startsWith(`bj-profile.exportCookies-${profileId}-`)) return { state: 'gone' };
  const { node } = await deps.profileNode(workspaceId, profileId);
  if (!node) return { state: 'gone' };
  let job: Awaited<ReturnType<JobQueue['getJob']>>;
  let state: string;
  try {
    job = await withTimeout(deps.queue(node.name).getJob(jobId));
    if (!job) return { state: 'gone' };
    state = await withTimeout(job.getState());
  } catch {
    return { state: 'pending' };
  }
  if (state === 'failed') return { state: 'failed', reason: 'The browser could not read its cookies.' };
  if (state !== 'completed') return { state: 'pending' };
  const v = (job.returnvalue ?? {}) as {
    outcome?: string;
    reason?: string;
    data?: { enc?: unknown; count?: unknown; truncated?: unknown };
  };
  if (v.outcome === 'ok' && typeof v.data?.enc === 'string')
    return {
      state: 'done',
      enc: v.data.enc,
      count: typeof v.data.count === 'number' ? v.data.count : 0,
      truncated: v.data.truncated === true,
    };
  if (v.outcome === 'license_denied')
    return { state: 'failed', reason: 'The node has no free browser seat right now.' };
  if (v.outcome === 'proxy_failed')
    return { state: 'failed', reason: 'The proxy failed, so the browser could not start.' };
  return { state: 'failed', reason: v.reason ?? 'The browser could not read its cookies.' };
}

/**
 * Queues a pool proxy job (plan 0004 phase 3): `proxy.check` or `proxy.rotate`. These need no browser, so any
 * online node of the workspace runs them; with no node online nothing is queued. Callers check permissions first.
 */
export async function enqueueProxyJob(
  workspaceId: string,
  proxyId: string,
  kind: 'proxy.check' | 'proxy.rotate',
  deps: Pick<BrowserJobDeps, 'queue' | 'now'> & {
    onlineNodes: (workspaceId: string) => Promise<{ name: string }[]>;
  } = { ...defaultDeps, onlineNodes: (ws) => nodes.listOnline(ws) },
): Promise<EnqueueResult> {
  const online = await deps.onlineNodes(workspaceId);
  const node = online[0];
  if (!node)
    return {
      queued: false,
      reason: 'No browser node is online. Proxy checks run from a node; try again later.',
    };
  const job: BrowserJob = { kind, workspaceId, proxyId };
  const jobId = browserJobId(job, deps.now().toString(36));
  try {
    await withTimeout(
      deps.queue(node.name).add(node.name, job, { ...BROWSER_JOB_OPTIONS, attempts: 2, jobId }),
    );
  } catch {
    return { queued: false, reason: 'Could not reach the job queue. Try again in a minute.' };
  }
  return { queued: true, jobId, node: node.name };
}

/** BullMQ waits forever for a missing Redis (`maxRetriesPerRequest: null`); a page action must not. */
export const QUEUE_TIMEOUT_MS = 5_000;
function withTimeout<T>(p: Promise<T>, ms = QUEUE_TIMEOUT_MS): Promise<T> {
  let t: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    p,
    new Promise<never>((_, reject) => {
      t = setTimeout(() => reject(new Error('queue timeout')), ms);
    }),
  ]).finally(() => clearTimeout(t));
}

export type WhoamiStatus =
  | { state: 'pending' }
  | { state: 'gone' }
  | { state: 'failed'; reason: string }
  | { state: 'done'; whoami: WhoamiData };

/** Job ids {@link whoamiStatus} reads: `profile.whoami` and `profile.signIn` (both answer with WhoamiData). */
export function isSignInJobId(profileId: string, jobId: string): boolean {
  return (
    jobId.startsWith(`bj-profile.whoami-${profileId}-`) || jobId.startsWith(`bj-profile.signIn-${profileId}-`)
  );
}

/**
 * Reads back a `profile.whoami` / `profile.signIn` job this profile queued (on the profile's current node). Only
 * the parsed whoami answer leaves this function; a job id of another profile or kind reads as `gone`.
 */
export async function whoamiStatus(
  workspaceId: string,
  profileId: string,
  jobId: string,
  deps: Pick<BrowserJobDeps, 'queue' | 'profileNode'> = defaultDeps,
): Promise<WhoamiStatus> {
  if (!isSignInJobId(profileId, jobId)) return { state: 'gone' };
  const { node } = await deps.profileNode(workspaceId, profileId);
  if (!node) return { state: 'gone' };
  let job: Awaited<ReturnType<JobQueue['getJob']>>;
  let state: string;
  try {
    job = await withTimeout(deps.queue(node.name).getJob(jobId));
    if (!job) return { state: 'gone' };
    state = await withTimeout(job.getState());
  } catch {
    return { state: 'pending' };
  }
  if (state === 'failed') return { state: 'failed', reason: whoamiFailure(job.failedReason) };
  if (state !== 'completed') return { state: 'pending' };
  return readWhoamiResult(job.returnvalue);
}

/** A failed whoami job's reason → a message for the page. Only known codes are mapped; nothing else is echoed. */
export function whoamiFailure(failedReason: string | undefined): string {
  const r = failedReason ?? '';
  if (r.includes('identity_conflict'))
    return 'This Reddit user is already connected in this workspace, or the browser is signed in as a different user.';
  if (r.includes('bad_whoami_data')) return 'The browser returned an answer Threadline could not read.';
  if (r.includes('not signed in') || r.includes('not identified')) return 'Not signed in yet.';
  return 'The browser could not check the sign-in.';
}

/** Gateway return value → status. `{ outcome: 'ok', data: WhoamiData }`, or a skipped / error outcome. */
export function readWhoamiResult(value: unknown): WhoamiStatus {
  const v = (value ?? {}) as { outcome?: string; data?: unknown; reason?: string; code?: string };
  if (v.outcome === 'ok') {
    const w = WhoamiData.safeParse(v.data);
    return w.success
      ? { state: 'done', whoami: w.data }
      : { state: 'failed', reason: 'The browser returned an answer Threadline could not read.' };
  }
  if (v.outcome === 'skipped') return { state: 'failed', reason: v.reason ?? 'The check was skipped.' };
  if (v.outcome === 'proxy_failed')
    return { state: 'failed', reason: 'The proxy failed. Check it on the Browsers screen.' };
  if (v.outcome === 'needs_human')
    return {
      state: 'failed',
      reason: 'Reddit wants a human check (captcha or verification). Take control and finish signing in.',
    };
  if (v.outcome === 'license_denied')
    return { state: 'failed', reason: 'The node has no free browser seat right now.' };
  return { state: 'failed', reason: 'The browser could not check the sign-in.' };
}
