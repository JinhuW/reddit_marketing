'use server';

import { ForbiddenError, requireRole } from '@/lib/session';
import { buildSystemPrompt } from '@threadline/agents';
import { agents } from '@threadline/db';
import { ConnectorProvider, ContextKind, SkillKey } from '@threadline/shared';
import { revalidatePath } from 'next/cache';
import { redirect } from 'next/navigation';
import { z } from 'zod';

export interface ActionState {
  ok?: boolean;
  error?: string;
  message?: string;
}

const fail = (e: unknown): ActionState => {
  if (e instanceof z.ZodError) return { error: e.issues[0]?.message ?? 'Invalid input.' };
  if (e instanceof ForbiddenError || e instanceof agents.PlanLimitError || e instanceof Error)
    return { error: e.message };
  return { error: 'Something went wrong.' };
};

const done = (agentId: string, message = 'Saved.'): ActionState => {
  revalidatePath('/agents');
  revalidatePath(`/agents/${agentId}`, 'layout');
  return { ok: true, message };
};

const str = (f: FormData, k: string) => String(f.get(k) ?? '').trim();
const list = (f: FormData, k: string) =>
  f
    .getAll(k)
    .map((v) => String(v).trim())
    .filter(Boolean);

const Slider = z.coerce.number().int().min(0).max(100);

const PersonaInput = z.object({
  agentId: z.string().min(1),
  name: z.string().min(1, 'Name is required.').max(40),
  roleTitle: z.string().min(1, 'Role is required.').max(80),
  focus: z.string().max(160),
  disclosure: z.string().max(200),
  voice: z.object({ formal: Slider, playful: Slider, concise: Slider, technical: Slider }),
  dos: z.array(z.string().max(200)).max(20),
  donts: z.array(z.string().max(200)).max(20),
  samples: z.array(z.string().max(2000)).max(10),
});

export async function savePersona(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const me = await requireRole('editor');
    const input = PersonaInput.parse({
      agentId: str(f, 'agentId'),
      name: str(f, 'name'),
      roleTitle: str(f, 'roleTitle'),
      focus: str(f, 'focus'),
      disclosure: str(f, 'disclosure'),
      voice: {
        formal: f.get('formal'),
        playful: f.get('playful'),
        concise: f.get('concise'),
        technical: f.get('technical'),
      },
      dos: list(f, 'dos'),
      donts: list(f, 'donts'),
      samples: list(f, 'samples'),
    });
    await agents.updatePersona(me.workspaceId, input.agentId, {
      name: input.name,
      roleTitle: input.roleTitle,
      persona: {
        focus: input.focus,
        disclosure: input.disclosure,
        voice: input.voice,
        dos: input.dos,
        donts: input.donts,
        samples: input.samples,
      },
    });
    return done(input.agentId, 'Persona saved.');
  } catch (e) {
    return fail(e);
  }
}

export async function saveSkill(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const me = await requireRole('editor');
    const input = z
      .object({
        agentId: z.string().min(1),
        key: z.enum(SkillKey),
        enabled: z.boolean(),
        promptOverride: z.string().max(4000),
      })
      .parse({
        agentId: str(f, 'agentId'),
        key: str(f, 'key'),
        enabled: f.get('enabled') === 'on',
        promptOverride: str(f, 'promptOverride'),
      });
    await agents.setSkill(
      me.workspaceId,
      input.agentId,
      input.key,
      input.enabled,
      input.promptOverride || null,
    );
    return done(input.agentId, 'Skill saved.');
  } catch (e) {
    return fail(e);
  }
}

export async function addContext(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const me = await requireRole('editor');
    const input = z
      .object({
        agentId: z.string().min(1),
        kind: z.enum(ContextKind),
        title: z.string().min(1, 'Give the item a title.').max(160),
        sourceUrl: z.union([z.literal(''), z.string().url('Enter a full URL, including https://')]),
        content: z.string().max(100_000),
      })
      .refine((v) => v.sourceUrl || v.content, { message: 'Add a URL or paste the text.' })
      .parse({
        agentId: str(f, 'agentId'),
        kind: str(f, 'kind'),
        title: str(f, 'title'),
        sourceUrl: str(f, 'sourceUrl'),
        content: str(f, 'content'),
      });
    // The context.embed queue fetches URLs and fills the embedding; nothing external is called here.
    await agents.addContext(me.workspaceId, input.agentId, {
      kind: input.kind,
      title: input.title,
      sourceUrl: input.sourceUrl || null,
      content: input.content,
    });
    return done(input.agentId, 'Added · embedding queued.');
  } catch (e) {
    return fail(e);
  }
}

export async function removeContext(f: FormData) {
  const me = await requireRole('editor');
  const agentId = str(f, 'agentId');
  await agents.deleteContext(me.workspaceId, agentId, str(f, 'itemId'));
  done(agentId);
}

export async function saveConnector(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const me = await requireRole('admin');
    const input = z
      .object({
        agentId: z.string().min(1),
        provider: z.enum(ConnectorProvider),
        connected: z.boolean(),
        tools: z.array(z.string().max(60)).max(30),
      })
      .parse({
        agentId: str(f, 'agentId'),
        provider: str(f, 'provider'),
        connected: f.get('connected') === 'on',
        tools: list(f, 'tools'),
      });
    await agents.setConnector(me.workspaceId, input.agentId, input.provider, input.connected, input.tools);
    return done(input.agentId, input.connected ? 'Connected.' : 'Disconnected.');
  } catch (e) {
    return fail(e);
  }
}

export async function saveAssignment(_: ActionState, f: FormData): Promise<ActionState> {
  try {
    const me = await requireRole('admin');
    const input = z
      .object({
        agentId: z.string().min(1),
        accountId: z.string(),
        approverMemberId: z.string(),
        dailyDraftLimit: z.coerce.number().int().min(1, 'Daily draft limit must be at least 1.').max(200),
        status: z.enum(['active', 'paused']),
        keywordGroupIds: z.array(z.string()),
      })
      .parse({
        agentId: str(f, 'agentId'),
        accountId: str(f, 'accountId'),
        approverMemberId: str(f, 'approverMemberId'),
        dailyDraftLimit: f.get('dailyDraftLimit'),
        status: str(f, 'status'),
        keywordGroupIds: list(f, 'keywordGroupIds'),
      });
    await agents.updateAssignment(me.workspaceId, input.agentId, {
      accountId: input.accountId || null,
      approverMemberId: input.approverMemberId || null,
      dailyDraftLimit: input.dailyDraftLimit,
      status: input.status,
      keywordGroupIds: input.keywordGroupIds,
    });
    return done(input.agentId, 'Assignment saved.');
  } catch (e) {
    return fail(e);
  }
}

export async function toggleStatus(f: FormData) {
  const me = await requireRole('admin');
  const agentId = str(f, 'agentId');
  await agents.setStatus(me.workspaceId, agentId, str(f, 'status') === 'active' ? 'active' : 'paused');
  done(agentId);
}

const COLORS = ['#6D5BD0', '#0F766E', '#475569', '#B45309', '#BE185D', '#1D4ED8'];

export async function createAgent(_: ActionState, f: FormData): Promise<ActionState> {
  let id: string;
  try {
    const me = await requireRole('admin');
    const input = z
      .object({
        name: z.string().min(1, 'Name is required.').max(40),
        roleTitle: z.string().min(1, 'Role is required.').max(80),
        focus: z.string().max(160),
      })
      .parse({ name: str(f, 'name'), roleTitle: str(f, 'roleTitle'), focus: str(f, 'focus') });
    const existing = await agents.listCards(me.workspaceId);
    const agent = await agents.create(me.workspaceId, {
      ...input,
      color: COLORS[existing.length % COLORS.length]!,
      approverMemberId: me.canApprove ? me.id : null,
    });
    id = agent.id;
  } catch (e) {
    return fail(e);
  }
  revalidatePath('/agents');
  redirect(`/agents/${id}/persona`);
}

export interface PlaygroundState {
  systemPrompt?: string;
  message?: string;
  error?: string;
}

/** "Test the agent": assembles the same system prompt the draft pipeline uses. Nothing is saved or posted. */
export async function runPlayground(_: PlaygroundState, f: FormData): Promise<PlaygroundState> {
  try {
    const me = await requireRole('viewer');
    const agentId = str(f, 'agentId');
    const post = str(f, 'post');
    if (!post) return { error: 'Paste a Reddit post to test against.' };
    const ctx = await agents.playgroundContext(me.workspaceId, agentId);
    if (!ctx) return { error: 'Agent not found.' };
    const settings = (ctx.agent.workspace.settings ?? {}) as { product?: string };
    const skill = ctx.agent.skills.find((s) => s.enabled)?.key ?? 'compare_answer';
    const systemPrompt = buildSystemPrompt({
      agentName: ctx.agent.name,
      roleTitle: ctx.agent.roleTitle,
      product: settings.product ?? ctx.agent.workspace.name,
      persona: ctx.persona,
      disclosureLine: ctx.agent.account?.disclosureLine ?? ctx.persona.disclosure ?? '',
      skill,
      subreddit: ctx.sub
        ? { name: ctx.sub.name, linkRule: ctx.sub.linkRule, rulesSummary: ctx.sub.selfPromoPolicy }
        : null,
    });
    const message = process.env.ANTHROPIC_API_KEY
      ? 'Model drafting runs in the worker’s draft.generate pipeline; the playground call ships with it. This is the exact prompt it will use.'
      : 'Add ANTHROPIC_API_KEY to run the playground. This is the system prompt the agent would use.';
    return { systemPrompt, message };
  } catch (e) {
    return { error: e instanceof Error ? e.message : 'Something went wrong.' };
  }
}
