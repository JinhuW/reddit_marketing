/**
 * 2FA secrets as people paste them: "GDKI AX2L WCTA C3JC", lower case, or an `otpauth://totp/…?secret=…` link.
 * Returns the bare base32 secret, or a message for the form. Never echoes the input.
 */
export function normalizeTotpSecret(
  raw: string,
): { ok: true; secret: string } | { ok: false; message: string } {
  let s = raw.trim();
  if (/^otpauth:\/\//i.test(s)) {
    try {
      s = new URL(s).searchParams.get('secret') ?? '';
    } catch {
      s = '';
    }
    if (!s) return { ok: false, message: 'That 2FA link has no secret in it.' };
  }
  s = s.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase();
  if (!/^[A-Z2-7]+$/.test(s))
    return { ok: false, message: '2FA secret must be the base32 key (letters A–Z and digits 2–7).' };
  if (s.length < 16 || s.length > 128)
    return { ok: false, message: '2FA secret must be 16 to 128 characters long.' };
  return { ok: true, secret: s };
}
