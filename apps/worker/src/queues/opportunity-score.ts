import { levelForScore, scorePost, scoringPrompt, shouldCreateOpportunity } from '@threadline/agents';
import { client } from '@threadline/agents/runtime';
import { audit, prisma } from '@threadline/db';
import type { Job } from 'bullmq';
import { log } from '../log';

/** opportunity.score — Claude scores the post; ≥ 60 creates an Opportunity (docs/PLAN.md §5 step 2). */
export async function opportunityScore(
  job: Job<{ postId: string; keywordGroupId: string; matched?: string }>,
) {
  const post = await prisma.post.findUnique({
    where: { id: job.data.postId },
    include: { subreddit: true, opportunity: true },
  });
  const group = await prisma.keywordGroup.findUnique({ where: { id: job.data.keywordGroupId } });
  if (!post || !group || post.opportunity) return { skipped: true };

  const result = await scorePost({
    anthropic: client(),
    model: process.env.LLM_MODEL_DRAFT,
    prompt: scoringPrompt({
      title: post.title,
      body: post.body,
      subreddit: post.subreddit.name,
      groupIntent: group.intent,
      competitors: group.competitor,
      include: group.include,
    }),
  });
  if (!result) throw new Error('scoring returned no valid result');
  if (!shouldCreateOpportunity(result.score)) return { score: result.score, created: false };

  const opp = await prisma.opportunity.create({
    data: {
      workspaceId: post.workspaceId,
      postId: post.id,
      keywordGroupId: group.id,
      score: result.score,
      level: levelForScore(result.score),
      intent: result.intent,
      reason: result.reason,
      competitorMentions: result.competitors,
      matchedKeyword: job.data.matched ?? null,
      suggestedAgentId: group.agentId,
    },
  });
  await audit.writeAudit({
    workspaceId: post.workspaceId,
    actorMemberId: null,
    action: 'opportunity.assigned',
    targetType: 'Opportunity',
    targetId: opp.id,
    meta: { score: result.score, agentId: group.agentId, item: post.title },
  });
  await sendAlert(group.alert as { channel?: string; cadence?: string }, opp.score, post.title, post.url);
  log.info({ postId: post.id, score: result.score }, 'opportunity created');
  return { score: result.score, created: true };
}

/** Slack incoming webhook for instant alerts on high-intent opportunities. Email digests ship with M5's mailer. */
async function sendAlert(
  alert: { channel?: string; cadence?: string },
  score: number,
  title: string,
  url: string,
) {
  if (alert.channel !== 'slack' || alert.cadence !== 'instant' || score < 80) return;
  const hook = process.env.SLACK_WEBHOOK_URL;
  if (!hook) return;
  await fetch(hook, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text: `New high-intent thread (${score}): <${url}|${title}>` }),
  }).catch((e) => log.warn({ err: String(e) }, 'slack alert failed'));
}
