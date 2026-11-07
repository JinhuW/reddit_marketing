import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Reddit accounts' };

export default function Page() {
  return <PageHeader title="Reddit accounts" sub="Accounts your team owns and posts from." />;
}
