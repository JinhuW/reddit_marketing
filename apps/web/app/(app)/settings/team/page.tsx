import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Settings' };

export default function Page() {
  return <PageHeader title="Settings" sub="Team" />;
}
