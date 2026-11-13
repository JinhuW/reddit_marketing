import { ApiError, api, json } from '@/lib/api-v1';
import { enqueueProfileJob } from '@/lib/browser-jobs';
import { browsers } from '@threadline/db';

export const dynamic = 'force-dynamic';

const JOBS = { start: 'profile.start', stop: 'profile.stop' } as const;

/**
 * `POST /api/v1/browsers/:id/start` and `/stop`. The key's member must be allowed to manage the browser (admin,
 * owner, creator, or a member with access to its group). Starting opens the browser on its node; nothing drives
 * it, and no debugging address is returned.
 */
export const POST = api<{ params: Promise<{ id: string; action: string }> }>(async (me, _req, ctx) => {
  const { id, action } = await ctx.params;
  const kind = JOBS[action as keyof typeof JOBS];
  if (!kind) throw new ApiError(404, 'not_found', 'Unknown action. Use start or stop.');
  const row = await browsers.getProfile(me.workspaceId, id);
  if (!row) throw new ApiError(404, 'not_found', 'Browser not found.');
  if (!browsers.canManageProfile(me, row))
    throw new ApiError(403, 'forbidden', 'This key’s member cannot manage that browser.');
  const r = await enqueueProfileJob(me.workspaceId, id, kind);
  if (!r.queued) throw new ApiError(409, 'not_queued', r.reason);
  return json({ queued: true, action }, 202);
});
