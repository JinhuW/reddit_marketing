import { z } from 'zod';

/** BullMQ queue names (docs/PLAN.md §9). Shared by apps/web (producers) and apps/worker (processors). */
export const QUEUES = {
  redditPoll: 'reddit.poll',
  opportunityScore: 'opportunity.score',
  draftGenerate: 'draft.generate',
  postPublish: 'post.publish',
  dmPoll: 'dm.poll',
  commentPoll: 'comment.poll',
  accountStats: 'account.stats',
  subredditRefresh: 'subreddit.refresh',
  attributionRollup: 'attribution.rollup',
  leadSync: 'lead.sync',
  contextEmbed: 'context.embed',
  browserHealth: 'browser.health',
  sessionIdle: 'session.idle',
  reportWeekly: 'report.weekly',
} as const;
export type QueueName = (typeof QUEUES)[keyof typeof QUEUES];

export interface DraftGenerateJob {
  workspaceId: string;
  /** set for Regenerate; absent when generating from an opportunity or conversation */
  draftId?: string;
  opportunityId?: string;
  conversationId?: string;
  agentId: string;
  type: 'comment' | 'post' | 'dm';
  instruction?: string;
  requestedByMemberId: string;
}
export interface PostPublishJob {
  workspaceId: string;
  draftId: string;
}

// ── browser nodes (docs/plans/0001-infra-implementation.md §3.3) ──

/** One BullMQ queue per browser node, consumed only by the gateway (`SERVICE_ROLE=gateway`). */
export const browserQueue = <N extends string>(nodeName: N) => `browser.${nodeName}` as const;

/**
 * A job on `browserQueue(nodeName)`. Payloads never contain secrets: the gateway loads the profile
 * (and decrypts proxy credentials) with `browsers.getProfileForDispatch` at dispatch time.
 */
export type BrowserJob =
  | { kind: 'profile.start'; workspaceId: string; profileId: string; reason: 'action' | 'takeover' | 'test' }
  | { kind: 'profile.stop'; workspaceId: string; profileId: string; reason: 'idle' | 'handback' | 'manual' }
  | {
      kind: 'action.submitComment' | 'action.sendDm';
      workspaceId: string;
      profileId: string;
      draftId: string;
    }
  | { kind: 'profile.testProxy'; workspaceId: string; profileId: string }
  | { kind: 'health.check'; workspaceId: string };
export type BrowserJobKind = BrowserJob['kind'];

const id = z.string().min(1);
/** Runtime check for job data read back from Redis. `.strict()` rejects extra keys (e.g. a leaked secret). */
export const BrowserJobSchema: z.ZodType<BrowserJob> = z.union([
  z
    .object({
      kind: z.literal('profile.start'),
      workspaceId: id,
      profileId: id,
      reason: z.enum(['action', 'takeover', 'test']),
    })
    .strict(),
  z
    .object({
      kind: z.literal('profile.stop'),
      workspaceId: id,
      profileId: id,
      reason: z.enum(['idle', 'handback', 'manual']),
    })
    .strict(),
  z
    .object({
      kind: z.enum(['action.submitComment', 'action.sendDm']),
      workspaceId: id,
      profileId: id,
      draftId: id,
    })
    .strict(),
  z.object({ kind: z.literal('profile.testProxy'), workspaceId: id, profileId: id }).strict(),
  z.object({ kind: z.literal('health.check'), workspaceId: id }).strict(),
]);

/**
 * BullMQ job id for a browser job: `bj-<kind>-<draftId|profileId>` (no colons; BullMQ rejects them).
 * Actions key on the draft, so one draft is queued at most once per node queue. `health.check` keys on
 * the workspace; pass `suffix` (e.g. a time bucket) to make a repeating job unique.
 */
export function browserJobId(job: BrowserJob, suffix?: string): string {
  const key = 'draftId' in job ? job.draftId : 'profileId' in job ? job.profileId : job.workspaceId;
  const out = `bj-${job.kind}-${key}${suffix ? `-${suffix}` : ''}`;
  if (out.includes(':')) throw new Error(`browser job id must not contain ':' (${out})`);
  return out;
}
