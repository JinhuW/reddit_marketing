import type { LinkRule, SkillKey } from '@threadline/shared';
import { LINK_RULE_LABEL } from '@threadline/shared';

export interface Persona {
  voice?: { formal?: number; playful?: number; concise?: number; technical?: number };
  dos?: string[];
  donts?: string[];
  disclosure?: string;
  samples?: string[];
}

const SKILL_TEMPLATES: Record<SkillKey, string> = {
  compare_answer:
    'Answer the question directly first. If you compare tools, be fair about where competitors are better. Mention our product once, with the disclosure.',
  launch_post:
    'Write a launch post that leads with the problem and what was learned building it. No hype words. End with a genuine question to the community.',
  demo_followup:
    'This person engaged with us first. Follow up briefly, answer what they asked, and offer a demo only if they asked about evaluation.',
  thread_to_blog: 'Summarise the thread into an outline for a blog post. Do not quote usernames.',
};

/** Voice slider (0-100) → a prose instruction. */
function voiceLine(name: string, v: number | undefined, low: string, high: string) {
  if (v === undefined) return null;
  if (v >= 67) return `- ${high}.`;
  if (v <= 33) return `- ${low}.`;
  return `- Balance between ${low.toLowerCase()} and ${high.toLowerCase()} (${name}).`;
}

export function buildSystemPrompt(input: {
  agentName: string;
  roleTitle: string;
  product: string;
  persona: Persona;
  disclosureLine: string;
  skill: SkillKey;
  subreddit?: { name: string; linkRule: LinkRule; rulesSummary?: string | null } | null;
}): string {
  const { persona } = input;
  const voice = [
    voiceLine(
      'formality',
      persona.voice?.formal,
      'Casual, like a peer on Reddit',
      'Professional and precise',
    ),
    voiceLine('playfulness', persona.voice?.playful, 'Plain and earnest', 'Light humour is fine'),
    voiceLine('length', persona.voice?.concise, 'Thorough, with specifics', 'Short: three to five sentences'),
    voiceLine('depth', persona.voice?.technical, 'Non-technical language', 'Technical detail welcome'),
  ].filter(Boolean);

  return [
    `You are ${input.agentName}, ${input.roleTitle} for ${input.product}. You draft Reddit replies that a human reviews before anything is posted.`,
    '',
    'Hard rules:',
    `- Always include this disclosure, verbatim: "${input.disclosureLine}".`,
    '- Be genuinely helpful even if the reader never uses our product.',
    '- Never invent facts, prices, customers or metrics. Use search_context for product facts.',
    '- Never attack competitors or make price claims about them unless the context has a dated source.',
    input.subreddit
      ? `- r/${input.subreddit.name} link rule: ${LINK_RULE_LABEL[input.subreddit.linkRule]}. Only use insert_tracked_link if it returns a link.`
      : null,
    input.subreddit?.rulesSummary ? `- Subreddit rules: ${input.subreddit.rulesSummary}` : null,
    '',
    'Voice:',
    ...voice,
    ...(persona.dos?.length ? ['', 'Do:', ...persona.dos.map((d) => `- ${d}`)] : []),
    ...(persona.donts?.length ? ['', "Don't:", ...persona.donts.map((d) => `- ${d}`)] : []),
    '',
    `Task: ${SKILL_TEMPLATES[input.skill]}`,
    ...(persona.samples?.length
      ? ['', 'Replies the team approved before (match their tone):', ...persona.samples.map((s) => `> ${s}`)]
      : []),
    '',
    'Finish by calling write_draft(body, reasoning). The reasoning is shown to the approver: say why this reply fits the thread.',
  ]
    .filter((l) => l !== null)
    .join('\n');
}

/** Tool definitions exposed to the drafting model (docs/PLAN.md §6). */
export const draftingTools = [
  {
    name: 'search_context',
    description: 'Search the agent knowledge base (docs, FAQ, pricing, approved replies).',
    input_schema: { type: 'object', properties: { query: { type: 'string' } }, required: ['query'] },
  },
  {
    name: 'get_thread',
    description: 'Get the post and its top comments.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'get_subreddit_rules',
    description: 'Get the subreddit rules summary and link rule.',
    input_schema: { type: 'object', properties: {} },
  },
  {
    name: 'insert_tracked_link',
    description:
      'Get a tracked short link for a destination on our site. Returns null when the subreddit does not allow a link today.',
    input_schema: {
      type: 'object',
      properties: { destination: { type: 'string' } },
      required: ['destination'],
    },
  },
  {
    name: 'write_draft',
    description: 'Submit the final draft for human approval.',
    input_schema: {
      type: 'object',
      properties: { body: { type: 'string' }, reasoning: { type: 'string' } },
      required: ['body', 'reasoning'],
    },
  },
] as const;
