import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Agent employees' };

export default function Page() {
  return <PageHeader title="Agent employees" sub="Personas that draft replies for approval." />;
}
