import { describe, expect, it } from 'vitest';
import { type BrowserJob, BrowserJobSchema, browserJobId, browserQueue } from './queues';

const jobs: BrowserJob[] = [
  { kind: 'profile.start', workspaceId: 'ws', profileId: 'prof', reason: 'takeover' },
  { kind: 'profile.stop', workspaceId: 'ws', profileId: 'prof', reason: 'idle' },
  { kind: 'action.submitComment', workspaceId: 'ws', profileId: 'prof', draftId: 'draft' },
  { kind: 'action.sendDm', workspaceId: 'ws', profileId: 'prof', draftId: 'draft' },
  { kind: 'profile.testProxy', workspaceId: 'ws', profileId: 'prof' },
  { kind: 'profile.whoami', workspaceId: 'ws', profileId: 'prof' },
  { kind: 'health.check', workspaceId: 'ws' },
  { kind: 'profile.remove', workspaceId: 'ws', profileId: 'prof', after: 'purge' },
];

describe('browser queues', () => {
  it('names one queue per node', () => {
    const q: 'browser.browser-1' = browserQueue('browser-1');
    expect(q).toBe('browser.browser-1');
  });

  it('job ids follow bj-<kind>-<draftId|profileId> with no colons', () => {
    expect(jobs.map((j) => browserJobId(j))).toEqual([
      'bj-profile.start-prof',
      'bj-profile.stop-prof',
      'bj-action.submitComment-draft',
      'bj-action.sendDm-draft',
      'bj-profile.testProxy-prof',
      'bj-profile.whoami-prof',
      'bj-health.check-ws',
      'bj-profile.remove-prof',
    ]);
    expect(browserJobId(jobs[6]!, '202611071200')).toBe('bj-health.check-ws-202611071200');
    expect(() => browserJobId({ kind: 'health.check', workspaceId: 'a:b' })).toThrow();
  });

  it('job payloads round-trip through JSON and the schema', () => {
    for (const j of jobs) expect(BrowserJobSchema.parse(JSON.parse(JSON.stringify(j)))).toEqual(j);
  });

  it('job payloads refuse extra keys, so secrets cannot ride along', () => {
    expect(
      BrowserJobSchema.safeParse({
        kind: 'profile.testProxy',
        workspaceId: 'ws',
        profileId: 'p',
        password: 'x',
      }).success,
    ).toBe(false);
    expect(
      BrowserJobSchema.safeParse({ kind: 'profile.whoami', workspaceId: 'ws', profileId: 'p', cookie: 'x' })
        .success,
    ).toBe(false);
    expect(
      BrowserJobSchema.safeParse({ kind: 'profile.start', workspaceId: 'ws', profileId: 'p' }).success,
    ).toBe(false);
  });
});
