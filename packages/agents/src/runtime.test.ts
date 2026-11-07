import type Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { runDraftAgent, scorePost } from './runtime';

/** Recorded-transcript style fake: returns queued responses and records requests. */
function fakeClient(responses: Partial<Anthropic.Message>[]) {
  const requests: Anthropic.MessageCreateParams[] = [];
  const c = {
    messages: {
      create: async (req: Anthropic.MessageCreateParams) => {
        requests.push(structuredClone(req));
        const r = responses.shift();
        if (!r) throw new Error('no more responses');
        return { usage: { input_tokens: 10, output_tokens: 5 }, stop_reason: 'tool_use', ...r };
      },
    },
  } as unknown as Anthropic;
  return { c, requests };
}

const tools = {
  search_context: async () => 'Guests are free.',
  get_thread: async () => 'Looking for a simple Asana alternative',
  get_subreddit_rules: async () => '1 link allowed',
  insert_tracked_link: async () => 'https://acme.so/r/pm6tea',
};

describe('runDraftAgent', () => {
  it('runs tools, returns all results in one user turn, and ends on write_draft', async () => {
    const { c, requests } = fakeClient([
      {
        content: [
          { type: 'tool_use', id: 't1', name: 'get_thread', input: {} },
          { type: 'tool_use', id: 't2', name: 'search_context', input: { query: 'guests' } },
        ] as Anthropic.ContentBlock[],
      },
      {
        content: [
          {
            type: 'tool_use',
            id: 't3',
            name: 'write_draft',
            input: { body: 'Guests are free. I work on Acme.', reasoning: 'fits' },
          },
        ] as Anthropic.ContentBlock[],
      },
    ]);
    const out = await runDraftAgent({
      anthropic: c,
      model: 'test',
      system: 's',
      userMessage: 'draft',
      tools,
    });
    expect(out.body).toBe('Guests are free. I work on Acme.');
    expect(out.run.toolCalls.map((t) => t.name)).toEqual(['get_thread', 'search_context', 'write_draft']);
    const second = requests[1]!.messages;
    const last = second[second.length - 1]!;
    expect(Array.isArray(last.content) && last.content.length).toBe(2);
    expect(requests[0]!.tool_choice).toEqual({ type: 'auto' });
  });

  it('reports a null tracked link to the model', async () => {
    const { c, requests } = fakeClient([
      {
        content: [
          {
            type: 'tool_use',
            id: 'a',
            name: 'insert_tracked_link',
            input: { destination: 'https://acme.so' },
          },
        ] as Anthropic.ContentBlock[],
      },
      {
        content: [
          { type: 'tool_use', id: 'b', name: 'write_draft', input: { body: 'x', reasoning: 'y' } },
        ] as Anthropic.ContentBlock[],
      },
    ]);
    await runDraftAgent({
      anthropic: c,
      model: 'test',
      system: 's',
      userMessage: 'u',
      tools: { ...tools, insert_tracked_link: async () => null },
    });
    expect(JSON.stringify(requests[1]!.messages)).toContain('does not allow a link today');
  });

  it('throws on refusal', async () => {
    const { c } = fakeClient([{ stop_reason: 'refusal', content: [] }]);
    await expect(
      runDraftAgent({ anthropic: c, model: 't', system: 's', userMessage: 'u', tools }),
    ).rejects.toThrow(/declined/);
  });
});

describe('scorePost', () => {
  it('parses a valid score', async () => {
    const { c } = fakeClient([
      {
        content: [
          {
            type: 'tool_use',
            id: 's',
            name: 'score_opportunity',
            input: {
              score: 94,
              level: 'high',
              intent: 'looking_for_tool',
              reason: 'r',
              competitors: ['Asana'],
            },
          },
        ] as Anthropic.ContentBlock[],
      },
    ]);
    expect((await scorePost({ anthropic: c, model: 't', prompt: 'p' }))?.score).toBe(94);
  });
  it('returns null for an invalid score', async () => {
    const { c } = fakeClient([
      {
        content: [
          { type: 'tool_use', id: 's', name: 'score_opportunity', input: { score: 400 } },
        ] as Anthropic.ContentBlock[],
      },
    ]);
    expect(await scorePost({ anthropic: c, model: 't', prompt: 'p' })).toBeNull();
  });
});
