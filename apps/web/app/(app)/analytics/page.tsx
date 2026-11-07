import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Analytics' };

export default function Page() {
  return <PageHeader title="Analytics" sub="Clicks, signups and revenue by thread." />;
}
