import { Avatar } from '@/components/ui/avatar';
import { Icon } from '@/components/ui/icon';
import Link from 'next/link';
import type { ProfileView } from './view';

export function Dot({ color }: { color: string }) {
  return (
    <span
      aria-hidden="true"
      className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full"
      style={{ background: color }}
    />
  );
}

export function ProfileTable({
  profiles,
  selectedId,
}: { profiles: ProfileView[]; selectedId: string | null }) {
  return (
    <section className="panel min-w-0" aria-labelledby="profiles-h">
      <div className="sect-h">
        <h2 id="profiles-h">Browser profiles</h2>
        <span className="muted text-xs">Each profile is bound to exactly one account and one agent</span>
      </div>
      <div className="overflow-x-auto px-2 py-1">
        <table className="tbl [&_td]:whitespace-nowrap" data-testid="profile-table">
          <thead>
            <tr>
              <th>Profile</th>
              <th>Account · owner</th>
              <th>Agent</th>
              <th>Proxy</th>
              <th>Region</th>
              <th>Status</th>
              <th>Node</th>
              <th>Last session</th>
              <th>
                <span className="sr-only">Action</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {profiles.map((p) => (
              <tr
                key={p.id}
                data-profile={p.name}
                className={p.id === selectedId ? 'bg-surface-3' : 'row-hover'}
              >
                <td>
                  <Link
                    href={`/browsers?id=${p.id}`}
                    className="flex items-center gap-2"
                    aria-current={p.id === selectedId ? 'true' : undefined}
                  >
                    <span className="grid h-[26px] w-[26px] place-items-center rounded-lg bg-surface-3 text-ink-2">
                      <Icon name="browser" size={14} />
                    </span>
                    <span className="leading-tight">
                      <span className="block font-semibold">{p.name}</span>
                      <span className="muted block text-[11.5px]">{p.device}</span>
                    </span>
                  </Link>
                </td>
                <td>
                  <div className="leading-tight">
                    <div className="font-medium">{p.account}</div>
                    <div className="muted text-[11.5px]">{p.owner}</div>
                  </div>
                </td>
                <td>
                  {p.agent ? (
                    <span className="inline-flex items-center gap-1.5">
                      <Avatar name={p.agent.name} color={p.agent.color} label={p.agent.name[0]} size={20} />
                      {p.agent.name}
                    </span>
                  ) : (
                    <span className="muted">—</span>
                  )}
                </td>
                <td>
                  <div className="leading-tight">
                    <div className="font-medium">{p.proxyLabel}</div>
                    <div className="muted text-[11.5px]">{p.proxyType}</div>
                  </div>
                </td>
                <td>
                  <span
                    className={`chip ${p.region.mismatch ? 'chip-warn' : 'chip-ok'}`}
                    title={p.region.reason ?? 'Matches the owner'}
                  >
                    {p.region.label}
                    {p.region.mismatch ? <span className="sr-only"> · region mismatch</span> : null}
                  </span>
                </td>
                <td>
                  <div className="flex flex-col items-start gap-1">
                    <span className={`chip ${p.status.chip}`}>
                      <Dot color={p.status.dot} />
                      {p.status.label}
                    </span>
                    {p.paused ? (
                      <span className="chip chip-warn" data-testid="pause-reason">
                        Paused · {p.paused.label}
                      </span>
                    ) : null}
                  </div>
                </td>
                <td data-testid="node-cell">
                  <div className="leading-tight">
                    <div className="font-medium">{p.node.name}</div>
                    <div className={`text-[11.5px] ${p.node.online ? 'text-ok' : 'text-muted'}`}>
                      {p.node.label}
                    </div>
                  </div>
                </td>
                <td className="muted whitespace-nowrap">{p.lastSession}</td>
                <td className="text-right">
                  <Link href={`/browsers?id=${p.id}`} className="btn btn-ghost !h-[26px] !px-2">
                    {p.action}
                  </Link>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="muted flex flex-wrap gap-4 border-t border-line-soft px-[18px] py-3 text-xs">
        <span>
          <Dot color="var(--ok)" />
          Running — agent has the browser open
        </span>
        <span>
          <Dot color="var(--faint)" />
          Idle — session saved, nothing open
        </span>
        <span>
          <Dot color="var(--warn)" />
          Check — a setting no longer matches the account owner
        </span>
      </div>
    </section>
  );
}
