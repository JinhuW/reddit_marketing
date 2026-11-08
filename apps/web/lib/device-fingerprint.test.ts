import { describe, expect, it } from 'vitest';
import { parseDeviceFingerprint } from './device-fingerprint';

describe('parseDeviceFingerprint', () => {
  const now = new Date('2026-11-08T12:00:00Z');
  it('keeps the captured device and stamps capturedAt', () => {
    const raw = JSON.stringify({
      userAgent: 'Mozilla/5.0',
      screen: '1512×982',
      tz: 'America/New_York',
      locale: 'en-US',
      os: 'macOS',
    });
    expect(parseDeviceFingerprint(raw, now)).toEqual({
      userAgent: 'Mozilla/5.0',
      screen: '1512×982',
      tz: 'America/New_York',
      locale: 'en-US',
      os: 'macOS',
      capturedAt: '2026-11-08T12:00:00.000Z',
    });
  });

  it('is {} for missing or malformed input', () => {
    expect(parseDeviceFingerprint('', now)).toEqual({});
    expect(parseDeviceFingerprint('{not json', now)).toEqual({});
    expect(parseDeviceFingerprint('{"screen": 5}', now)).toEqual({});
  });
});
