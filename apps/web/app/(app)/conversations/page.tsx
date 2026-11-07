import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Conversations' };

export default function Page() {
  return <PageHeader title="Conversations" sub="Replies and DMs from people who engaged." />;
}
