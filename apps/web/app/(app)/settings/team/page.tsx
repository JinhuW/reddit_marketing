import { TeamTable } from '@/components/settings/TeamTable';
import { lastActive } from '@/components/settings/lastActive';
import { requireMember } from '@/lib/session';
import { settings } from '@threadline/db';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Team and roles' };

export default async function TeamPage() {
  const me = await requireMember();
  const rows = await settings.team(me.workspaceId);
  const now = new Date();
  return (
    <TeamTable
      isAdmin={me.role === 'admin'}
      rows={rows.map((r) => ({
        id: r.id,
        name: r.name,
        email: r.email,
        role: r.role,
        canApprove: r.canApprove,
        accounts: r.accounts,
        lastActive: lastActive(r.lastActive, now),
      }))}
    />
  );
}
