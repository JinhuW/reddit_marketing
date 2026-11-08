import { NewBrowserForm } from '@/components/browsers/NewBrowserForm';
import { savedProxyLabel } from '@/components/browsers/view';
import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';
import { browsers, members } from '@threadline/db';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'New browser' };

/** Plan 0003: a browser on its own; an account is assigned to it afterwards on the Browsers screen. */
export default async function NewBrowserPage() {
  const me = await requireMember();
  const canCreate = members.roleAtLeast(me.role, 'editor');
  const proxies = canCreate ? await browsers.listProxies(me.workspaceId) : [];
  return (
    <>
      <PageHeader
        title="New browser"
        sub="A dedicated browser profile on one of your nodes, with its own fingerprint. Add or assign a Reddit account to it next."
        actions={
          <Link href="/browsers" className="btn">
            Back to browsers
          </Link>
        }
      />
      <div className="max-w-[560px]">
        {canCreate ? (
          <NewBrowserForm proxies={proxies.map((x) => ({ id: x.id, label: savedProxyLabel(x) }))} />
        ) : (
          <div className="panel muted p-6 text-[13px]">Viewers can’t create browsers.</div>
        )}
      </div>
    </>
  );
}
