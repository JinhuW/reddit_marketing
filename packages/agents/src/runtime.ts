/**
 * Agent runtime: the drafting tool loop and the scoring call (docs/PLAN.md §5 steps 2-3, §6).
 * Tool executors are injected so the worker, the playground (dryRun) and tests share one loop.
 * Model ids come from env (LLM_MODEL_DRAFT / LLM_MODEL_FAST).
 *
 * Tool choice is always `auto` with strict schemas plus an explicit instruction to call the tool:
 * forced tool_choice is rejected by newer models, and this keeps the model ids swappable.
 */
import Anthropic from '@anthropic-ai/sdk';
import { ScoreResult } from '@threadline/shared';
import { draftingTools } from './prompt';
import { scoreOpportunityTool } from './scoring';

export interface DraftToolExecutors {
  search_context(input: { query: string }): Promise<string>;
  get_thread(): Promise<string>;
  get_subreddit_rules(): Promise<string>;
  /** returns null when the link rule does not allow a link today */
  insert_tracked_link(input: { destination: string }): Promise<string | null>;
}

export interface AgentRunLog {
  model: string;
  startedAt: string;
  latencyMs: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: { name: string; input: unknown; output: string; ms: number }[];
  stopReason: string | null;
  error?: string;
}

export class AgentRunError extends Error {
  constructor(
    message: string,
    readonly run: AgentRunLog,
  ) {
    super(message);
    this.name = 'AgentRunError';
  }
}

const strict = <T extends { input_schema: object }>(t: T): Anthropic.Tool =>
  ({
    ...t,
    strict: true,
    input_schema: { ...t.input_schema, additionalProperties: false },
  }) as unknown as Anthropic.Tool;

export function client(apiKey = process.env.ANTHROPIC_API_KEY) {
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is not set');
  return new Anthropic({ apiKey });
}

/** Runs the drafting loop until the model calls write_draft (max `maxTurns` model turns). */
export async function runDraftAgent(opts: {
  anthropic: Anthropic;
  model?: string;
  system: string;
  userMessage: string;
  tools: DraftToolExecutors;
  maxTurns?: number;
}): Promise<{ body: string; reasoning: string; run: AgentRunLog }> {
  const model = opts.model ?? process.env.LLM_MODEL_DRAFT ?? 'claude-sonnet-4-5';
  const t0 = Date.now();
  const run: AgentRunLog = {
    model,
    startedAt: new Date(t0).toISOString(),
    latencyMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    toolCalls: [],
    stopReason: null,
  };
  const messages: Anthropic.MessageParam[] = [
    {
      role: 'user',
      content: `${opts.userMessage}\n\nWhen the reply is ready, call write_draft. Do not answer in plain text.`,
    },
  ];
  const tools = draftingTools.map(strict);

  for (let turn = 0; turn < (opts.maxTurns ?? 8); turn++) {
    const res = await opts.anthropic.messages.create({
      model,
      max_tokens: 4096,
      system: opts.system,
      tools,
      tool_choice: { type: 'auto' },
      messages,
    });
    run.inputTokens += res.usage.input_tokens;
    run.outputTokens += res.usage.output_tokens;
    run.stopReason = res.stop_reason;
    if (res.stop_reason === 'refusal') throw new AgentRunError('model declined to draft this reply', run);

    messages.push({ role: 'assistant', content: res.content });
    const uses = res.content.filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use');
    if (!uses.length) {
      messages.push({ role: 'user', content: 'Call write_draft with the reply and your reasoning.' });
      continue;
    }

    const results: Anthropic.ToolResultBlockParam[] = [];
    for (const u of uses) {
      const started = Date.now();
      const input = u.input as Record<string, string>;
      if (u.name === 'write_draft') {
        if (typeof input.body !== 'string' || !input.body.trim()) {
          results.push({
            type: 'tool_result',
            tool_use_id: u.id,
            is_error: true,
            content: 'body is required',
          });
          continue;
        }
        run.latencyMs = Date.now() - t0;
        run.toolCalls.push({ name: u.name, input, output: 'ok', ms: 0 });
        return { body: input.body.trim(), reasoning: (input.reasoning ?? '').trim(), run };
      }
      let output: string;
      let isError = false;
      try {
        switch (u.name) {
          case 'search_context':
            output = await opts.tools.search_context({ query: String(input.query ?? '') });
            break;
          case 'get_thread':
            output = await opts.tools.get_thread();
            break;
          case 'get_subreddit_rules':
            output = await opts.tools.get_subreddit_rules();
            break;
          case 'insert_tracked_link':
            output =
              (await opts.tools.insert_tracked_link({ destination: String(input.destination ?? '') })) ??
              'null — this subreddit does not allow a link today. Write the reply without a link.';
            break;
          default:
            output = `unknown tool ${u.name}`;
            isError = true;
        }
      } catch (e) {
        output = e instanceof Error ? e.message : String(e);
        isError = true;
      }
      run.toolCalls.push({ name: u.name, input, output, ms: Date.now() - started });
      results.push({
        type: 'tool_result',
        tool_use_id: u.id,
        content: output,
        ...(isError ? { is_error: true } : {}),
      });
    }
    // all results for this turn go back in one user message
    messages.push({ role: 'user', content: results });
  }
  run.latencyMs = Date.now() - t0;
  throw new AgentRunError('agent did not call write_draft', run);
}

/** One scoring call. Returns null when the model does not return a valid score. */
export async function scorePost(opts: {
  anthropic: Anthropic;
  model?: string;
  prompt: string;
}): Promise<ScoreResult | null> {
  const model = opts.model ?? process.env.LLM_MODEL_DRAFT ?? 'claude-sonnet-4-5';
  const res = await opts.anthropic.messages.create({
    model,
    max_tokens: 1024,
    system:
      'You score Reddit posts for a B2B SaaS team. A high score means the poster is actively looking for a tool the product could genuinely help with. Always answer by calling score_opportunity exactly once.',
    tools: [strict(scoreOpportunityTool)],
    tool_choice: { type: 'auto' },
    messages: [{ role: 'user', content: opts.prompt }],
  });
  if (res.stop_reason === 'refusal') return null;
  const use = res.content.find(
    (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use' && b.name === 'score_opportunity',
  );
  if (!use) return null;
  const parsed = ScoreResult.safeParse(use.input);
  return parsed.success ? parsed.data : null;
}
