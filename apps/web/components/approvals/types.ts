import type { RuleContext } from '@threadline/agents';
import type { DraftType, RuleCheck } from '@threadline/shared';

export interface DraftRow {
  id: string;
  type: DraftType;
  agent: string;
  agentColor: string;
  where: string;
  wait: string;
  waitHot: boolean;
  firstLine: string;
  account: string;
}

export interface ThreadContext {
  kind: 'thread' | 'new_post' | 'dm';
  meta: string;
  title?: string;
  excerpt?: string;
  note: string;
  messages?: { author: string; body: string; ago: string; inbound: boolean }[];
}

export interface DraftDetail {
  id: string;
  type: DraftType;
  typeLabel: string;
  agent: string;
  agentColor: string;
  createdAgo: string;
  body: string;
  title: string | null;
  reasoning: string;
  thread: ThreadContext;
  ruleContext: RuleContext;
  initialChecks: RuleCheck[];
  link: { short: string; full: string } | null;
  account: { username: string; roleLabel: string; ownerName: string; disclosureLine: string };
  approverName: string;
  editCount: number;
}
