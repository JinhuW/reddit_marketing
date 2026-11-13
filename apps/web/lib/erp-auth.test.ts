import { describe, expect, it, vi } from 'vitest';
import { erpLogin, memberRoleForErp, refreshCookie } from './erp-auth';

const json = (status: number, body: unknown, setCookie: string[] = []) => {
  const headers = new Headers({ 'content-type': 'application/json' });
  for (const c of setCookie) headers.append('set-cookie', c);
  return new Response(JSON.stringify(body), { status, headers });
};

describe('erpLogin', () => {
  it('returns the ERP user and revokes the ERP refresh token', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        json(200, { user: { email: 'Ann@RS.com', name: 'Ann', role: 'manager' } }, [
          'at=aaa; Path=/; HttpOnly',
          'rt=rrr; Path=/api/auth; HttpOnly',
        ]),
      )
      .mockResolvedValueOnce(json(200, { ok: true }));
    const r = await erpLogin('ann@rs.com', 'pw', { baseUrl: 'https://erp.test/', fetchImpl });
    expect(r).toEqual({ ok: true, user: { email: 'ann@rs.com', name: 'Ann', role: 'manager' } });
    const [login, logout] = fetchImpl.mock.calls as [string, { headers: Record<string, string> }][];
    expect(login?.[0]).toBe('https://erp.test/api/auth/login');
    expect(login?.[1].headers['X-Requested-By']).toBe('recycle-erp');
    expect(logout?.[0]).toBe('https://erp.test/api/auth/logout');
    expect(logout?.[1].headers.cookie).toBe('rt=rrr');
  });

  it('maps wrong credentials, lockout and outages', async () => {
    const base = { baseUrl: 'https://erp.test' };
    expect(
      await erpLogin('a@b.c', 'x', { ...base, fetchImpl: vi.fn().mockResolvedValue(json(401, {})) }),
    ).toEqual({ ok: false, reason: 'invalid' });
    expect(
      await erpLogin('a@b.c', 'x', { ...base, fetchImpl: vi.fn().mockResolvedValue(json(429, {})) }),
    ).toEqual({ ok: false, reason: 'locked' });
    expect(
      await erpLogin('a@b.c', 'x', { ...base, fetchImpl: vi.fn().mockResolvedValue(json(502, {})) }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(
      await erpLogin('a@b.c', 'x', { ...base, fetchImpl: vi.fn().mockRejectedValue(new Error('down')) }),
    ).toEqual({ ok: false, reason: 'unavailable' });
    expect(await erpLogin('a@b.c', 'x', { baseUrl: '' })).toEqual({ ok: false, reason: 'unavailable' });
  });
});

describe('memberRoleForErp', () => {
  it('only ERP managers become approving admins', () => {
    expect(memberRoleForErp('manager')).toEqual({ role: 'admin', canApprove: true });
    expect(memberRoleForErp('purchaser')).toEqual({ role: 'editor', canApprove: false });
    expect(memberRoleForErp('')).toEqual({ role: 'editor', canApprove: false });
  });
});

describe('refreshCookie', () => {
  it('finds rt among Set-Cookie headers', () => {
    expect(refreshCookie(['at=1; Path=/', 'rt=two; HttpOnly'])).toBe('two');
    expect(refreshCookie(['at=1'])).toBeNull();
  });
});
