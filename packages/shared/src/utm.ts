import type { LinkMedium } from './enums';

export interface UtmInput {
  medium: LinkMedium;
  /** subreddit name without the r/ prefix */
  subreddit?: string | null;
  /** Reddit post id (t3_…) or internal post id */
  postId?: string | null;
  /** agent name, lower-cased */
  agent?: string | null;
}

export interface UtmParams {
  utm_source: 'reddit';
  utm_medium: LinkMedium;
  utm_campaign?: string;
  utm_content?: string;
  utm_term?: string;
}

const clean = (v: string) =>
  v
    .trim()
    .replace(/^r\//i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '');

export function buildUtm(input: UtmInput): UtmParams {
  const p: UtmParams = { utm_source: 'reddit', utm_medium: input.medium };
  if (input.subreddit) p.utm_campaign = clean(input.subreddit);
  if (input.postId) p.utm_content = input.postId;
  if (input.agent) p.utm_term = clean(input.agent);
  return p;
}

/** Appends UTM params to a destination, keeping any existing query string and hash. */
export function withUtm(destination: string, utm: UtmParams): string {
  const url = new URL(destination);
  for (const [k, v] of Object.entries(utm)) {
    if (v !== undefined && v !== '') url.searchParams.set(k, v);
  }
  return url.toString();
}

const BASE62 = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz';

/** 6-char base62 slug for /r/[slug]. Uses crypto.getRandomValues so it works in edge and node. */
export function makeSlug(length = 6): string {
  const bytes = new Uint8Array(length);
  globalThis.crypto.getRandomValues(bytes);
  let out = '';
  for (const b of bytes) out += BASE62[b % 62];
  return out;
}

export const SLUG_RE = /^[0-9A-Za-z]{6}$/;
