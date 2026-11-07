import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Tracking' };

export default function Page() {
  return <PageHeader title="Tracking" sub="Keyword groups and the subreddits you watch." />;
}
