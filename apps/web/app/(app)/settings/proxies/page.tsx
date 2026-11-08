import { ProxyProviders } from '@/components/settings/ProxyProviders';
import { requireMember } from '@/lib/session';
import { browsers } from '@threadline/db';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Proxies' };

export default async function ProxiesPage() {
  const me = await requireMember();
  if (me.role !== 'admin')
    return (
      <section className="panel" aria-labelledby="proxies-h">
        <div className="sect-h">
          <h2 id="proxies-h">Proxies</h2>
        </div>
        <p className="muted m-0 px-[18px] pt-2 pb-3.5 text-[13px]">Only admins can manage proxies.</p>
      </section>
    );
  const rows = await browsers.listProviders(me.workspaceId);
  return (
    <ProxyProviders
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        protocol: r.protocol,
        host: r.host,
        portFrom: r.portFrom,
        portTo: r.portTo,
        region: r.region,
        hasUsername: r.hasUsername,
        hasPassword: r.hasPassword,
        portsInUse: r.portsInUse.map((u) => ({ port: u.port, profileName: u.profileName })),
      }))}
    />
  );
}
