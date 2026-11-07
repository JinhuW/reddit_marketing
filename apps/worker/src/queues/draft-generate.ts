import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type Anthropic from '@anthropic-ai/sdk';
import { type Persona, buildSystemPrompt, linksAllowedToday } from '@threadline/agents';
import { client, runDraftAgent } from '@threadline/agents/runtime';
import { drafts } from '@threadline/db';
import { type DraftGenerateJob, LINK_RULE_LABEL, type SkillKey } from '@threadline/shared';
import type { Job } from 'bullmq';
import { log } from '../log';

/**
 * draft.generate (docs/PLAN.md §5 step 3): persona prompt + tools → write_draft → pending Draft with
 * rule checks. Nothing here posts; the draft waits in Approvals for a human.
 */
export async function generateDraft(job: DraftGenerateJob, anthropic: Anthropic = client()) {
  const ctx = await drafts.generationContext(job);
  const { agent, workspace, opportunity, conversation, existing } = ctx;
  if (!agent.account) throw new Error(`${agent.name} has no posting account`);
  if (agent.status !== 'active' && !job.draftId) throw new Error(`${agent.name} is paused`);

  const settings = workspace.settings as { product?: string; siteUrl?: string; timeZone?: string };
  const sub = opportunity?.post.subreddit ?? conversation?.post?.subreddit ?? existing?.subreddit ?? null;
  const type = job.type;
  const skill: SkillKey =
    type === 'dm' ? 'demo_followup' : type === 'post' ? 'launch_post' : 'compare_answer';
  const now = new Date();

  const system = buildSystemPrompt({
    agentName: agent.name,
    roleTitle: agent.roleTitle,
    product: settings.product ?? workspace.name,
    persona: agent.persona as Persona,
    disclosureLine: agent.account.disclosureLine,
    skill,
    subreddit: sub ? { name: sub.name, linkRule: sub.linkRule, rulesSummary: sub.selfPromoPolicy } : null,
  });

  const thread = opportunity
    ? `r/${opportunity.post.subreddit.name} · u/${opportunity.post.authorUsername}\n${opportunity.post.title}\n\n${opportunity.post.body}\n\nTop comments:\n${JSON.stringify(opportunity.post.topComments)}`
    : conversation
      ? conversation.messages
          .map((m) => `${m.direction === 'in' ? `u/${m.author}` : `us (u/${m.author})`}: ${m.body}`)
          .join('\n')
      : '';

  let trackedLinkId: string | null = null;
  const site = settings.siteUrl ? new URL(settings.siteUrl).host : null;
  const trackingHost = process.env.TRACKING_HOST ?? process.env.APP_URL ?? 'http://localhost:3000';

  const result = await runDraftAgent({
    anthropic,
    system,
    userMessage: [
      type === 'post' ? `Write a new post for r/${sub?.name ?? '?'}.` : 'Draft a reply to this thread.',
      existing?.regenerateInstruction
        ? `Revise the previous draft. Instruction from the approver: ${existing.regenerateInstruction}`
        : '',
      existing ? `Previous draft:\n${existing.body}` : '',
      job.instruction ? `Note from the team: ${job.instruction}` : '',
      thread ? `Thread:\n${thread}` : '',
    ]
      .filter(Boolean)
      .join('\n\n'),
    tools: {
      search_context: async ({ query }) => JSON.stringify(await drafts.searchContext(agent.id, query)),
      get_thread: async () => thread || 'No thread (new post).',
      get_subreddit_rules: async () =>
        sub
          ? `r/${sub.name}: ${LINK_RULE_LABEL[sub.linkRule]}. ${sub.selfPromoPolicy ?? ''} ${sub.notes ?? ''}`.trim()
          : 'Direct message: subreddit rules do not apply.',
      insert_tracked_link: async ({ destination }) => {
        const allowed = type === 'dm' || !sub || linksAllowedToday(sub.linkRule, now, settings.timeZone) > 0;
        if (!allowed) return null;
        const url = new URL(destination, settings.siteUrl ?? undefined);
        if (site && url.host !== site) throw new Error(`Links must point to ${site}`);
        const link = await drafts.mintTrackedLink({
          workspaceId: workspace.id,
          destinationUrl: url.toString(),
          medium: type,
          subredditId: sub?.id,
          subredditName: sub?.name,
          postId: opportunity?.postId,
          postRedditId: opportunity?.post.redditId,
          agentId: agent.id,
          agentName: agent.name,
        });
        trackedLinkId = link.id;
        return `${trackingHost.replace(/\/$/, '')}/r/${link.slug}`;
      },
    },
  });

  const draftId = await drafts.saveGenerated({
    workspaceId: workspace.id,
    agentId: agent.id,
    accountId: agent.account.id,
    agentName: agent.name,
    type,
    body: result.body,
    reasoning: result.reasoning,
    draftId: job.draftId,
    opportunityId: opportunity?.id,
    conversationId: conversation?.id,
    subredditId: sub?.id,
    trackedLinkId,
  });

  // AgentRun log for the Performance tab (local storage in v1).
  const dir = join(process.cwd(), '..', '..', 'data', 'runs');
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${draftId}-${Date.now()}.json`),
    JSON.stringify({ draftId, agentId: agent.id, ...result.run }, null, 2),
  );
  log.info({ draftId, agent: agent.name, ms: result.run.latencyMs }, 'draft generated');
  return { draftId };
}

export async function draftGenerate(job: Job<DraftGenerateJob>) {
  return generateDraft(job.data);
}
