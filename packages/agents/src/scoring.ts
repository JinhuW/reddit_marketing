import type { Intent, OpportunityLevel } from '@threadline/shared';

/** Posts scoring at or above this become Opportunities (docs/PLAN.md §5 step 2). */
export const OPPORTUNITY_THRESHOLD = 60;

export function levelForScore(score: number): OpportunityLevel {
  if (score >= 80) return 'high';
  if (score >= OPPORTUNITY_THRESHOLD) return 'medium';
  return 'low';
}

export const shouldCreateOpportunity = (score: number) => score >= OPPORTUNITY_THRESHOLD;

/** Anthropic tool definition for the scoring call. */
export const scoreOpportunityTool = {
  name: 'score_opportunity',
  description:
    'Score how likely this Reddit post is a buying conversation the product can genuinely help with. 0-100.',
  input_schema: {
    type: 'object',
    properties: {
      score: { type: 'integer', minimum: 0, maximum: 100 },
      level: { type: 'string', enum: ['high', 'medium', 'low'] },
      intent: {
        type: 'string',
        enum: ['looking_for_tool', 'competitor_complaint', 'recommendation', 'discussion'],
      },
      reason: { type: 'string', description: 'One sentence a human approver can scan.' },
      competitors: { type: 'array', items: { type: 'string' } },
    },
    required: ['score', 'level', 'intent', 'reason', 'competitors'],
  },
} as const;

export function scoringPrompt(input: {
  title: string;
  body: string;
  subreddit: string;
  groupIntent: Intent;
  competitors: string[];
  include: string[];
}) {
  return [
    `Subreddit: r/${input.subreddit}`,
    `Keyword group intent: ${input.groupIntent}`,
    `Tracked keywords: ${input.include.join(', ') || '—'}`,
    `Competitors to watch: ${input.competitors.join(', ') || '—'}`,
    '',
    `Title: ${input.title}`,
    '',
    input.body,
  ].join('\n');
}
