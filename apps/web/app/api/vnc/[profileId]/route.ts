import { getCurrentMember } from '@/lib/session';
import { browsers } from '@threadline/db';

export const dynamic = 'force-dynamic';

/**
 * Authenticated entry to a browser profile's VNC display (docs/PLAN.md §6, §10 Security).
 * Only an Admin or the account's owner may connect. Browser containers expose no host ports;
 * this route is the only path from a person to a container.
 *
 * M6: the worker's browser/manager.ts reports the running container's internal address
 * (BROWSER_NETWORK, websockify on VNC_PORT=6080). This handler then upgrades the request to a
 * websocket and pipes frames both ways to ws://<container>:6080/websockify (a custom Node server
 * or a sidecar handles the upgrade, since route handlers cannot). Until then it answers 503.
 */
export async function GET(_req: Request, { params }: { params: Promise<{ profileId: string }> }) {
  const me = await getCurrentMember();
  if (!me) return Response.json({ error: 'unauthorized' }, { status: 401 });
  const { profileId } = await params;
  const profile = await browsers.getProfile(me.workspaceId, profileId);
  if (!profile) return Response.json({ error: 'not found' }, { status: 404 });
  if (!browsers.canControlProfile(me, profile)) return Response.json({ error: 'forbidden' }, { status: 403 });
  return Response.json({ error: 'browser profile not running' }, { status: 503 });
}
