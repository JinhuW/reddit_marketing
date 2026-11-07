import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Leads' };

export default function Page() {
  return <PageHeader title="Leads" sub="Everyone who engaged, by stage." />;
}
