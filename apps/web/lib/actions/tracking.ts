'use server';

import { requireRole } from '@/lib/session';
import { tracking } from '@threadline/db';
import { Intent, LinkRule, ModStatus } from '@threadline/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

export type ActionState = { ok: boolean; error?: string; at?: number };

const list = z
  .string()
  .default('')
  .transform((s) =>
    [
      ...new Set(
        s
          .split(/[,\n]/)
          .map((t) => t.trim())
          .filter(Boolean),
      ),
    ].slice(0, 50),
  );

const GroupForm = z.object({
  id: z.string().optional(),
  name: z.string().trim().min(2, 'Name is required').max(80),
  intent: z.enum(Intent),
  include: list.refine((l) => l.length > 0, 'Add at least one include term'),
  exclude: list,
  competitor: list,
  subreddits: list.transform((l) => l.map((s) => tracking.normalizeSubName(s))),
  alertChannel: z.enum(['slack', 'email', 'none']),
  alertTarget: z.string().trim().max(120).optional(),
  alertCadence: z.enum(['instant', 'hourly', 'daily']),
  agentId: z
    .string()
    .optional()
    .transform((v) => v || null),
});

const fail = (e: unknown): ActionState => {
  if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? 'Check the form' };
  return { ok: false, error: e instanceof Error ? e.message : 'Something went wrong' };
};

export async function saveKeywordGroup(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const me = await requireRole('editor');
    const f = GroupForm.parse(Object.fromEntries(form));
    const input: tracking.KeywordGroupInput = {
      name: f.name,
      intent: f.intent,
      include: f.include,
      exclude: f.exclude,
      competitor: f.competitor,
      subreddits: f.subreddits,
      agentId: f.agentId,
      alert:
        f.alertChannel === 'none'
          ? { channel: 'none', cadence: 'off' }
          : { channel: f.alertChannel, target: f.alertTarget || undefined, cadence: f.alertCadence },
    };
    if (f.id) await tracking.updateKeywordGroup(me.workspaceId, f.id, input);
    else await tracking.createKeywordGroup(me.workspaceId, input);
    revalidatePath('/tracking');
    return { ok: true, at: Date.now() };
  } catch (e) {
    return fail(e);
  }
}

export async function deleteKeywordGroup(form: FormData) {
  const me = await requireRole('editor');
  await tracking.deleteKeywordGroup(me.workspaceId, z.string().min(1).parse(form.get('id')));
  revalidatePath('/tracking');
}

const SubForm = z.object({
  id: z.string().optional(),
  name: z
    .string()
    .trim()
    .transform((n) => tracking.normalizeSubName(n))
    .pipe(z.string().regex(/^[A-Za-z0-9_]{2,21}$/, 'Enter a subreddit name like r/projectmanagement')),
  selfPromoPolicy: z
    .string()
    .trim()
    .max(120)
    .optional()
    .transform((v) => v || null),
  linkRule: z.enum(LinkRule),
  modStatus: z.enum(ModStatus).default('unknown'),
  notes: z
    .string()
    .trim()
    .max(500)
    .optional()
    .transform((v) => v || null),
});

export async function saveSubreddit(_prev: ActionState, form: FormData): Promise<ActionState> {
  try {
    const me = await requireRole('editor');
    const f = SubForm.parse(Object.fromEntries(form));
    if (f.id) {
      const { id, name: _n, ...rest } = f;
      await tracking.updateSubreddit(me.workspaceId, id, rest);
    } else {
      const { id: _i, ...rest } = f;
      await tracking.addSubreddit(me.workspaceId, rest);
    }
    revalidatePath('/tracking');
    return { ok: true, at: Date.now() };
  } catch (e) {
    if (e instanceof Error && 'code' in e && (e as { code?: string }).code === 'P2002')
      return { ok: false, error: 'That subreddit is already on the watchlist' };
    return fail(e);
  }
}
