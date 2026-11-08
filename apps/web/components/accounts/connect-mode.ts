export type ConnectMode = 'oauth' | 'browser';

/**
 * Connect choices, first = default (docs/plans/0002-browser-mode.md, Flow 1): with a Reddit app configured
 * both, OAuth first; without one only the browser.
 */
export function connectModes(redditConfigured: boolean): ConnectMode[] {
  return redditConfigured ? ['oauth', 'browser'] : ['browser'];
}

/** Accounts card state for the connection chip / sign-in link. */
export function connectionView(a: {
  authMode: string;
  identified: boolean;
  connected: boolean;
  browserProfileId: string | null;
}) {
  if (a.authMode === 'browser' && !a.identified)
    return {
      chip: 'chip-warn',
      label: 'Waiting for sign-in',
      signInHref: a.browserProfileId ? `/browsers/${a.browserProfileId}/session?login=1` : null,
    };
  if (!a.connected) return { chip: 'chip-bad', label: 'Disconnected', signInHref: null };
  return {
    chip: 'chip-line',
    label: a.authMode === 'browser' ? 'Browser sign-in' : 'Reddit OAuth',
    signInHref: null,
  };
}
