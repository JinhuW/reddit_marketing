import { getCurrentMember } from '@/lib/session';
import { VNC_AUTHZ_HEADER, type VncGrant, authorizeKeyMatches } from '@/vnc-authz';
import { browsers } from '@threadline/db';

export const dynamic = 'force-dynamic';

const json = (body: unknown, status = 200) =>
  Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

type Params = { params: Promise<{ profileId: string }> };

/** Session → member → profile → Admin, account owner, or (no account) the creator. Shared by GET and the upgrade POST. */
async function controllableProfile(params: Params['params']) {
  const me = await getCurrentMember();
  if (!me) return { ok: false, res: json({ error: 'unauthorized' }, 401) } as const;
  const { profileId } = await params;
  const profile = await browsers.getProfile(me.workspaceId, profileId);
  if (!profile) return { ok: false, res: json({ error: 'not found' }, 404) } as const;
  if (!browsers.canControlProfile(me, profile))
    return { ok: false, res: json({ error: 'forbidden' }, 403) } as const;
  return { ok: true, me, profile } as const;
}

/**
 * Authenticated entry to a browser profile's VNC display (docs/PLAN.md §6, §10 Security; infra plan T23).
 * Only an Admin or the account's owner may connect. Browser containers expose no host ports; the websocket on
 * this path (handled by server.ts → vnc-proxy.ts, since route handlers cannot upgrade) is the only path from a
 * person to a container, through the node gateway.
 *
 * GET answers with status only: whether the remote view can be opened right now.
 */
export async function GET(_req: Request, { params }: Params): Promise<Response> {
  const r = await controllableProfile(params);
  if (!r.ok) return r.res;
  const { me, profile } = r;
  if (!process.env.NODE_GATEWAY_URL || !process.env.GATEWAY_INTERNAL_SECRET)
    return json({ status: 'unavailable', error: 'browser nodes are not configured' }, 503);
  if (!profile.nodeId) return json({ status: 'no_node', error: 'profile has no browser node' }, 503);
  const open = profile.sessions[0] ?? null;
  return json({
    status: 'ready',
    profileStatus: profile.status,
    websocket: `/api/vnc/${profile.id}`,
    session: open
      ? {
          id: open.id,
          driver: open.driver,
          mine: open.driver === 'human' && open.startedByMemberId === me.id,
        }
      : null,
  });
}

/**
 * Upgrade authorization, called only by server.ts with the upgrade's cookies (see vnc-authz.ts).
 * Reuses the caller's open human session, or starts one (`startHumanSession` writes `session.started` and pauses
 * the agent). Someone else holding control → 409.
 */
export async function POST(req: Request, { params }: Params): Promise<Response> {
  if (!authorizeKeyMatches(req.headers.get(VNC_AUTHZ_HEADER))) return json({ error: 'not found' }, 404);
  const r = await controllableProfile(params);
  if (!r.ok) return r.res;
  const { me, profile } = r;
  const grant = (sessionId: string): VncGrant => ({
    workspaceId: me.workspaceId,
    profileId: profile.id,
    memberId: me.id,
    sessionId,
  });

  const open = profile.sessions[0] ?? null;
  if (open?.driver === 'human') {
    if (open.startedByMemberId === me.id) return json(grant(open.id));
    return json({ error: 'someone else has control of this browser' }, 409);
  }
  try {
    const s = await browsers.startHumanSession({
      workspaceId: me.workspaceId,
      profileId: profile.id,
      memberId: me.id,
      memberName: me.user.name ?? me.user.email,
      reason: 'Opened the remote view',
    });
    return json(grant(s.id));
  } catch (e) {
    if (e instanceof browsers.SessionConflictError) return json({ error: e.message }, 409);
    throw e;
  }
}
