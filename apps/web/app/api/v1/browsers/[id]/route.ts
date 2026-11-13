import { ApiError, api, browserJson, json } from '@/lib/api-v1';
import { browsers } from '@threadline/db';

export const dynamic = 'force-dynamic';

/** `GET /api/v1/browsers/:id` */
export const GET = api<{ params: Promise<{ id: string }> }>(async (me, _req, ctx) => {
  const { id } = await ctx.params;
  const row = await browsers.getProfile(me.workspaceId, id);
  if (!row) throw new ApiError(404, 'not_found', 'Browser not found.');
  return json({ browser: browserJson(row) });
});
