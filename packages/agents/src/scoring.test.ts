import { describe, expect, it } from 'vitest';
import { buildSystemPrompt } from './prompt';
import { OPPORTUNITY_THRESHOLD, levelForScore, shouldCreateOpportunity } from './scoring';

describe('scoring threshold', () => {
  it('creates opportunities at >= 60', () => {
    expect(OPPORTUNITY_THRESHOLD).toBe(60);
    expect(shouldCreateOpportunity(59)).toBe(false);
    expect(shouldCreateOpportunity(60)).toBe(true);
  });
  it('maps levels', () => {
    expect(levelForScore(94)).toBe('high');
    expect(levelForScore(72)).toBe('medium');
    expect(levelForScore(40)).toBe('low');
  });
});

describe('prompt builder', () => {
  it('always includes the disclosure and the link rule', () => {
    const p = buildSystemPrompt({
      agentName: 'Maya',
      roleTitle: 'Product Expert',
      product: 'Acme',
      persona: { voice: { concise: 80 }, dos: ['Lead with the answer'], donts: ['No hype'] },
      disclosureLine: 'Disclosure: I work on Acme',
      skill: 'compare_answer',
      subreddit: { name: 'SaaS', linkRule: 'none' },
    });
    expect(p).toContain('"Disclosure: I work on Acme"');
    expect(p).toContain('No links in comments');
    expect(p).toContain('Short: three to five sentences');
    expect(p).toContain('- Lead with the answer');
  });
});
