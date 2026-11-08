import { SettingsNav } from '@/components/settings/SettingsNav';
import { requireMember } from '@/lib/session';
import type { ReactNode } from 'react';

export default async function SettingsLayout({ children }: { children: ReactNode }) {
  const me = await requireMember();
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
      <SettingsNav isAdmin={me.role === 'admin'} />
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </div>
  );
}
