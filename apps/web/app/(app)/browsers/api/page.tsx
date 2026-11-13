import { NewApiKey, RevokeApiKey } from '@/components/browsers/ApiKeys';
import { PageHeader } from '@/components/ui/page-header';
import { requireMember } from '@/lib/session';
import { apiKeys } from '@threadline/db';
import { ago } from '@threadline/shared';
import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Browser API' };

const ENDPOINTS: [string, string, string][] = [
  ['GET', '/api/v1/browsers?q=&group=&tag=&status=&page=', 'List browsers, filtered like the Browsers page'],
  ['POST', '/api/v1/browsers', 'Create one: { name, groupId?, proxyId?, startUrl?, notes? }'],
  ['GET', '/api/v1/browsers/:id', 'One browser'],
  ['POST', '/api/v1/browsers/:id/start', 'Open the browser on its node'],
  ['POST', '/api/v1/browsers/:id/stop', 'Close it'],
  ['GET', '/api/v1/groups', 'Groups with their browser counts'],
  ['GET', '/api/v1/proxies', 'The proxy pool with each last check'],
  ['POST', '/api/v1/proxies/:id/check', 'Check a proxy from a browser node'],
];

/**
 * The browser management API (plan 0004 phase 7): keys and the endpoint list. The API manages browsers and
 * proxies. It has no endpoint that posts, drives a page, opens a debugging port or returns cookies or logins.
 */
export default async function BrowserApiPage() {
  const me = await requireMember();
  const isAdmin = me.role === 'admin';
  const keys = isAdmin ? await apiKeys.listApiKeys(me.workspaceId) : [];
  const now = new Date();
  return (
    <>
      <PageHeader
        title="Browser API"
        sub="Manage browsers and proxies from your own scripts. A key acts as the admin who created it."
        actions={
          <Link href="/browsers" className="btn">
            Back to browsers
          </Link>
        }
      />
      {isAdmin ? (
        <section className="panel flex flex-col gap-3 px-[18px] py-4 text-[12.5px]">
          <h2 className="m-0 text-[13px] font-semibold">Keys</h2>
          <NewApiKey />
          {keys.length ? (
            <div className="overflow-x-auto">
              <table className="tbl [&_td]:whitespace-nowrap" data-testid="api-keys">
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Key</th>
                    <th>Acts as</th>
                    <th>Created</th>
                    <th>Last used</th>
                    <th>
                      <span className="sr-only">Action</span>
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {keys.map((k) => (
                    <tr key={k.id} data-key={k.name}>
                      <td className="font-semibold">{k.name}</td>
                      <td className="num muted">{k.prefix}…</td>
                      <td>{k.memberName}</td>
                      <td className="muted">{ago(k.createdAt, now)} ago</td>
                      <td className="muted">{k.lastUsedAt ? `${ago(k.lastUsedAt, now)} ago` : 'Never'}</td>
                      <td className="text-right">
                        {k.revokedAt ? (
                          <span className="chip chip-mid">Revoked</span>
                        ) : (
                          <RevokeApiKey id={k.id} name={k.name} />
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <p className="muted m-0">No keys yet.</p>
          )}
        </section>
      ) : (
        <p className="panel muted m-0 p-6 text-[13px]">Only an admin can create or see API keys.</p>
      )}
      <section className="panel flex flex-col gap-3 px-[18px] py-4 text-[12.5px]">
        <h2 className="m-0 text-[13px] font-semibold">Endpoints</h2>
        <p className="muted m-0 leading-normal">
          Send the key as <span className="num">Authorization: Bearer &lt;key&gt;</span>. Answers are JSON.
          Each key may make 120 requests a minute. Starting a browser opens it on its node; the API does not
          drive it, and posting to Reddit still needs an approved draft.
        </p>
        <div className="overflow-x-auto">
          <table className="tbl [&_td]:whitespace-nowrap">
            <tbody>
              {ENDPOINTS.map(([method, path, what]) => (
                <tr key={`${method} ${path}`}>
                  <td>
                    <span className={`chip ${method === 'GET' ? 'chip-mid' : 'chip-ok'}`}>{method}</span>
                  </td>
                  <td className="num">{path}</td>
                  <td className="muted">{what}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <pre className="m-0 overflow-x-auto rounded-[9px] bg-surface-3 px-3 py-2 font-mono text-[11.5px] leading-snug">
          {
            'curl -H "Authorization: Bearer $THREADLINE_KEY" https://<your-domain>/api/v1/browsers?status=running'
          }
        </pre>
      </section>
    </>
  );
}
