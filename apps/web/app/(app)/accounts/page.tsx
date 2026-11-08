import { AccountCard } from '@/components/accounts/AccountCard';
import { ConnectAccountFlow } from '@/components/accounts/ConnectAccountFlow';
import { connectProps } from '@/components/accounts/connect-props';
import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';
import { accounts } from '@threadline/db';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Reddit accounts' };

export default async function Page() {
  const me = await requireMember();
  const [cards, flow] = await Promise.all([accounts.listCards(me.workspaceId), connectProps(me)]);
  return (
    <>
      <PageHeader
        title="Reddit accounts"
        sub="Connected through Reddit’s official sign-in. Each account belongs to a real person, who may own several — never two in the same thread. Threadline never posts from accounts it owns."
        actions={
          <Link href="/accounts/connect" className="btn btn-primary">
            Connect account
          </Link>
        }
      />
      <div className="grid grid-cols-1 items-start gap-5 xl:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)]">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {cards.map((a) => (
            <AccountCard key={a.id} a={a} canManage={me.role === 'admin' || me.id === a.ownerMemberId} />
          ))}
          <div className="panel flex min-h-[200px] flex-col items-center justify-center gap-2 !border-dashed !bg-transparent p-4 text-center">
            <div className="text-sm font-semibold">Add another account</div>
            <div className="muted max-w-[260px] text-[12.5px] leading-normal">
              Yours or a teammate’s. The owner signs in to Reddit themselves. Threadline only drafts; they or
              an approver still press post.
            </div>
            <Link href="/accounts/connect" className="btn mt-1">
              Connect account
            </Link>
          </div>
        </div>
        <ConnectAccountFlow {...flow} />
      </div>
    </>
  );
}
