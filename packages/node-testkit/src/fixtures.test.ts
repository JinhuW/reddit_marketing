import { readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { REDDIT_PAGES, REDDIT_PAGES_DIR, type RedditPage, readRedditPage } from './fixtures';

const pages = Object.keys(REDDIT_PAGES) as RedditPage[];

describe('reddit page fixtures', () => {
  it('every listed fixture exists and nothing unlisted is in the folder', () => {
    const html = readdirSync(REDDIT_PAGES_DIR).filter((f) => f.endsWith('.html'));
    expect(html.sort()).toEqual(Object.values(REDDIT_PAGES).sort());
  });

  it.each(pages)('%s is a complete, self-contained document', (page) => {
    const html = readRedditPage(page);
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toMatch(/<title>[^<]+<\/title>/);
    // No external scripts, styles, frames or images: fixtures never reach the network.
    expect(html).not.toMatch(/<(script|link|img|iframe)[^>]+(src|href)="(https?:)?\/\//i);
  });

  it.each(pages)('%s is scrubbed of personal data', (page) => {
    const html = readRedditPage(page);
    // Only masked addresses on example.com.
    for (const email of html.match(/[\w.*+-]+@[\w-]+(?:\.[\w-]+)+/g) ?? []) {
      expect(email).toMatch(/^[a-z]\*+@example\.com$/);
    }
    // Usernames are testkit accounts only.
    for (const m of html.matchAll(/(?:u\/|\/user\/|author=")([\w-]+)/g)) {
      expect(m[1]).toMatch(/^testkit_/);
    }
    // No session material.
    expect(html).not.toMatch(/reddit_session|token_v2|csrf_token|Bearer\s/i);
  });

  it('pages carry the markers the actions rely on', () => {
    expect(readRedditPage('thread')).toContain('shreddit-post id="t3_1abc2de"');
    expect(readRedditPage('commentBox')).toContain('data-parent="t1_kx1aa02"');
    expect(readRedditPage('dmCompose')).toContain('id="compose-message"');
    expect(readRedditPage('verificationWall')).toContain('autocomplete="one-time-code"');
    expect(readRedditPage('loginWall')).toContain('type="password"');
    expect(readRedditPage('captchaWall')).toContain('g-recaptcha');
  });
});
