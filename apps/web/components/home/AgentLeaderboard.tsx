import { Avatar } from '@/components/ui/avatar';
import type { dashboard } from '@threadline/db';
import { fmtMoney, fmtPct } from '@threadline/shared';
import Link from 'next/link';

type Row = Awaited<ReturnType<typeof dashboard.agentLeaderboard>>[number];

export function AgentLeaderboard({ rows }: { rows: Row[] }) {
  return (
    <section className="panel" aria-labelledby="lb-h">
      <div className="sect-h">
        <h2 id="lb-h">Agent leaderboard</h2>
        <span className="muted text-xs">30 days</span>
      </div>
      <div className="overflow-x-auto px-2 pt-1 pb-1.5">
        <table className="tbl">
          <thead>
            <tr>
              <th>Agent</th>
              <th className="!text-right">Approved</th>
              <th className="!text-right">Replies</th>
              <th className="!text-right">Leads</th>
              <th className="!text-right">Revenue</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((a) => (
              <tr key={a.id}>
                <td>
                  <Link href={`/agents/${a.id}/persona`} className="flex items-center gap-2">
                    <Avatar name={a.name} label={a.name[0]} color={a.color} size={24} />
                    <div className="leading-tight">
                      <div className="font-medium">{a.name}</div>
                      <div className="muted text-[11.5px] whitespace-nowrap">{a.role}</div>
                    </div>
                  </Link>
                </td>
                <td className="num text-right">{a.approvalRate === null ? '—' : fmtPct(a.approvalRate)}</td>
                <td className="num text-right">{a.replies}</td>
                <td className="num text-right">{a.leads}</td>
                <td className="num text-right font-semibold">{fmtMoney(a.revenueCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
