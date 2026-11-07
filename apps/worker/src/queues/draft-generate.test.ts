/** Integration: draft.generate against the seeded DB with a recorded-style fake Claude client. */
import type Anthropic from '@anthropic-ai/sdk';
import { canApprove } from '@threadline/agents';
import { prisma } from '@threadline/db';
import type { RuleCheck } from '@threadline/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { generateDraft } from './draft-generate';

const cleanup = {
  drafts: [] as string[],
  links: [] as string[],
  opp: null as null | { id: string; status: string },
};

function fakeClaude(script: Array<(req: Anthropic.MessageCreateParams) => Anthropic.ContentBlock[]>) {
  return {
    messages: {
      create: async (req: Anthropic.MessageCreateParams) => ({
        content: script.shift()!(req),
        stop_reason: 'tool_use',
        usage: { input_tokens: 100, output_tokens: 50 },
      }),
    },
  } as unknown as Anthropic;
}

afterAll(async () => {
  await prisma.draft.deleteMany({ where: { id: { in: cleanup.drafts } } });
  await prisma.trackedLink.deleteMany({ where: { id: { in: cleanup.links } } });
  if (cleanup.opp)
    await prisma.opportunity.update({
      where: { id: cleanup.opp.id },
      data: { status: cleanup.opp.status as never },
    });
  await prisma.$disconnect();
});

describe('draft.generate', () => {
  it('turns an opportunity into a pending draft with a tracked link and rule checks', async () => {
    const opp = await prisma.opportunity.findFirstOrThrow({
      where: { post: { redditId: 't3_1h8k2q' } },
      include: { suggestedAgent: true },
    });
    cleanup.opp = { id: opp.id, status: opp.status };
    let linkText = '';
    const claude = fakeClaude([
      () =>
        [
          { type: 'tool_use', id: 'a', name: 'get_thread', input: {} },
          {
            type: 'tool_use',
            id: 'b',
            name: 'insert_tracked_link',
            input: { destination: '/compare/asana' },
          },
        ] as Anthropic.ContentBlock[],
      (req) => {
        const results = JSON.stringify(req.messages.at(-1)?.content);
        linkText = /(http[^"\\]+\/r\/[A-Za-z0-9]{6})/.exec(results)?.[1] ?? '';
        return [
          {
            type: 'tool_use',
            id: 'c',
            name: 'write_draft',
            input: {
              body: `Small teams usually want boards, due dates and free guests. Disclosure: I work on Acme. Comparison: ${linkText}`,
              reasoning: 'Answered the three needs first, disclosed, one link allowed.',
            },
          },
        ] as Anthropic.ContentBlock[];
      },
    ]);

    const { draftId } = await generateDraft(
      {
        workspaceId: opp.workspaceId,
        opportunityId: opp.id,
        agentId: opp.suggestedAgentId!,
        type: 'comment',
        requestedByMemberId: 'test',
      },
      claude,
    );
    cleanup.drafts.push(draftId);
    const d = await prisma.draft.findUniqueOrThrow({ where: { id: draftId } });
    if (d.trackedLinkId) cleanup.links.push(d.trackedLinkId);

    expect(d.status).toBe('pending');
    expect(linkText).toMatch(/\/r\/[A-Za-z0-9]{6}$/);
    expect(d.trackedLinkId).not.toBeNull();
    const checks = d.ruleChecks as unknown as RuleCheck[];
    expect(checks.find((c) => c.key === 'disclosure')?.passed).toBe(true);
    expect(checks.find((c) => c.key === 'link_rule')?.passed).toBe(true);
    expect(canApprove(checks)).toBe(true);
    expect((await prisma.opportunity.findUniqueOrThrow({ where: { id: opp.id } })).status).toBe('drafting');
  });
});
