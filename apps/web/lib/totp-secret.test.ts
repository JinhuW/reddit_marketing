import { describe, expect, it } from 'vitest';
import { normalizeTotpSecret } from './totp-secret';

describe('normalizeTotpSecret', () => {
  it('accepts the grouped form, lower case and otpauth links', () => {
    expect(normalizeTotpSecret('GDKI AX2L WCTA C3JC')).toEqual({ ok: true, secret: 'GDKIAX2LWCTAC3JC' });
    expect(normalizeTotpSecret(' gdki-ax2l-wcta-c3jc ')).toEqual({ ok: true, secret: 'GDKIAX2LWCTAC3JC' });
    expect(normalizeTotpSecret('otpauth://totp/Reddit:mira?secret=gdkiax2lwctac3jc&issuer=Reddit')).toEqual({
      ok: true,
      secret: 'GDKIAX2LWCTAC3JC',
    });
  });

  it('refuses non-base32 or short keys without echoing them', () => {
    const bad = normalizeTotpSecret('GDKI AX2L WCTA C3J1');
    expect(bad.ok).toBe(false);
    expect(JSON.stringify(bad)).not.toContain('GDKI');
    expect(normalizeTotpSecret('ABCDEFGH').ok).toBe(false);
    expect(normalizeTotpSecret('otpauth://totp/x?issuer=Reddit').ok).toBe(false);
  });
});
