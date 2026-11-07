import { SettingsNav } from '@/components/settings/SettingsNav';
import type { ReactNode } from 'react';

export default function SettingsLayout({ children }: { children: ReactNode }) {
  return (
    <div className="grid items-start gap-6 lg:grid-cols-[200px_minmax(0,1fr)]">
      <SettingsNav />
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </div>
  );
}
