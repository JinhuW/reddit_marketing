/**
 * Single source of truth for enum values. These mirror the Prisma enums in
 * packages/db/prisma/schema.prisma — keep them in sync (enums.test.ts checks it).
 */
export const Plan = ['starter', 'pro', 'agency'] as const;
export type Plan = (typeof Plan)[number];

export const MemberRole = ['admin', 'approver', 'editor', 'viewer'] as const;
export type MemberRole = (typeof MemberRole)[number];

export const AccountRoleLabel = ['founder', 'support', 'brand'] as const;
export type AccountRoleLabel = (typeof AccountRoleLabel)[number];

/** How Threadline talks to Reddit for an account: the Reddit API (OAuth app) or the account's own browser profile. */
export const AccountAuthMode = ['oauth', 'browser'] as const;
export type AccountAuthMode = (typeof AccountAuthMode)[number];

export const AccountHealth = ['healthy', 'watch', 'blocked'] as const;
export type AccountHealth = (typeof AccountHealth)[number];

export const BrowserProfileStatus = ['idle', 'running', 'check', 'error'] as const;
export type BrowserProfileStatus = (typeof BrowserProfileStatus)[number];

export const ProxyProtocol = ['http', 'socks5', 'none'] as const;
export type ProxyProtocol = (typeof ProxyProtocol)[number];

export const SessionDriver = ['agent', 'human'] as const;
export type SessionDriver = (typeof SessionDriver)[number];

export const AgentStatus = ['active', 'paused'] as const;
export type AgentStatus = (typeof AgentStatus)[number];

export const SkillKey = ['compare_answer', 'launch_post', 'demo_followup', 'thread_to_blog'] as const;
export type SkillKey = (typeof SkillKey)[number];

export const ContextKind = ['doc', 'url', 'faq', 'pricing', 'approved_reply'] as const;
export type ContextKind = (typeof ContextKind)[number];

export const ConnectorProvider = [
  'notion',
  'gdrive',
  'hubspot',
  'attio',
  'slack',
  'ga4',
  'posthog',
  'stripe',
  'calendly',
] as const;
export type ConnectorProvider = (typeof ConnectorProvider)[number];

export const ConnectorStatus = ['connected', 'disconnected', 'error', 'coming_soon'] as const;
export type ConnectorStatus = (typeof ConnectorStatus)[number];

export const Intent = ['looking_for_tool', 'competitor_complaint', 'recommendation', 'discussion'] as const;
export type Intent = (typeof Intent)[number];

export const LinkRule = ['one_per_comment', 'none', 'saturdays', 'allowed'] as const;
export type LinkRule = (typeof LinkRule)[number];

export const OpportunityLevel = ['high', 'medium', 'low'] as const;
export type OpportunityLevel = (typeof OpportunityLevel)[number];

export const OpportunityStatus = ['new', 'drafting', 'replied', 'skipped', 'watched'] as const;
export type OpportunityStatus = (typeof OpportunityStatus)[number];

export const DraftType = ['comment', 'post', 'dm'] as const;
export type DraftType = (typeof DraftType)[number];

export const DraftStatus = ['pending', 'approved', 'rejected', 'scheduled', 'posted', 'failed'] as const;
export type DraftStatus = (typeof DraftStatus)[number];

export const LeadStage = ['new', 'engaged', 'replied', 'interested', 'trial', 'customer', 'lost'] as const;
export type LeadStage = (typeof LeadStage)[number];

export const ConversationKind = ['comment_thread', 'dm'] as const;
export type ConversationKind = (typeof ConversationKind)[number];

export const MessageDirection = ['in', 'out'] as const;
export type MessageDirection = (typeof MessageDirection)[number];

export const LinkMedium = ['comment', 'dm', 'post'] as const;
export type LinkMedium = (typeof LinkMedium)[number];

export const SiteEventKind = ['pageview', 'signup', 'trial', 'payment'] as const;
export type SiteEventKind = (typeof SiteEventKind)[number];

export const AttributionModel = ['last_click'] as const;
export type AttributionModel = (typeof AttributionModel)[number];

export const ModStatus = ['ok', 'watch', 'banned', 'unknown'] as const;
export type ModStatus = (typeof ModStatus)[number];

// ── browser nodes (docs/plans/0001-infra-implementation.md §3.2) ──

export const BrowserNodeStatus = ['online', 'offline', 'draining'] as const;
export type BrowserNodeStatus = (typeof BrowserNodeStatus)[number];

/** Why a RedditAccount is paused. Mirrored in Prisma; any value means `post.publish` skips the account. */
export const PauseReason = [
  'needs_human',
  'license_denied',
  'node_offline',
  'proxy_failed',
  'manual',
] as const;
export type PauseReason = (typeof PauseReason)[number];

/** Outcome of one command on a browser node. Not stored as a column, so not mirrored in Prisma. */
export const BrowserOutcome = [
  'ok',
  'posted',
  'needs_human',
  'license_denied',
  'proxy_failed',
  'error',
] as const;
export type BrowserOutcome = (typeof BrowserOutcome)[number];

/** CloakBrowser persona; stored as text in `BrowserProfile.cloakPersona`. */
export const CloakPersona = ['windows', 'macos', 'linux'] as const;
export type CloakPersona = (typeof CloakPersona)[number];

/** CloakBrowser GPU family; stored as text in `BrowserProfile.cloakGpu`. */
export const CloakGpu = ['nvidia', 'intel', 'amd'] as const;
export type CloakGpu = (typeof CloakGpu)[number];

/** `Event.kind` in the gateway ↔ agent protocol. */
export const NodeEventKind = ['container.exited', 'session.activity', 'needs_human'] as const;
export type NodeEventKind = (typeof NodeEventKind)[number];

export const AuditAction = [
  'draft.created',
  'draft.requested',
  'draft.edited',
  'draft.regenerated',
  'draft.approved',
  'draft.scheduled',
  'draft.rejected',
  'draft.posted',
  'draft.failed',
  'opportunity.assigned',
  'opportunity.skipped',
  'opportunity.watched',
  'lead.created',
  'lead.stage_changed',
  'account.connected',
  'account.health_changed',
  'profile.proxy_updated',
  'session.started',
  'session.handed_back',
  'session.ended',
  'member.invited',
  'member.role_changed',
  'workspace.report_updated',
  'node.online',
  'node.offline',
  'profile.started',
  'profile.stopped',
  'profile.license_denied',
  'profile.fingerprint_assigned',
  'account.paused',
  'account.resumed',
  'account.connect_started',
  'profile.node_assigned',
] as const;
export type AuditAction = (typeof AuditAction)[number];

/** Display labels used across the UI. */
export const LEAD_STAGE_LABEL: Record<LeadStage, string> = {
  new: 'New',
  engaged: 'Engaged',
  replied: 'Replied',
  interested: 'Interested',
  trial: 'Trial / Demo',
  customer: 'Customer',
  lost: 'Lost',
};

export const INTENT_LABEL: Record<Intent, string> = {
  looking_for_tool: 'Looking for tool',
  competitor_complaint: 'Competitor complaint',
  recommendation: 'Asking recommendation',
  discussion: 'Discussion',
};

export const LINK_RULE_LABEL: Record<LinkRule, string> = {
  one_per_comment: '1 link allowed',
  none: 'No links in comments',
  saturdays: 'Self-promo Saturdays only',
  allowed: 'Links allowed',
};

export const ROLE_LABEL: Record<MemberRole, string> = {
  admin: 'Admin',
  approver: 'Approver',
  editor: 'Editor',
  viewer: 'Viewer',
};
