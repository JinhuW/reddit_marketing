import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Opportunities' };

export default function Page() {
  return <PageHeader title="Opportunities" sub="Scored buying conversations from your keyword groups." />;
}
