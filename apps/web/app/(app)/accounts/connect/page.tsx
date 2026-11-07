import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Connect a Reddit account' };

export default function Page() {
  return <PageHeader title="Connect a Reddit account" sub="OAuth, owner, role and disclosure, limits." />;
}
