/**
 * Gateway dispatch (docs/plans/0001-infra-implementation.md §3.3, §3.4, §4 T20).
 *
 * For every node the hub reports online, one BullMQ `Worker` consumes `browserQueue(name)` with concurrency
 * `maxProfiles`; jobs for one profile run one at a time (an in-process per-profile lock: the gateway is a single
 * replica). The worker is closed when the node goes offline.
 *
 * Per job: validate the payload, load the profile with `browsers.getProfileForDispatch` (decrypted proxy; only
 * ever put into the command sent over the authenticated socket), build the `Cmd`, `hub.send` it with
 * `cmdId = job.id`, and map the result through outcomes.ts.
 *
 * APPROVAL GATE (block): `action.submitComment` / `action.sendDm` re-read the Draft and refuse unless it is
 * `approved`/`scheduled`, has an `approverMemberId` whose member can still approve, is not posted, belongs to
 * the profile's account, and passes every block rule again at post time (`assertPublishable`, the same check
 * post.publish runs). The check runs again right before the command is sent. A refused draft never reaches the
 * agent.
 *
 * Retries: `NodeNotConnected`, `NodeTimeout` and `NodeDisconnected` are thrown as is, so BullMQ retries the job
 * with the same id; the agent replays its stored result for that cmdId, so a comment posted before a disconnect
 * is recorded once and never posted twice. Producers enqueue with {@link browserJobOptions}; to run a command
 * again after it finished (e.g. after a hand-back), they need a new job id (`browserJobId(job, suffix)`).
 * An agent `error` for a non-action kind (including the implicit start before an action) is retried too, since
 * the agent does not cache those; an action's own `error` is final (cached and replayed by the agent). If the
 * implicit start fails for good, the action's draft is marked failed (nothing was posted).
 *
 * Offline sweep: when a node goes offline with jobs still queued, the accounts of those jobs' profiles are paused
 * with `node_offline`; when the node returns, `node_offline` pauses (only those) of its profiles are resumed
 * before its worker starts again.
 */
import { PolicyError, assertPublishable } from '@threadline/agents';
import { browsers, drafts } from '@threadline/db';
import {
  type BrowserJob,
  type BrowserJobKind,
  BrowserJobSchema,
  type Cmd,
  type NodeEvent,
  type Result,
  browserQueue,
} from '@threadline/shared';
import {
  type ConnectionOptions,
  type Job,
  type JobsOptions,
  Queue,
  UnrecoverableError,
  Worker,
} from 'bullmq';
import { redisConnection } from '../connection';
import { log as rootLog } from '../log';
import type { Hub, NodeInfo, OfflineInfo } from './hub';
import type { GatewayPlugin } from './index';
import {
  type BrowserJobOutcome,
  FinalOutcomeError,
  type OutcomeContext,
  type OutcomeDeps,
  RetryableOutcomeError,
  applyOutcome,
  defaultOutcomeDeps,
} from './outcomes';

// ── constants for producers ──

/** Result budget per command kind (sent to the agent as `deadlineMs`). */
export const BROWSER_DEADLINE_MS: Record<BrowserJobKind, number> = {
  'profile.start': 90_000,
  'profile.stop': 30_000,
  'action.submitComment': 120_000,
  'action.sendDm': 120_000,
  'profile.testProxy': 45_000,
  'health.check': 15_000,
};

/** BullMQ options every producer of a browser job should use: node errors are retryable. */
export const browserJobOptions: JobsOptions = {
  attempts: 5,
  backoff: { type: 'exponential', delay: 5_000 },
  removeOnComplete: { age: 7 * 24 * 3600, count: 1_000 },
  removeOnFail: { age: 30 * 24 * 3600 },
};

/** States a job can be in while it still needs the node. */
const QUEUED_STATES = ['waiting', 'delayed', 'prioritized', 'paused', 'waiting-children', 'active'] as const;

const DM_SUBJECT = 'Re: your question'; // same as post.publish

// ── results ──

export type DispatchResult = BrowserJobOutcome | { outcome: 'skipped'; reason: string };

/** The approval gate (or another pre-send check) refused the job. Never retried. */
export class DispatchRefused extends Error {
  constructor(
    message: string,
    readonly failures: string[] = [],
  ) {
    super(message);
    this.name = 'DispatchRefused';
  }
}

// ── dependencies ──

type Draft = NonNullable<Awaited<ReturnType<typeof drafts.get>>>;

export interface DispatchDeps {
  getProfile: typeof browsers.getProfileForDispatch;
  listProfiles: (workspaceId: string) => Promise<{ id: string; accountId: string; nodeId: string | null }[]>;
  getDraft: (workspaceId: string, draftId: string) => Promise<Draft | null>;
  approverCouldApprove: (d: Draft) => Promise<boolean>;
  evaluate: (d: Draft, now: Date) => ReturnType<typeof drafts.evaluate>;
  markFailed: (draftId: string, error: string) => Promise<unknown>;
  pauseAccount: typeof browsers.pauseAccount;
  resumeAccount: typeof browsers.resumeAccount;
}

const defaultDeps: DispatchDeps = {
  getProfile: (ws, id) => browsers.getProfileForDispatch(ws, id),
  listProfiles: (ws) => browsers.listProfiles(ws),
  getDraft: (ws, id) => drafts.get(ws, id),
  approverCouldApprove: (d) => drafts.approverCouldApprove(d),
  evaluate: (d, now) => drafts.evaluate(d, now),
  markFailed: (id, error) => drafts.markFailed(id, error),
  pauseAccount: (i) => browsers.pauseAccount(i),
  resumeAccount: (i) => browsers.resumeAccount(i),
};

export interface DispatcherOptions {
  hub: Hub;
  connection?: ConnectionOptions;
  log?: typeof rootLog;
  /** Override per-kind deadlines (tests). */
  deadlines?: Partial<Record<BrowserJobKind, number>>;
  deps?: Partial<DispatchDeps>;
  outcomeDeps?: Partial<OutcomeDeps>;
  now?: () => Date;
}

interface NodeSlot {
  worker: Worker;
  info: NodeInfo;
}

type DispatchProfile = NonNullable<Awaited<ReturnType<typeof browsers.getProfileForDispatch>>>;
type ActionJob = Extract<BrowserJob, { draftId: string }>;

const isAction = (j: BrowserJob): j is ActionJob =>
  j.kind === 'action.submitComment' || j.kind === 'action.sendDm';

export class Dispatcher {
  private readonly hub: Hub;
  private readonly connection: ConnectionOptions;
  private readonly log: typeof rootLog;
  private readonly deadlines: Record<BrowserJobKind, number>;
  private readonly deps: DispatchDeps;
  private readonly outcomeDeps: OutcomeDeps;
  private readonly now: () => Date;

  private readonly slots = new Map<string, NodeSlot>();
  /** Serializes online/offline handling per node, so a quick reconnect never races its own offline sweep. */
  private readonly nodeChains = new Map<string, Promise<void>>();
  private readonly profileLocks = new Map<string, Promise<void>>();
  /** Profiles this gateway started since the node's last heartbeat could report them. */
  private readonly started = new Map<string, Set<string>>();
  private readonly queues = new Map<string, Queue>();
  private running = false;

  private readonly onOnline = (info: NodeInfo) => this.serial(info.name, () => this.nodeOnline(info));
  private readonly onOffline = (info: OfflineInfo) => this.serial(info.name, () => this.nodeOffline(info));
  private readonly onEvent = (e: { node: string; event: NodeEvent }) => {
    if (e.event.kind === 'container.exited') this.started.get(e.node)?.delete(e.event.profileId);
  };

  constructor(opts: DispatcherOptions) {
    this.hub = opts.hub;
    this.connection = opts.connection ?? redisConnection();
    this.log = (opts.log ?? rootLog).child({ component: 'gateway.dispatch' });
    this.deadlines = { ...BROWSER_DEADLINE_MS, ...opts.deadlines };
    this.deps = { ...defaultDeps, ...opts.deps };
    this.outcomeDeps = { ...defaultOutcomeDeps, ...opts.outcomeDeps };
    this.now = opts.now ?? (() => new Date());
  }

  /** Subscribes to the hub and starts workers for nodes that are already online. */
  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.hub.on('online', this.onOnline);
    this.hub.on('offline', this.onOffline);
    this.hub.on('event', this.onEvent);
    for (const info of this.hub.nodes()) this.onOnline(info);
    await this.idle();
  }

  /** Detaches from the hub and closes every worker (waiting for active jobs) and queue handle. */
  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    this.hub.off('online', this.onOnline);
    this.hub.off('offline', this.onOffline);
    this.hub.off('event', this.onEvent);
    await this.idle();
    await Promise.all([...this.slots.values()].map((s) => s.worker.close()));
    this.slots.clear();
    await Promise.all([...this.queues.values()].map((q) => q.close()));
    this.queues.clear();
  }

  /** Resolves when pending online/offline handling has finished (tests and shutdown). */
  async idle(): Promise<void> {
    while (true) {
      const all = [...this.nodeChains.values()];
      await Promise.all(all);
      if ([...this.nodeChains.values()].every((p, i) => p === all[i]) && all.length === this.nodeChains.size)
        return;
    }
  }

  /** Nodes with a running queue worker. */
  activeNodes(): string[] {
    return [...this.slots.keys()];
  }

  // ── node lifecycle ──

  private serial(name: string, fn: () => Promise<void>): void {
    const prev = this.nodeChains.get(name) ?? Promise.resolve();
    const next = prev
      .then(fn)
      .catch((e) => this.log.error({ node: name, err: (e as Error).message }, 'node transition failed'));
    this.nodeChains.set(name, next);
  }

  private queue(name: string): Queue {
    let q = this.queues.get(name);
    if (!q) {
      q = new Queue(browserQueue(name), { connection: this.connection });
      this.queues.set(name, q);
    }
    return q;
  }

  /** Jobs still waiting for the node, as parsed payloads of this node's workspace. */
  private async queuedJobs(name: string, workspaceId: string): Promise<BrowserJob[]> {
    const jobs = await this.queue(name).getJobs([...QUEUED_STATES], 0, 999);
    return jobs.flatMap((j) => {
      const p = BrowserJobSchema.safeParse(j?.data);
      return p.success && p.data.workspaceId === workspaceId ? [p.data] : [];
    });
  }

  /** Account ids of the given profiles (one workspace). */
  private async accountsOf(workspaceId: string, pick: (p: { id: string; nodeId: string | null }) => boolean) {
    const profiles = await this.deps.listProfiles(workspaceId);
    return [...new Set(profiles.filter(pick).map((p) => p.accountId))];
  }

  private async nodeOnline(info: NodeInfo): Promise<void> {
    if (!this.running) return;
    const old = this.slots.get(info.name);
    if (old) {
      this.slots.delete(info.name);
      await old.worker.close();
    }
    this.started.set(info.name, new Set());

    // Resume what the offline sweep paused: the node's own profiles and any profile with a queued job.
    const queued = await this.queuedJobs(info.name, info.workspaceId);
    const queuedProfiles = new Set(queued.flatMap((j) => ('profileId' in j ? [j.profileId] : [])));
    const accounts = await this.accountsOf(
      info.workspaceId,
      (p) => p.nodeId === info.nodeId || queuedProfiles.has(p.id),
    );
    for (const accountId of accounts) {
      const r = await this.deps.resumeAccount({
        workspaceId: info.workspaceId,
        accountId,
        onlyReasons: ['node_offline'],
      });
      if (r.changed) this.log.info({ node: info.name, accountId }, 'account resumed: node back online');
    }
    if (!this.running) return;

    const worker = new Worker(browserQueue(info.name), (job: Job) => this.process(info.name, job), {
      connection: this.connection,
      concurrency: Math.max(1, info.maxProfiles),
      autorun: true,
    });
    worker.on('error', (err) => this.log.error({ node: info.name, err: err.message }, 'queue worker error'));
    worker.on('failed', (job, err) =>
      this.log.warn({ node: info.name, jobId: job?.id, err: err.message }, 'browser job failed'),
    );
    this.slots.set(info.name, { worker, info });
    this.log.info({ node: info.name, concurrency: info.maxProfiles }, 'dispatching browser jobs');
  }

  private async nodeOffline(info: OfflineInfo): Promise<void> {
    const slot = this.slots.get(info.name);
    this.slots.delete(info.name);
    this.started.delete(info.name);
    // In-flight sends were already rejected by the hub, so active jobs settle (and go back for retry) quickly.
    if (slot) await slot.worker.close();
    if (!this.running || info.reason === 'gateway_shutdown') return;

    const queued = await this.queuedJobs(info.name, info.workspaceId);
    const profiles = new Set(queued.flatMap((j) => ('profileId' in j ? [j.profileId] : [])));
    if (profiles.size === 0) return;
    const accounts = await this.accountsOf(info.workspaceId, (p) => profiles.has(p.id));
    for (const accountId of accounts) {
      const r = await this.deps.pauseAccount({
        workspaceId: info.workspaceId,
        accountId,
        reason: 'node_offline',
        detail: `${info.name}: ${info.reason}`,
      });
      if (r.changed) this.log.warn({ node: info.name, accountId }, 'account paused: node offline');
    }
  }

  // ── per job ──

  private async withProfileLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.profileLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const mine = new Promise<void>((r) => {
      release = r;
    });
    const tail = prev.then(() => mine);
    this.profileLocks.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (this.profileLocks.get(key) === tail) this.profileLocks.delete(key);
    }
  }

  /** BullMQ processor. Exported through the class for tests; producers never call it. */
  async process(nodeName: string, job: Job): Promise<DispatchResult> {
    const parsed = BrowserJobSchema.safeParse(job.data);
    if (!parsed.success) throw new UnrecoverableError('invalid browser job payload');
    const data = parsed.data;
    const cmdId = job.id;
    if (!cmdId) throw new UnrecoverableError('browser job without an id');
    const node = this.slots.get(nodeName)?.info ?? this.hub.nodes().find((n) => n.name === nodeName);
    if (!node) throw new Error(`node ${nodeName} is not connected`); // retryable
    if (data.workspaceId !== node.workspaceId)
      throw new UnrecoverableError('browser job belongs to another workspace than its node');

    try {
      if (data.kind === 'health.check') {
        const result = await this.send(nodeName, { kind: 'health.check' }, cmdId, data.kind);
        return await this.apply({ job: data, cmdId, node: nodeName, profile: null }, result);
      }
      // BullMQ counts failed attempts in attemptsMade; this run is the last one when no retry is left.
      const lastAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? 1);
      return await this.withProfileLock(`${nodeName}/${data.profileId}`, () =>
        this.processProfileJob(node, data, cmdId, lastAttempt),
      );
    } catch (e) {
      if (e instanceof DispatchRefused || e instanceof FinalOutcomeError) {
        this.log.warn({ node: nodeName, cmdId, kind: data.kind, why: e.message }, 'browser job refused');
        throw new UnrecoverableError(e.message);
      }
      throw e;
    }
  }

  private async processProfileJob(
    node: NodeInfo,
    job: Exclude<BrowserJob, { kind: 'health.check' }>,
    cmdId: string,
    lastAttempt = false,
  ): Promise<DispatchResult> {
    const profile = await this.deps.getProfile(job.workspaceId, job.profileId);
    if (!profile) throw new DispatchRefused('browser profile not found');
    if (profile.node?.id !== node.nodeId)
      throw new DispatchRefused(`profile is not assigned to node ${node.name}`);
    const ctx: OutcomeContext = { job, cmdId, node: node.name, profile };

    switch (job.kind) {
      case 'profile.start': {
        const result = await this.send(node.name, startCmd(profile), cmdId, job.kind);
        if (result.outcome === 'ok') this.started.get(node.name)?.add(profile.id);
        return this.apply(ctx, result);
      }
      case 'profile.stop': {
        const result = await this.send(
          node.name,
          { kind: 'profile.stop', profileId: profile.id },
          cmdId,
          job.kind,
        );
        if (result.outcome === 'ok') this.started.get(node.name)?.delete(profile.id);
        return this.apply(ctx, result);
      }
      case 'profile.testProxy': {
        const pre = await this.ensureRunning(node, profile, cmdId, 'test', null, lastAttempt);
        if (pre) return pre;
        const result = await this.send(
          node.name,
          { kind: 'profile.testProxy', profileId: profile.id },
          cmdId,
          job.kind,
        );
        return this.apply(ctx, result);
      }
      case 'action.submitComment':
      case 'action.sendDm': {
        // Gate before anything reaches the node, and again right before the command is sent.
        const first = await this.approvalGate(job, profile);
        if ('skipped' in first) return { outcome: 'skipped', reason: first.skipped };
        const pre = await this.ensureRunning(node, profile, cmdId, 'action', job, lastAttempt);
        if (pre) return pre;
        const gate = await this.approvalGate(job, profile);
        if ('skipped' in gate) return { outcome: 'skipped', reason: gate.skipped };
        const result = await this.send(node.name, gate.cmd, cmdId, job.kind);
        return this.apply(ctx, result);
      }
    }
  }

  /**
   * Starts the profile first when the node does not report it running. Returns a final result when the start
   * did not succeed (the start's outcome is applied, e.g. `license_denied` pauses the account), else null.
   *
   * When the start fails for good (a final refusal, or any failure on the job's last attempt), the action's
   * draft is marked failed if it is still approved/scheduled: nothing was sent to Reddit, and without this the
   * draft would stay `approved` behind a failed job id that BullMQ keeps (and dedupes) for 30 days.
   */
  private async ensureRunning(
    node: NodeInfo,
    profile: DispatchProfile,
    cmdId: string,
    reason: 'action' | 'test',
    action: ActionJob | null = null,
    lastAttempt = false,
  ): Promise<DispatchResult | null> {
    try {
      return await this.startIfNeeded(node, profile, cmdId, reason);
    } catch (e) {
      const final = e instanceof DispatchRefused || e instanceof FinalOutcomeError || lastAttempt;
      if (action && final) {
        const code =
          e instanceof FinalOutcomeError || e instanceof RetryableOutcomeError
            ? e.code
            : e instanceof DispatchRefused
              ? 'refused'
              : (e as Error).name;
        const status = await this.outcomeDeps.draftStatus(action.workspaceId, action.draftId);
        if (status === 'approved' || status === 'scheduled') {
          await this.deps.markFailed(
            action.draftId,
            `Browser profile could not be started on ${node.name}: ${code}; nothing was sent.`,
          );
          this.log.warn(
            { node: node.name, cmdId, draftId: action.draftId, code },
            'start failed for good; draft marked failed',
          );
        }
      }
      throw e;
    }
  }

  private async startIfNeeded(
    node: NodeInfo,
    profile: DispatchProfile,
    cmdId: string,
    reason: 'action' | 'test',
  ): Promise<DispatchResult | null> {
    const live = this.hub.nodes().find((n) => n.name === node.name);
    const running =
      live?.running.some((r) => r.profileId === profile.id) || this.started.get(node.name)?.has(profile.id);
    if (running) return null;
    const startJob: BrowserJob = {
      kind: 'profile.start',
      workspaceId: profile.workspaceId,
      profileId: profile.id,
      reason,
    };
    const result = await this.send(node.name, startCmd(profile), `${cmdId}-start`, 'profile.start');
    const out = await this.apply(
      { job: startJob, cmdId: `${cmdId}-start`, node: node.name, profile },
      result,
    );
    if (result.outcome === 'ok') {
      this.started.get(node.name)?.add(profile.id);
      return null;
    }
    return out;
  }

  /**
   * The approval gate for browser posting. Returns the command to send, `skipped` for a draft that is already
   * posted, or throws DispatchRefused. Mirrors post.publish: a draft that fails a block rule at post time is
   * marked failed (except "not due yet"), and nothing is sent.
   */
  private async approvalGate(
    job: ActionJob,
    profile: DispatchProfile,
  ): Promise<{ cmd: Cmd } | { skipped: string }> {
    const d = await this.deps.getDraft(job.workspaceId, job.draftId);
    if (!d) throw new DispatchRefused('draft not found');
    if (d.status === 'posted' || d.postedRedditId) return { skipped: 'already posted' };
    const fail = async (reason: string, failures: string[] = []): Promise<never> => {
      if (d.status === 'approved' || d.status === 'scheduled') await this.deps.markFailed(d.id, reason);
      throw new DispatchRefused(reason, failures);
    };

    // Not a block rule of its own, but nothing below may run for an unapproved draft.
    if ((d.status !== 'approved' && d.status !== 'scheduled') || !d.approverMemberId)
      throw new DispatchRefused(
        `Draft is ${d.status}${d.approverMemberId ? '' : ' with no approver'}; not sent.`,
      );
    if (d.accountId !== profile.accountId)
      throw new DispatchRefused('draft belongs to another account than the browser profile');
    if (profile.account.pausedReason)
      throw new DispatchRefused(`account is paused (${profile.account.pausedReason}); not sent`);
    const expected = job.kind === 'action.submitComment' ? 'comment' : 'dm';
    if (d.type !== expected) throw new DispatchRefused(`a ${d.type} draft cannot be sent with ${job.kind}`);

    const now = this.now();
    try {
      assertPublishable(d, await this.deps.approverCouldApprove(d), await this.deps.evaluate(d, now), now);
    } catch (e) {
      if (!(e instanceof PolicyError)) throw e;
      if (/Scheduled time/.test(e.message)) throw new DispatchRefused(e.message);
      return fail(e.message, e.failures);
    }

    if (job.kind === 'action.sendDm') {
      const to = d.conversation?.lead.redditUser.username;
      if (!to) return fail('DM draft has no recipient');
      return {
        cmd: {
          kind: 'action.sendDm',
          profileId: profile.id,
          draftId: d.id,
          to,
          subject: DM_SUBJECT,
          body: d.body,
        },
      };
    }
    const parentFullname =
      d.opportunity?.post.redditId ??
      [...(d.conversation?.messages ?? [])].reverse().find((m) => m.direction === 'in' && m.redditId)
        ?.redditId;
    const post = d.opportunity?.post ?? d.conversation?.post ?? null;
    if (!parentFullname || !/^t[13]_[a-z0-9]+$/i.test(parentFullname))
      return fail('comment draft has no thread or message to reply to');
    if (!post) return fail('comment draft has no thread URL');
    const threadUrl =
      post.url && /^https:\/\/(www\.|old\.)?reddit\.com\//.test(post.url)
        ? post.url
        : `https://www.reddit.com/r/${post.subreddit.name}/comments/${post.redditId.replace(/^t3_/, '')}/`;
    return {
      cmd: {
        kind: 'action.submitComment',
        profileId: profile.id,
        draftId: d.id,
        threadUrl,
        parentFullname,
        body: d.body,
      },
    };
  }

  private send(nodeName: string, cmd: Cmd, cmdId: string, kind: BrowserJobKind): Promise<Result> {
    return this.hub.send(nodeName, cmd, { cmdId, deadlineMs: this.deadlines[kind] });
  }

  private apply(ctx: OutcomeContext, result: Result): Promise<BrowserJobOutcome> {
    return applyOutcome(ctx, result, this.outcomeDeps, this.log);
  }
}

/** `profile.start` from the dispatch profile. Refuses a profile without its CloakBrowser fingerprint. */
function startCmd(p: DispatchProfile): Cmd {
  if (!p.cloak)
    throw new DispatchRefused(
      'profile has no CloakBrowser fingerprint yet (ensureCloakFingerprint at connect)',
    );
  return {
    kind: 'profile.start',
    profileId: p.id,
    seed: p.cloak.seed,
    persona: p.cloak.persona,
    gpu: p.cloak.gpu,
    tz: p.tz,
    locale: p.locale,
    screen: p.screen,
    proxy: p.proxy,
  };
}

export function createDispatcher(opts: DispatcherOptions): Dispatcher {
  return new Dispatcher(opts);
}

/**
 * Gateway plugin: `startGateway({ plugins: [dispatchPlugin()] })`. Stops before the hub closes, so a
 * gateway shutdown never pauses accounts.
 */
export function dispatchPlugin(opts: Omit<DispatcherOptions, 'hub' | 'log'> = {}): GatewayPlugin {
  return {
    name: 'dispatch',
    async start(ctx) {
      const d = createDispatcher({ ...opts, hub: ctx.hub, log: ctx.log });
      await d.start();
      return () => d.stop();
    },
  };
}
