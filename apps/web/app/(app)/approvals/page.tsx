import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Approvals' };

export default function Page() {
  return <PageHeader title="Approvals" sub="Drafts waiting for a human." />;
}
