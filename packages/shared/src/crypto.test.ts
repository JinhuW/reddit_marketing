import { randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { decrypt, encrypt } from './crypto';

const k = randomBytes(32).toString('base64');

describe('crypto', () => {
  it('round-trips', () => {
    const c = encrypt('refresh-token-123', k);
    expect(c).not.toContain('refresh-token');
    expect(decrypt(c, k)).toBe('refresh-token-123');
  });
  it('rejects a tampered blob', () => {
    const c = encrypt('secret', k);
    const parts = c.split('.');
    parts[3] = Buffer.from('xxxxxx').toString('base64url');
    expect(() => decrypt(parts.join('.'), k)).toThrow();
  });
  it('rejects a wrong key length', () => {
    expect(() => encrypt('x', Buffer.alloc(16).toString('base64'))).toThrow(/32 bytes/);
  });
});
