import { describe, expect, it } from 'vitest';
import { base32Decode, hotp, totp, totpMsLeft } from './totp';

// RFC 6238 appendix B, SHA1 key "12345678901234567890" in base32; codes are the 8-digit vectors' last 6 digits.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const VECTORS: Array<[seconds: number, code: string]> = [
  [59, '287082'],
  [1111111109, '081804'],
  [1111111111, '050471'],
  [1234567890, '005924'],
  [2000000000, '279037'],
  [20000000000, '353130'],
];

describe('totp', () => {
  it.each(VECTORS)('matches the RFC 6238 SHA1 vector at T=%i', (seconds, code) => {
    expect(totp(RFC_SECRET, seconds * 1000)).toBe(code);
  });

  it('matches the RFC 4226 HOTP vectors', () => {
    const key = Buffer.from('12345678901234567890');
    expect([0, 1, 2, 9].map((c) => hotp(key, c))).toEqual(['755224', '287082', '359152', '520489']);
  });

  it('accepts a pasted secret with spaces, lowercase, dashes and padding', () => {
    const spaced = 'gezd gnbv gy3t qojq-GEZD GNBV GY3T QOJQ ==';
    for (const [seconds, code] of VECTORS) expect(totp(spaced, seconds * 1000)).toBe(code);
    expect(base32Decode('GDKI AX2L WCTA C3JC')).toEqual(base32Decode('gdkiax2lwctac3jc'));
    expect(totp('GDKI AX2L WCTA C3JC', 1_700_000_000_000)).toMatch(/^\d{6}$/);
  });

  it('decodes base32 to the right bytes', () => {
    expect(base32Decode('MZXW6YTBOI======').toString()).toBe('foobar');
    expect(base32Decode('my').toString()).toBe('f');
  });

  it('refuses a secret that is not base32 without echoing it', () => {
    for (const bad of ['', '   ', 'NOT-BASE32-1!', 'GDKI0AX2']) {
      try {
        base32Decode(bad);
        expect.unreachable();
      } catch (err) {
        expect((err as Error).message).not.toContain(bad.trim() || '\u0000');
      }
    }
  });

  it('counts down the 30 s window', () => {
    expect(totpMsLeft(0)).toBe(30_000);
    expect(totpMsLeft(29_000)).toBe(1_000);
    expect(totpMsLeft(30_001)).toBe(29_999);
  });
});
