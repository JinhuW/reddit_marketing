'use server';

import { requireRole } from '@/lib/session';
import { analytics } from '@threadline/db';
import { LinkMedium, buildUtm, makeSlug, withUtm } from '@threadline/shared';
import { revalidatePath } from 'next/cache';
import { z } from 'zod';

export type CreateLinkState = { ok: boolean; error?: string; short?: string; at?: number };

const LinkForm = z.object({
  destination: z
    .string()
    .trim()
    .url('Enter a full URL, starting with https://')
    .refine((u) => /^https?:\/\//.test(u), 'Use an http(s) URL'),
  medium: z.enum(LinkMedium),
  subredditId: z
    .string()
    .optional()
    .transform((v) => v || null),
  subredditName: z.string().optional(),
  agentId: z
    .string()
    .optional()
    .transform((v) => v || null),
  agentName: z.string().optional(),
  label: z
    .string()
    .trim()
    .max(40)
    .regex(/^[a-z0-9-]*$/i, 'Label: letters, numbers and dashes only')
    .optional()
    .transform((v) => v || null),
});

/** UTM builder → TrackedLink. Editors and up. Slug = 6-char base62 (§6). */
export async function createTrackedLink(_prev: CreateLinkState, form: FormData): Promise<CreateLinkState> {
  try {
    const me = await requireRole('editor');
    const f = LinkForm.parse(Object.fromEntries(form));
    let slug = makeSlug();
    for (let i = 0; i < 5 && (await analytics.slugTaken(slug)); i++) slug = makeSlug();
    const utm = buildUtm({
      medium: f.medium,
      subreddit: f.subredditName || null,
      agent: f.agentName || null,
    });
    await analytics.createTrackedLink({
      workspaceId: me.workspaceId,
      destinationUrl: f.destination,
      medium: f.medium,
      subredditId: f.subredditId,
      agentId: f.agentId,
      label: f.label,
      slug,
      utm: { ...utm, ...(f.label ? { label: f.label } : {}), full: withUtm(f.destination, utm) },
    });
    revalidatePath('/analytics');
    return { ok: true, short: `/r/${slug}`, at: Date.now() };
  } catch (e) {
    if (e instanceof z.ZodError) return { ok: false, error: e.issues[0]?.message ?? 'Check the form' };
    return { ok: false, error: e instanceof Error ? e.message : 'Could not create the link' };
  }
}
