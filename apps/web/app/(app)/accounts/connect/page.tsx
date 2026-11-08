import { ConnectAccountFlow } from '@/components/accounts/ConnectAccountFlow';
import { connectProps } from '@/components/accounts/connect-props';
import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Connect a Reddit account' };

export default async function Page({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const me = await requireMember();
  const { error } = await searchParams;
  const flow = await connectProps(me, error);
  return (
    <>
      <PageHeader
        title="Connect a Reddit account"
        sub="Sign-in, owner, role and disclosure, limits. The owner signs in to Reddit themselves."
        actions={
          <Link href="/accounts" className="btn">
            Back to accounts
          </Link>
        }
      />
      <div className="max-w-[560px]">
        <ConnectAccountFlow {...flow} />
      </div>
    </>
  );
}
