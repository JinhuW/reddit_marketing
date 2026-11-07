import { WeeklyReportCard } from '@/components/settings/WeeklyReportCard';
import { requireMember } from '@/lib/session';
import { settings } from '@threadline/db';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Weekly report' };

export default async function ReportsPage() {
  const me = await requireMember();
  return (
    <WeeklyReportCard report={await settings.weeklyReport(me.workspaceId)} canEdit={me.role === 'admin'} />
  );
}
