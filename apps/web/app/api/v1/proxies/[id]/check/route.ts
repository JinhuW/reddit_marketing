import { ApiError, api, json } from '@/lib/api-v1';
import { enqueueProxyJob } from '@/lib/browser-jobs';
import { browsers, members } from '@threadline/db';

export const dynamic = 'force-dynamic';

/** `POST /api/v1/proxies/:id/check`: queues a check on a browser node; read the result from `GET /proxies`. */
export const POST = api<{ params: Promise<{ id: string }> }>(async (me, _req, ctx) => {
  if (!members.roleAtLeast(me.role, 'editor'))
    throw new ApiError(403, 'forbidden', 'This key’s member cannot check proxies.');
  const { id } = await ctx.params;
  if (!(await browsers.listProxies(me.workspaceId)).some((x) => x.id === id))
    throw new ApiError(404, 'not_found', 'Proxy not found.');
  const r = await enqueueProxyJob(me.workspaceId, id, 'proxy.check');
  if (!r.queued) throw new ApiError(409, 'not_queued', r.reason);
  return json({ queued: true }, 202);
});
