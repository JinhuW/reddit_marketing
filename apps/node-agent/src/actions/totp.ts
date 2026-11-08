/**
 * RFC 6238 TOTP (HMAC-SHA1, 30 s step, 6 digits), the codes authenticator apps show for a Reddit 2FA secret.
 * Secrets are base32 as people paste them ("GDKI AX2L WCTA C3JC", lowercase, `=` padding, dashes).
 *
 * The secret and the codes are credentials: never log them or put them in an error message.
 */
import { createHmac } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** Decodes RFC 4648 base32, ignoring spaces, dashes, case and padding. Throws without echoing the input. */
export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  if (clean === '') throw new Error('2FA secret is empty');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const ch of clean) {
    const idx = BASE32.indexOf(ch);
    if (idx < 0) throw new Error('2FA secret is not base32');
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out.push((value >>> bits) & 0xff);
    }
  }
  return Buffer.from(out);
}

/** Raw HOTP (RFC 4226) over a decoded key. */
export function hotp(key: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const mac = createHmac('sha1', key).update(msg).digest();
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const bin = mac.readUInt32BE(offset) & 0x7fffffff;
  return String(bin % 10 ** digits).padStart(digits, '0');
}

/** The TOTP code for a base32 `secret` at `nowMs`. */
export function totp(secret: string, nowMs = Date.now()): string {
  return hotp(base32Decode(secret), Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS));
}

/** Milliseconds left in the current 30 s window. */
export function totpMsLeft(nowMs = Date.now()): number {
  const stepMs = TOTP_STEP_SECONDS * 1000;
  return stepMs - (nowMs % stepMs);
}
