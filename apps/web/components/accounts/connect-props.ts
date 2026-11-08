import 'server-only';
import { savedProxyLabel } from '@/components/browsers/view';
import { PENDING_COOKIE, openPending, redditConfigured } from '@/lib/reddit-oauth';
import { accounts, browsers, members } from '@threadline/db';
import type { CurrentMember } from '@threadline/db/repos/members';
import { cookies } from 'next/headers';
import type { ConnectProps } from './ConnectAccountFlow';

const ERRORS: Record<string, string> = {
  not_configured: 'Reddit app not configured — set REDDIT_CLIENT_ID/SECRET.',
  already_owner: 'You already own a connected Reddit account. Each person can connect one.',
  forbidden: 'Viewers can’t connect accounts.',
  state: 'The Reddit sign-in could not be verified. Start again.',
  denied: 'Reddit sign-in was cancelled.',
  reddit: 'Reddit did not complete the sign-in. Try again in a minute.',
};

export async function connectProps(me: CurrentMember, error?: string): Promise<ConnectProps> {
  const [owned, proxies] = await Promise.all([
    accounts.findByOwner(me.id),
    browsers.listProxies(me.workspaceId),
  ]);
  const pending = openPending((await cookies()).get(PENDING_COOKIE)?.value, me.id);
  const settings = (me.workspace.settings ?? {}) as { product?: string };
  return {
    configured: redditConfigured(),
    ownerName: me.user.name ?? me.user.email,
    alreadyOwns: owned && !accounts.isPendingConnect(owned) ? owned.username : null,
    resumes: owned && accounts.isPendingConnect(owned) ? owned.username : null,
    canConnect: members.roleAtLeast(me.role, 'editor'),
    authorized: pending ? { username: pending.username, scopes: pending.scopes } : null,
    product: settings.product ?? me.workspace.name,
    error: error ? (ERRORS[error] ?? 'Something went wrong.') : null,
    proxies: proxies.map((x) => ({ id: x.id, label: savedProxyLabel(x) })),
  };
}
