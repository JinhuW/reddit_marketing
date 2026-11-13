import { api, json } from '@/lib/api-v1';
import { browsers } from '@threadline/db';

export const dynamic = 'force-dynamic';

/** `GET /api/v1/groups` */
export const GET = api(async (me) => {
  const groups = await browsers.listGroups(me.workspaceId);
  return json({ groups: groups.map((g) => ({ id: g.id, name: g.name, browsers: g.profileCount })) });
});
