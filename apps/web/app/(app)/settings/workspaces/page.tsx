import { requireMember } from '@/lib/session';
import { settings } from '@threadline/db';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Client workspaces' };

export default async function WorkspacesPage() {
  const me = await requireMember();
  const list = await settings.workspaces(me.workspaceId);
  const agency = me.workspace.plan === 'agency';
  return (
    <section className="panel" aria-labelledby="ws-h">
      <div className="sect-h">
        <h2 id="ws-h">Client workspaces</h2>
      </div>
      <ul
        className="m-0 flex list-none flex-col gap-2 px-[18px] pt-2 pb-3.5 text-[13px]"
        data-testid="workspace-list"
      >
        {list.map((w) => (
          <li key={w.id} className="flex items-center gap-2.5">
            <span className="grid h-6 w-6 place-items-center rounded-[7px] bg-inverse text-[10px] font-semibold text-inverse-ink">
              {w.name[0]}
            </span>
            <span className="flex-1 font-medium">{w.name}</span>
            <span className="chip chip-line">{w.parentWorkspaceId ? 'Client' : 'This workspace'}</span>
          </li>
        ))}
      </ul>
      {!agency ? (
        <p className="m-0 border-t border-line-soft bg-surface-2 px-[18px] py-3 text-[12.5px] text-ink-2">
          Client workspaces are part of the Agency plan. Each client gets its own accounts, agents and roles;
          switching ships in M8.
        </p>
      ) : null}
    </section>
  );
}
