import { api, json } from '@/lib/api-v1';
import { browsers } from '@threadline/db';

export const dynamic = 'force-dynamic';

/** `GET /api/v1/proxies`: the pool with each proxy's last check. Never a login or a change-IP link. */
export const GET = api(async (me) => {
  const list = await browsers.listProxies(me.workspaceId);
  return json({
    proxies: list.map((x) => ({
      id: x.id,
      name: x.label,
      protocol: x.protocol,
      host: x.host,
      port: x.port,
      hasLogin: x.hasCredentials,
      browsers: x.profileCount,
      lastCheck: x.lastTest
        ? {
            ok: x.lastTest.ok !== false,
            error: x.lastTest.error ?? null,
            ip: x.lastTest.ip ?? null,
            place: x.lastTest.city ?? null,
            latencyMs: x.lastTest.latencyMs ?? null,
            at: x.lastTest.testedAt ?? null,
          }
        : null,
    })),
  });
});
