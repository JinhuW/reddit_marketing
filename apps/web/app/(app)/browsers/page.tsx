import { PageHeader } from '@/components/ui/page-header';
import type { Metadata } from 'next';

export const metadata: Metadata = { title: 'Browsers and proxies' };

export default function Page() {
  return (
    <PageHeader title="Browsers and proxies" sub="One browser profile per account, with its own proxy." />
  );
}
