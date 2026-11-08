import { PauseReason } from '@threadline/shared';
import { describe, expect, it } from 'vitest';
import {
  MAX_PORT_OPTIONS,
  PAUSE_LABEL,
  firstFreePort,
  nodeOptions,
  nodeView,
  profileView,
  providerChoices,
  providerLabel,
  providerPortOptions,
  savedProxyLabel,
  showSignIn,
  signInView,
} from './view';

type Row = Parameters<typeof profileView>[0];

const row = (account: Partial<Row['account']> = {}): Row =>
  ({
    id: 'p1',
    name: 'Mira · Chrome',
    accountId: 'a1',
    nodeId: 'n1',
    proxyId: null,
    status: 'idle',
    fingerprint: { os: 'macOS', tz: 'America/New_York' },
    lastSessionAt: null,
    proxy: null,
    sessions: [],
    account: {
      id: 'a1',
      username: 'mira_cs',
      ownerMemberId: 'm1',
      roleLabel: 'support',
      authMode: 'oauth',
      identifiedAt: new Date('2026-11-01'),
      pausedReason: null,
      owner: { user: { name: 'Mira Chen', email: 'mira@acme.so' } },
      agents: [],
      ...account,
    },
  }) as unknown as Row;

describe('nodeView / nodeOptions', () => {
  it('names the node and says online or offline', () => {
    expect(nodeView(null)).toMatchObject({ id: null, name: 'Unassigned', online: false });
    expect(nodeView({ id: 'n1', name: 'browser-1', status: 'online' })).toMatchObject({
      name: 'browser-1',
      online: true,
      label: 'Online',
      chip: 'chip-ok',
    });
    expect(nodeView({ id: 'n1', name: 'browser-1', status: 'offline' })).toMatchObject({
      online: false,
      label: 'Offline',
    });
    expect(nodeView({ id: 'n1', name: 'browser-1', status: 'draining' }).label).toBe('Draining');
  });

  it('offers Unassigned + online nodes, and keeps an offline current node selectable', () => {
    const online = [{ id: 'n2', name: 'browser-2', status: 'online' }];
    expect(nodeOptions(online, null)).toEqual([
      { id: '', label: 'Unassigned' },
      { id: 'n2', label: 'browser-2' },
    ]);
    expect(nodeOptions(online, { id: 'n1', name: 'browser-1', status: 'offline' })).toEqual([
      { id: '', label: 'Unassigned' },
      { id: 'n1', label: 'browser-1 (offline)' },
      { id: 'n2', label: 'browser-2' },
    ]);
    expect(nodeOptions(online, online[0]!)).toHaveLength(2);
  });
});

describe('profileView', () => {
  it('has a label for every pause reason', () => {
    for (const r of PauseReason) expect(PAUSE_LABEL[r]).toBeTruthy();
  });

  it('shows node, pause reason and sign-in state', () => {
    const v = profileView(row({ pausedReason: 'needs_human' }), new Date(), {
      id: 'n1',
      name: 'browser-1',
      status: 'online',
    });
    expect(v.node).toMatchObject({ name: 'browser-1', online: true });
    expect(v.paused).toEqual({ reason: 'needs_human', label: 'Needs a human' });
    expect(v.signedIn).toBe(true);
    expect(v.account).toBe('u/mira_cs');
    expect(v.needsAttention).toBe(true);
    expect(v.action).toBe('Fix');
  });

  it('a browser-mode account nobody signed in to is waiting, not u/pending-…', () => {
    const v = profileView(row({ authMode: 'browser', identifiedAt: null, username: 'pending-abc123' }));
    expect(v.signedIn).toBe(false);
    expect(v.account).toBe('Waiting for sign-in');
    expect(v.node.name).toBe('Unassigned');
    expect(v.needsAttention).toBe(true);
  });

  it('a healthy profile needs no attention', () => {
    const v = profileView(row());
    expect(v.paused).toBeNull();
    expect(v.needsAttention).toBe(false);
  });
});

describe('sign-in', () => {
  it('shows the banner for ?login=1 or an unidentified browser account', () => {
    expect(showSignIn('1', { authMode: 'oauth', identifiedAt: new Date() })).toBe(true);
    expect(showSignIn(undefined, { authMode: 'browser', identifiedAt: null })).toBe(true);
    expect(showSignIn(undefined, { authMode: 'browser', identifiedAt: new Date() })).toBe(false);
    expect(showSignIn(undefined, { authMode: 'oauth', identifiedAt: null })).toBe(false);
  });

  it('maps account identity and the whoami answer', () => {
    const pending = { identified: false, username: 'pending-abc123' };
    expect(signInView({ identified: true, username: 'mira_cs' }, null)).toEqual({
      state: 'signed_in',
      username: 'mira_cs',
    });
    // identity wins over a stale job answer
    expect(
      signInView({ identified: true, username: 'mira_cs' }, { state: 'done', whoami: { loggedIn: false } }),
    ).toMatchObject({ state: 'signed_in' });
    expect(signInView(pending, null)).toEqual({ state: 'idle' });
    expect(signInView(pending, { state: 'pending' })).toEqual({ state: 'checking' });
    expect(signInView(pending, { state: 'done', whoami: { loggedIn: false } })).toEqual({
      state: 'not_signed_in',
      message: 'Not signed in yet',
    });
    expect(
      signInView(pending, { state: 'done', whoami: { loggedIn: true, name: 'jane_from_acme', id: 'x1' } }),
    ).toMatchObject({ state: 'failed', message: expect.stringContaining('u/jane_from_acme') });
    expect(signInView(pending, { state: 'failed', reason: 'boom' })).toEqual({
      state: 'failed',
      message: 'boom',
    });
    expect(signInView(pending, { state: 'gone' }).state).toBe('failed');
  });
});

describe('savedProxyLabel', () => {
  it('never includes credentials', () => {
    expect(
      savedProxyLabel({
        provider: 'Decodo',
        protocol: 'http',
        host: 'isp.decodo.com',
        port: 10001,
        profileCount: 1,
      }),
    ).toBe('Decodo · isp.decodo.com:10001 · 1 profile');
    expect(
      savedProxyLabel({ provider: 'Own server', protocol: 'none', host: null, port: null, profileCount: 0 }),
    ).toBe('Own server · direct · 0 profiles');
  });
});

describe('provider ports', () => {
  const decodo = {
    id: 'pv1',
    name: 'Decodo',
    host: 'isp.decodo.com',
    portFrom: 10005,
    portTo: 10008,
    portsInUse: [
      { port: 10006, profileId: 'p1', profileName: 'Jane · Chrome' },
      { port: 10007, profileId: 'p2', profileName: 'Leo · Chrome' },
    ],
  };

  it('lists the range; other profiles’ ports are disabled with their name, the own port is not', () => {
    expect(providerPortOptions(decodo, 'p1')).toEqual([
      { port: 10005, label: '10005', disabled: false },
      { port: 10006, label: '10006 · this profile', disabled: false },
      { port: 10007, label: '10007 · Leo · Chrome', disabled: true },
      { port: 10008, label: '10008', disabled: false },
    ]);
    // a new profile (connect flow) has no port of its own
    expect(
      providerPortOptions(decodo, null)!
        .filter((o) => o.disabled)
        .map((o) => o.port),
    ).toEqual([10006, 10007]);
  });

  it('no range, or one too wide, means a typed-in port', () => {
    expect(providerPortOptions({ ...decodo, portFrom: null, portTo: null }, null)).toBeNull();
    expect(providerPortOptions({ ...decodo, portFrom: 1, portTo: MAX_PORT_OPTIONS + 1 }, null)).toBeNull();
    expect(providerPortOptions({ ...decodo, portFrom: 1, portTo: MAX_PORT_OPTIONS }, null)).toHaveLength(
      MAX_PORT_OPTIONS,
    );
  });

  it('labels and choices carry no credentials; first free port skips used ones', () => {
    expect(providerLabel(decodo)).toBe('Decodo · isp.decodo.com · 10005–10008');
    expect(providerLabel({ ...decodo, portFrom: null, portTo: null })).toBe('Decodo · isp.decodo.com');
    const [c] = providerChoices([{ ...decodo, portFrom: 10006, portTo: 10008 }], 'p9');
    expect(c!.usedPorts).toEqual([
      { port: 10006, profileName: 'Jane · Chrome' },
      { port: 10007, profileName: 'Leo · Chrome' },
    ]);
    expect(firstFreePort(c)).toBe('10008');
    expect(firstFreePort(undefined)).toBe('');
  });
});
