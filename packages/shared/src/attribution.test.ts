import { describe, expect, it } from 'vitest';
import { lastClick, stageAfterEvent } from './attribution';

const d = (s: string) => new Date(s);
const clicks = [
  { trackedLinkId: 'a', visitorId: 'v1', occurredAt: d('2026-10-01') },
  { trackedLinkId: 'b', visitorId: 'v1', occurredAt: d('2026-10-20') },
  { trackedLinkId: 'c', visitorId: 'v1', occurredAt: d('2026-11-06') },
  { trackedLinkId: 'z', visitorId: 'v2', occurredAt: d('2026-10-25') },
];

describe('lastClick', () => {
  it('picks the latest click before the event', () => {
    expect(lastClick({ visitorId: 'v1', occurredAt: d('2026-11-01') }, clicks)?.trackedLinkId).toBe('b');
  });
  it('ignores clicks older than 30 days', () => {
    expect(lastClick({ visitorId: 'v1', occurredAt: d('2026-11-05') }, clicks.slice(0, 1))).toBeNull();
  });
  it('ignores clicks after the event and other visitors', () => {
    expect(lastClick({ visitorId: 'v2', occurredAt: d('2026-10-24') }, clicks)).toBeNull();
  });
  it('needs a visitor id', () =>
    expect(lastClick({ visitorId: null, occurredAt: d('2026-11-01') }, clicks)).toBeNull());
});

describe('stageAfterEvent', () => {
  it('moves forward on signup and payment', () => {
    expect(stageAfterEvent('replied', 'signup')).toBe('trial');
    expect(stageAfterEvent('trial', 'payment')).toBe('customer');
  });
  it('never moves backwards', () => expect(stageAfterEvent('customer', 'signup')).toBe('customer'));
  it('a payment wins back a lost lead', () => expect(stageAfterEvent('lost', 'payment')).toBe('customer'));
});
