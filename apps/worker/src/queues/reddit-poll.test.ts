import { describe, expect, it } from 'vitest';
import { matchKeywords } from './reddit-poll';

describe('matchKeywords', () => {
  it('matches an include term case-insensitively', () =>
    expect(matchKeywords('Looking for an ASANA alternative', ['asana alternative'], [])).toBe(
      'asana alternative',
    ));
  it('drops posts with an exclude term', () =>
    expect(
      matchKeywords('Asana alternative? Also asana jobs hiring', ['asana alternative'], ['asana jobs']),
    ).toBeNull());
  it('returns null with no match', () => expect(matchKeywords('hello', ['asana'], [])).toBeNull());
});
