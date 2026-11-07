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
