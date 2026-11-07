import { createHash, randomBytes } from 'node:crypto';

export const VID_COOKIE = 'tl_vid';
export const newVisitorId = () => `v_${randomBytes(12).toString('base64url')}`;
export const VID_RE = /^v_[A-Za-z0-9_-]{8,40}$/;
/** IPs are stored only as a salted hash. */
export const hashIp = (ip: string) =>
  createHash('sha256')
    .update(`${process.env.AUTH_SECRET ?? ''}:${ip}`)
    .digest('hex')
    .slice(0, 32);
