import { describe, expect, it } from 'vitest';
import { SLUG_RE, buildUtm, makeSlug, withUtm } from './utm';

describe('utm', () => {
  it('builds the documented params', () => {
    expect(
      buildUtm({ medium: 'comment', subreddit: 'r/ProjectManagement', postId: 't3_abc', agent: 'Maya' }),
    ).toEqual({
      utm_source: 'reddit',
      utm_medium: 'comment',
      utm_campaign: 'projectmanagement',
      utm_content: 't3_abc',
      utm_term: 'maya',
    });
  });
  it('keeps existing query and hash', () => {
    const out = withUtm('https://acme.com/pricing?plan=pro#top', buildUtm({ medium: 'dm' }));
    expect(out).toBe('https://acme.com/pricing?plan=pro&utm_source=reddit&utm_medium=dm#top');
  });
  it('makes 6-char base62 slugs', () => {
    for (let i = 0; i < 50; i++) expect(makeSlug()).toMatch(SLUG_RE);
  });
});
