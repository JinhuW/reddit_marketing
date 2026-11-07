import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// The route's `@/…` imports, mapped by hand (Vitest has no tsconfig paths here).
const session = vi.hoisted(() => ({ getCurrentMember: vi.fn() }));
vi.mock('@/lib/session', () => session);
vi.mock('@/vnc-authz', () => import('../../../../vnc-authz'));

class SessionConflictError extends Error {}
const db = vi.hoisted(() => ({
  getProfile: vi.fn(),
  startHumanSession: vi.fn(),
}));
vi.mock('@threadline/db', () => ({
  browsers: {
    getProfile: db.getProfile,
    startHumanSession: db.startHumanSession,
    // the real rule (packages/db/src/repos/browsers.ts)
    canControlProfile: (me: { id: string; role: string }, p: { account: { ownerMemberId: string } }) =>
      me.role === 'admin' || p.account.ownerMemberId === me.id,
    SessionConflictError,
  },
}));

const { GET, POST } = await import('./route');
const { VNC_AUTHZ_ENV, VNC_AUTHZ_HEADER } = await import('../../../../vnc-authz');

const KEY = 'a'.repeat(64);
// process.env coerces `= undefined` to the string "undefined", so remove the key instead.
const unset = (k: string) => Reflect.deleteProperty(process.env, k);
const member = (id: string, role: string) => ({
  id,
  role,
  workspaceId: 'ws_1',
  user: { name: `${id} name`, email: `${id}@example.com` },
});
const profile = (sessions: unknown[] = []) => ({
  id: 'prof_1',
  nodeId: 'node_1',
  status: 'idle',
  account: { ownerMemberId: 'mem_owner' },
  sessions,
});
const params = { params: Promise.resolve({ profileId: 'prof_1' }) };
const post = (key: string | null = KEY) =>
  POST(
    new Request('http://localhost/api/vnc/prof_1', {
      method: 'POST',
      headers: key ? { [VNC_AUTHZ_HEADER]: key } : {},
    }),
    { params: Promise.resolve({ profileId: 'prof_1' }) },
  );

beforeEach(() => {
  process.env[VNC_AUTHZ_ENV] = KEY;
  process.env.NODE_GATEWAY_URL = 'http://gateway.test:8080';
  process.env.GATEWAY_INTERNAL_SECRET = 'secret';
  db.getProfile.mockResolvedValue(profile());
  db.startHumanSession.mockResolvedValue({ id: 'sess_new' });
});
afterEach(() => {
  vi.clearAllMocks();
  unset(VNC_AUTHZ_ENV);
  unset('NODE_GATEWAY_URL');
  unset('GATEWAY_INTERNAL_SECRET');
});

describe('POST /api/vnc/:profileId (upgrade authorization)', () => {
  it('is hidden without the in-process key', async () => {
    session.getCurrentMember.mockResolvedValue(member('mem_owner', 'editor'));
    expect((await post(null)).status).toBe(404);
    expect((await post('b'.repeat(64))).status).toBe(404);
    unset(VNC_AUTHZ_ENV);
    expect((await post()).status).toBe(404);
    expect(db.startHumanSession).not.toHaveBeenCalled();
  });

  it('401 when signed out', async () => {
    session.getCurrentMember.mockResolvedValue(null);
    expect((await post()).status).toBe(401);
  });

  it('403 for a Viewer and for an Editor who does not own the account', async () => {
    session.getCurrentMember.mockResolvedValue(member('mem_viewer', 'viewer'));
    expect((await post()).status).toBe(403);
    session.getCurrentMember.mockResolvedValue(member('mem_other', 'editor'));
    expect((await post()).status).toBe(403);
    expect(db.startHumanSession).not.toHaveBeenCalled();
  });

  it('404 for a profile outside the workspace', async () => {
    session.getCurrentMember.mockResolvedValue(member('mem_owner', 'editor'));
    db.getProfile.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
  });

  it('the owner gets a grant and a new human session (session.started is written by the repo)', async () => {
    session.getCurrentMember.mockResolvedValue(member('mem_owner', 'editor'));
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      workspaceId: 'ws_1',
      profileId: 'prof_1',
      memberId: 'mem_owner',
      sessionId: 'sess_new',
    });
    expect(db.startHumanSession).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceId: 'ws_1', profileId: 'prof_1', memberId: 'mem_owner' }),
    );
  });

  it('an Admin reuses the session they already took over', async () => {
    session.getCurrentMember.mockResolvedValue(member('mem_admin', 'admin'));
    db.getProfile.mockResolvedValue(
      profile([{ id: 'sess_open', driver: 'human', startedByMemberId: 'mem_admin' }]),
    );
    const res = await post();
    expect(res.status).toBe(200);
    expect((await res.json()).sessionId).toBe('sess_open');
    expect(db.startHumanSession).not.toHaveBeenCalled();
  });

  it('409 when someone else has control', async () => {
    session.getCurrentMember.mockResolvedValue(member('mem_admin', 'admin'));
    db.getProfile.mockResolvedValue(
      profile([{ id: 'sess_open', driver: 'human', startedByMemberId: 'mem_owner' }]),
    );
    expect((await post()).status).toBe(409);
    db.getProfile.mockResolvedValue(profile());
    db.startHumanSession.mockRejectedValue(new SessionConflictError('taken'));
    expect((await post()).status).toBe(409);
  });
});

describe('GET /api/vnc/:profileId (status)', () => {
  it('keeps answering plain GETs with status and never starts a session', async () => {
    session.getCurrentMember.mockResolvedValue(member('mem_owner', 'editor'));
    const res = await GET(new Request('http://localhost/api/vnc/prof_1'), params);
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ status: 'ready', websocket: '/api/vnc/prof_1', session: null });
    expect(db.startHumanSession).not.toHaveBeenCalled();
  });

  it('403 for a Viewer, 401 signed out', async () => {
    session.getCurrentMember.mockResolvedValue(member('mem_viewer', 'viewer'));
    expect((await GET(new Request('http://localhost/api/vnc/prof_1'), params)).status).toBe(403);
    session.getCurrentMember.mockResolvedValue(null);
    expect((await GET(new Request('http://localhost/api/vnc/prof_1'), params)).status).toBe(401);
  });

  it('503 when nodes are not configured or the profile has no node', async () => {
    session.getCurrentMember.mockResolvedValue(member('mem_owner', 'editor'));
    unset('NODE_GATEWAY_URL');
    const a = await GET(new Request('http://localhost/api/vnc/prof_1'), params);
    expect(a.status).toBe(503);
    expect((await a.json()).status).toBe('unavailable');
    process.env.NODE_GATEWAY_URL = 'http://gateway.test:8080';
    db.getProfile.mockResolvedValue({ ...profile(), nodeId: null });
    const b = await GET(new Request('http://localhost/api/vnc/prof_1'), params);
    expect(b.status).toBe(503);
    expect((await b.json()).status).toBe('no_node');
  });
});
