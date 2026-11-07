import { SessionClock } from '@/components/browsers/SessionClock';
import { TakeoverForm } from '@/components/browsers/TakeoverForm';
import { VncViewer } from '@/components/browsers/VncViewer';
import { profileView } from '@/components/browsers/view';
import { Avatar } from '@/components/ui/avatar';
import { handBackAction } from '@/lib/actions/browsers';
import { requireMember } from '@/lib/session';
import { browsers } from '@threadline/db';
import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

export const metadata: Metadata = { title: 'Remote session' };

const time = (d: Date) =>
  d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

export default async function SessionPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const me = await requireMember();
  const row = await browsers.getProfile(me.workspaceId, id);
  if (!row) notFound();
  const p = profileView(row);
  const canControl = browsers.canControlProfile(me, row);
  const open = await browsers.openSession(id);
  const shown = open ?? (await browsers.latestSession(id));
  const log = shown ? await browsers.sessionLog(shown.id) : [];
  const humanOpen = open?.driver === 'human' ? open : null;
  const mine = humanOpen?.startedByMemberId === me.id;
  const driverName = humanOpen?.startedBy?.user.name ?? null;
  const agent = p.agent;
  const exitLine = p.test ? `Exit IP ${p.test.ip} · ${p.test.location} · ${p.test.latency}` : null;

  return (
    <>
      <h1 className="sr-only">Remote session · {p.name}</h1>
      <div className="flex flex-wrap items-center gap-3">
        <nav aria-label="Breadcrumb" className="muted flex items-center gap-1.5 text-[12.5px]">
          <Link href={`/browsers?id=${p.id}`} className="hover:text-ink">
            Browsers
          </Link>
          <span aria-hidden="true">/</span>
          <span className="text-ink">{p.name}</span>
        </nav>
        <div className="flex-1" />
        {humanOpen ? (
          <>
            <span className="chip chip-hot" data-testid="control-chip">
              <span aria-hidden="true" className="mr-1.5 inline-block h-1.5 w-1.5 rounded-full bg-accent" />
              {mine ? 'You have control' : `${driverName} has control`} ·&nbsp;
              <SessionClock since={humanOpen.startedAt.toISOString()} />
            </span>
            {agent ? (
              <span className="chip chip-line gap-1.5">
                <Avatar name={agent.name} color={agent.color} label={agent.name[0]} size={14} />
                {agent.name} paused
              </span>
            ) : null}
            {canControl ? (
              <form action={handBackAction}>
                <input type="hidden" name="profileId" value={p.id} />
                <input type="hidden" name="sessionId" value={humanOpen.id} />
                <button type="submit" className="btn btn-primary">
                  Hand back{agent ? ` to ${agent.name}` : ''}
                </button>
              </form>
            ) : null}
          </>
        ) : (
          <span className="chip chip-line">
            {open ? `${open.agent?.name ?? 'Agent'} has the browser` : 'No one has control'}
          </span>
        )}
      </div>

      <div className="grid items-stretch gap-5 xl:grid-cols-[minmax(0,1fr)_320px]">
        <VncViewer
          profileId={p.id}
          screen={p.screen}
          exitLine={exitLine}
          account={p.account}
          hasControl={Boolean(humanOpen && mine)}
        />
        <aside className="flex min-w-0 flex-col gap-4">
          <section className="panel" aria-labelledby="sess-h">
            <div className="sect-h">
              <h2 id="sess-h">Session</h2>
            </div>
            <dl className="m-0 grid grid-cols-[86px_minmax(0,1fr)] items-center gap-x-2.5 gap-y-2 px-[18px] pt-3 pb-3.5 text-[12.5px]">
              <dt className="muted">Profile</dt>
              <dd className="m-0 font-medium">{p.name}</dd>
              <dt className="muted">Account</dt>
              <dd className="m-0 font-medium">{p.account}</dd>
              <dt className="muted">Driver</dt>
              <dd className="m-0 flex items-center gap-1.5">
                {humanOpen && driverName ? (
                  <>
                    <Avatar name={driverName} size={18} />
                    {driverName} {mine ? <span className="muted">(you)</span> : null}
                  </>
                ) : open ? (
                  `${open.agent?.name ?? 'Agent'}`
                ) : (
                  <span className="muted">Nobody</span>
                )}
              </dd>
              <dt className="muted">Agent</dt>
              <dd className="m-0 flex items-center gap-1.5">
                {agent ? (
                  <>
                    <Avatar name={agent.name} color={agent.color} label={agent.name[0]} size={18} />
                    {agent.name} · {humanOpen ? 'paused' : 'active'}
                  </>
                ) : (
                  '—'
                )}
              </dd>
              <dt className="muted">Proxy</dt>
              <dd className="m-0 font-medium">
                {p.proxyLabel}{' '}
                <span className={`chip ml-1 ${p.region.mismatch ? 'chip-warn' : 'chip-ok'}`}>
                  {p.region.mismatch ? 'Region mismatch' : 'Healthy'}
                </span>
              </dd>
              <dt className="muted">Started</dt>
              <dd className="num m-0">
                {shown
                  ? `${time(shown.startedAt)} · by ${shown.startedByMemberId === me.id ? 'you' : (shown.startedBy?.user.name ?? shown.agent?.name ?? 'agent')}`
                  : '—'}
                {shown?.endedAt ? <span className="muted"> · ended {time(shown.endedAt)}</span> : null}
              </dd>
            </dl>
          </section>

          {humanOpen ? (
            <section className="panel bg-surface-2" aria-labelledby="why-h">
              <div className="flex flex-col gap-2 px-[18px] py-3.5 text-[12.5px] leading-normal">
                <div id="why-h" className="font-semibold">
                  Why {mine ? 'you' : driverName} took over
                </div>
                <div className="text-ink-2">{humanOpen.reason ?? 'No reason given.'}</div>
                <div className="flex flex-wrap gap-1.5">
                  <span className="chip chip-line">{time(humanOpen.startedAt)}</span>
                </div>
              </div>
            </section>
          ) : canControl ? (
            <section className="panel" aria-labelledby="take-h">
              <div className="sect-h">
                <h2 id="take-h">Take over</h2>
              </div>
              <TakeoverForm profileId={p.id} agentName={agent?.name ?? null} />
            </section>
          ) : (
            <section className="panel muted px-[18px] py-3.5 text-[12.5px]">
              Only an admin or the account owner can take over this browser.
            </section>
          )}

          <section className="panel flex flex-1 flex-col" aria-labelledby="log-h">
            <div className="sect-h">
              <h2 id="log-h">Session log</h2>
              <div className="flex-1" />
              <span className="muted text-xs">Saved to audit</span>
            </div>
            <ol className="m-0 list-none overflow-auto p-0" data-testid="session-log">
              {log.length ? (
                log.map((l) => (
                  <li
                    key={l.id}
                    className="grid grid-cols-[48px_minmax(0,1fr)] gap-2.5 border-b border-line-soft px-[18px] py-2 text-[12.5px] leading-snug"
                  >
                    <span className="muted num">{time(l.at)}</span>
                    <span>
                      <b className="font-semibold">{l.who}</b> <span className="text-ink-2">{l.text}</span>
                    </span>
                  </li>
                ))
              ) : (
                <li className="muted px-[18px] py-3 text-[12.5px]">No sessions yet.</li>
              )}
            </ol>
          </section>
        </aside>
      </div>
    </>
  );
}
