import { Sidebar } from '@/components/shell/Sidebar';
import { Topbar } from '@/components/shell/Topbar';
import { requireMember } from '@/lib/session';
import { members, shell } from '@threadline/db';
import { ROLE_LABEL } from '@threadline/shared';
import type { ReactNode } from 'react';
import { Suspense } from 'react';

export const dynamic = 'force-dynamic';

export default async function AppLayout({ children }: { children: ReactNode }) {
  const me = await requireMember();
  const [counts, wss] = await Promise.all([
    shell.shellCounts(me.workspaceId, me.id),
    members.workspacesForUser(me.userId),
  ]);
  const name = me.user.name ?? me.user.email;
  const roleLabel = `${ROLE_LABEL[me.role]}${me.canApprove && me.role !== 'approver' ? ' · Approver' : ''}`;
  return (
    <div className="flex min-h-screen w-full bg-bg text-ink">
      <Sidebar
        initialCounts={counts}
        me={{ name, roleLabel }}
        workspaces={wss.map((w) => ({ name: w.workspace.name, slug: w.workspace.slug }))}
        currentWorkspace={{ name: me.workspace.name, slug: me.workspace.slug }}
      />
      <div className="flex min-w-0 flex-1 flex-col">
        <Suspense fallback={<div className="h-16 border-b border-line bg-surface" />}>
          <Topbar me={{ name }} canCreateAgent={members.roleAtLeast(me.role, 'admin')} />
        </Suspense>
        <main className="flex flex-col gap-5 p-6">{children}</main>
      </div>
    </div>
  );
}
