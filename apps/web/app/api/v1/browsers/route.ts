import { ApiError, api, body, browserJson, json } from '@/lib/api-v1';
import { browsers, members } from '@threadline/db';

export const dynamic = 'force-dynamic';

/** `GET /api/v1/browsers?q=&group=&tag=&status=&page=`: one page of the list, as the Browsers screen filters it. */
export const GET = api(async (me, req) => {
  const sp = new URL(req.url).searchParams;
  const r = await browsers.searchProfiles(me.workspaceId, {
    q: sp.get('q') ?? undefined,
    groupId: sp.get('group') ?? undefined,
    tagId: sp.get('tag') ?? undefined,
    status: sp.get('status') ?? undefined,
    page: Number.parseInt(sp.get('page') ?? '1', 10) || 1,
  });
  return json({ browsers: r.rows.map(browserJson), total: r.total, page: r.page, pages: r.pages });
});

/** `POST /api/v1/browsers`: `{ name, groupId?, proxyId?, startUrl?, notes? }`. The key's member must be an editor. */
export const POST = api(async (me, req) => {
  if (!members.roleAtLeast(me.role, 'editor'))
    throw new ApiError(403, 'forbidden', 'This key’s member cannot create browsers.');
  const b = await body(req);
  const str = (k: string) => (typeof b[k] === 'string' ? (b[k] as string).trim() : '');
  if (!str('name')) throw new ApiError(400, 'invalid', 'A browser needs a name.');
  const proxyId = str('proxyId') || null;
  if (proxyId && !(await browsers.listProxies(me.workspaceId)).some((x) => x.id === proxyId))
    throw new ApiError(400, 'invalid', 'That proxy is not in this workspace.');
  const made = await browsers.createBrowser({
    workspaceId: me.workspaceId,
    actorMemberId: me.id,
    name: str('name'),
    groupId: str('groupId') || null,
    proxyId,
    startUrl: str('startUrl') || null,
    notes: str('notes') || null,
  });
  const row = await browsers.getProfile(me.workspaceId, made.profileId);
  if (!row) throw new ApiError(500, 'error', 'The browser was created but could not be read back.');
  return json({ browser: browserJson(row) }, 201);
});
