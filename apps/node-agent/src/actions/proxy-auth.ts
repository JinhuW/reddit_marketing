/**
 * Proxy authentication over CDP (ADR-0001, apps/browser-profile/README.md): the container's Chromium gets
 * `--proxy-server` without credentials, and the agent answers the proxy's 407 challenge with
 * `Fetch.authRequired` → `Fetch.continueWithAuth`. Credentials never reach argv, disk or the page.
 *
 * Only `Proxy` challenges get the credentials; a site asking for HTTP auth is cancelled, so a page cannot
 * phish the proxy password.
 */
import type { CDPSession, Page } from 'playwright-core';

export interface ProxyCredentials {
  username: string;
  password: string;
}

interface RequestPaused {
  requestId: string;
}

interface AuthRequired {
  requestId: string;
  authChallenge: { source?: 'Server' | 'Proxy'; origin?: string; scheme?: string };
}

/** Attach to `page` and answer proxy challenges until the page closes or `detach()` is called. */
export async function attachProxyAuth(
  page: Page,
  creds: ProxyCredentials,
): Promise<{ session: CDPSession; detach: () => Promise<void> }> {
  const session = await page.context().newCDPSession(page);
  session.on('Fetch.requestPaused', (p: RequestPaused) => {
    session.send('Fetch.continueRequest', { requestId: p.requestId }).catch(() => {});
  });
  // A proxy that rejects the credentials challenges again for the same request; answering twice would loop,
  // so the second challenge is cancelled and the 407 reaches the page (the action reports `proxy_failed`).
  const answered = new Set<string>();
  session.on('Fetch.authRequired', (p: AuthRequired) => {
    const first = !answered.has(p.requestId);
    answered.add(p.requestId);
    if (answered.size > 1_000) answered.clear();
    const authChallengeResponse =
      p.authChallenge?.source === 'Proxy' && first
        ? { response: 'ProvideCredentials' as const, username: creds.username, password: creds.password }
        : { response: 'CancelAuth' as const };
    session.send('Fetch.continueWithAuth', { requestId: p.requestId, authChallengeResponse }).catch(() => {});
  });
  // `authRequired` only fires for intercepted requests, so every request pauses and is continued as-is.
  await session.send('Fetch.enable', { handleAuthRequests: true, patterns: [{ urlPattern: '*' }] });
  return {
    session,
    detach: async () => {
      await session.send('Fetch.disable').catch(() => {});
      await session.detach().catch(() => {});
    },
  };
}
