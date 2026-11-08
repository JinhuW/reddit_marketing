import { describe, expect, it } from 'vitest';
import { connectModes, connectionView } from './connect-mode';

describe('connectModes', () => {
  it('offers only the browser without a Reddit app, both (OAuth first) with one', () => {
    expect(connectModes(false)).toEqual(['browser']);
    expect(connectModes(true)).toEqual(['oauth', 'browser']);
  });
});

describe('connectionView', () => {
  const base = { authMode: 'oauth', identified: true, connected: true, browserProfileId: 'p1' };
  it('a pending browser account waits for sign-in and links to its session', () => {
    expect(connectionView({ ...base, authMode: 'browser', identified: false, connected: false })).toEqual({
      chip: 'chip-warn',
      label: 'Waiting for sign-in',
      signInHref: '/browsers/p1/session?login=1',
    });
  });
  it('labels connected and disconnected accounts', () => {
    expect(connectionView(base).label).toBe('Reddit OAuth');
    expect(connectionView({ ...base, authMode: 'browser' }).label).toBe('Browser sign-in');
    expect(connectionView({ ...base, connected: false })).toMatchObject({
      label: 'Disconnected',
      signInHref: null,
    });
  });
});
