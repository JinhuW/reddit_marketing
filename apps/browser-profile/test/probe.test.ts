import { describe, expect, it } from 'vitest';
import { runArgs } from '../probe/docker.ts';
import { PAGE_SCRIPT, type Reading, parseIp } from '../probe/readings.ts';
import { evaluateRuns, formatChecks, verdict } from '../probe/report.ts';

const reading = (over: Partial<Reading> = {}): Reading => ({
  webdriver: false,
  userAgent:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36',
  platform: 'Win32',
  languages: ['en-US'],
  timezone: 'UTC',
  hardwareConcurrency: 8,
  deviceMemory: 8,
  screen: { width: 1512, height: 982, dpr: 1, colorDepth: 24 },
  clientHints: {
    brands: ['Chromium/140'],
    mobile: false,
    platform: 'Windows',
    platformVersion: '15.0.0',
    architecture: 'x86',
    model: '',
    fullVersionList: ['Chromium/140.0.7339.80'],
  },
  webgl: { vendor: 'Google Inc. (NVIDIA)', renderer: 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)' },
  canvasHash: 'aaaa',
  audioHash: 'bbbb',
  exitIp: '203.0.113.7',
  secureContext: true,
  ...over,
});

const byId = (checks: ReturnType<typeof evaluateRuns>, id: string) => checks.find((c) => c.id === id);

describe('evaluateRuns', () => {
  it('passes the T13 "Done when" for a good run', () => {
    const checks = evaluateRuns({
      persona: 'windows',
      a1: reading(),
      a2: reading(),
      b: reading({ canvasHash: 'cccc', webgl: { vendor: 'Google Inc. (Intel)', renderer: 'ANGLE (Intel)' } }),
      licenseBlockedExit: 78,
      hostIp: '198.51.100.1',
      proxied: true,
    });
    expect(checks.map((c) => [c.id, c.status])).toEqual([
      ['webdriver', 'pass'],
      ['persona', 'pass'],
      ['seed-stable', 'pass'],
      ['seed-distinct', 'pass'],
      ['exit-ip', 'pass'],
      ['license-denied', 'pass'],
    ]);
    expect(verdict(checks)).toBe('pass');
  });

  it('fails when webdriver leaks', () => {
    const checks = evaluateRuns({ persona: 'windows', a1: reading({ webdriver: true }), a2: null, b: null });
    expect(byId(checks, 'webdriver')?.status).toBe('fail');
  });

  it('fails when a restart changes the fingerprint', () => {
    const checks = evaluateRuns({
      persona: 'windows',
      a1: reading(),
      a2: reading({ audioHash: 'zzzz' }),
      b: null,
    });
    expect(byId(checks, 'seed-stable')).toMatchObject({ status: 'fail', detail: 'changed: audioHash' });
  });

  it('fails when two seeds look identical', () => {
    const checks = evaluateRuns({ persona: 'windows', a1: reading(), a2: null, b: reading() });
    expect(byId(checks, 'seed-distinct')?.status).toBe('fail');
  });

  it('flags a UA that does not match the persona, headless and software GPUs', () => {
    const checks = evaluateRuns({
      persona: 'windows',
      a1: reading({
        userAgent: 'Mozilla/5.0 (X11; Linux x86_64) HeadlessChrome/140',
        platform: 'Linux x86_64',
        webgl: { vendor: 'Google Inc.', renderer: 'ANGLE (Google, SwiftShader Device)' },
      }),
      a2: null,
      b: null,
    });
    const detail = byId(checks, 'persona')?.detail ?? '';
    expect(byId(checks, 'persona')?.status).toBe('fail');
    expect(detail).toContain('user agent is not windows');
    expect(detail).toContain('HeadlessChrome');
    expect(detail).toContain('SwiftShader');
  });

  it('flags a page with no WebGL or no client hints', () => {
    const checks = evaluateRuns({
      persona: 'windows',
      a1: reading({ webgl: null, clientHints: null }),
      a2: null,
      b: null,
    });
    expect(byId(checks, 'persona')?.detail).toContain('WebGL is unavailable');
    expect(byId(checks, 'persona')?.detail).toContain('no client hints');
  });

  it('fails when the proxied page shows the node IP', () => {
    const checks = evaluateRuns({
      persona: 'windows',
      a1: reading({ exitIp: '198.51.100.1' }),
      a2: null,
      b: null,
      hostIp: '198.51.100.1',
      proxied: true,
    });
    expect(byId(checks, 'exit-ip')?.status).toBe('fail');
  });

  it('fails unless the license-blocked container exits 78', () => {
    const run = (licenseBlockedExit: number | null) =>
      byId(
        evaluateRuns({ persona: 'windows', a1: null, a2: null, b: null, licenseBlockedExit }),
        'license-denied',
      );
    expect(run(1)?.status).toBe('fail');
    expect(run(null)).toMatchObject({
      status: 'fail',
      detail: 'container was still running at the deadline',
    });
    expect(run(78)?.status).toBe('pass');
  });

  it('fails the verdict when the probe stopped early', () => {
    const checks = evaluateRuns({ persona: 'windows', a1: null, a2: null, b: null, error: 'CDP not ready' });
    expect(verdict(checks)).toBe('fail');
    expect(formatChecks(checks)).toContain('FAIL  probe completed');
  });
});

describe('parseIp', () => {
  it('reads ipify JSON, plain text and IPv6', () => {
    expect(parseIp('{"ip":"203.0.113.7"}')).toBe('203.0.113.7');
    expect(parseIp('198.51.100.20\n')).toBe('198.51.100.20');
    expect(parseIp('{"ip":"2001:db8:85a3::8a2e:370:7334"}')).toBe('2001:db8:85a3::8a2e:370:7334');
    expect(parseIp('Current IP: 203.0.113.9.')).toBe('203.0.113.9');
    expect(parseIp('<html>blocked</html>')).toBeNull();
  });
});

describe('PAGE_SCRIPT', () => {
  it('is a single async expression that reads the signals the card lists', () => {
    expect(PAGE_SCRIPT.startsWith('(async () => {')).toBe(true);
    for (const s of ['navigator.webdriver', 'getHighEntropyValues', 'UNMASKED_RENDERER_WEBGL', 'toDataURL']) {
      expect(PAGE_SCRIPT).toContain(s);
    }
    // Parses as JavaScript.
    expect(() => new Function(`return ${PAGE_SCRIPT}`)).not.toThrow();
  });
});

describe('runArgs', () => {
  it('passes secrets by name only and publishes CDP on loopback', () => {
    const args = runArgs({
      name: 'tl-probe-a',
      volume: 'tl-probe-a',
      image: 'threadline/browser-profile:dev',
      env: { CLOAK_SEED: '1001', PROXY_URL: 'http://proxy.example:8000' },
      inheritEnv: ['CLOAKBROWSER_LICENSE_KEY'],
      publishCdp: true,
    });
    expect(args).toContain('CLOAKBROWSER_LICENSE_KEY');
    expect(args.some((a) => a.startsWith('CLOAKBROWSER_LICENSE_KEY='))).toBe(false);
    expect(args).toContain('127.0.0.1::9222');
    expect(args.at(-1)).toBe('threadline/browser-profile:dev');
  });

  it('blocks the license host with no network or host overrides', () => {
    const base = {
      name: 'n',
      volume: 'v',
      image: 'i',
      env: {},
      inheritEnv: [],
      publishCdp: false,
    };
    expect(runArgs({ ...base, network: 'none' })).toEqual(expect.arrayContaining(['--network', 'none']));
    expect(runArgs({ ...base, addHosts: ['license.example'] })).toEqual(
      expect.arrayContaining(['--add-host', 'license.example:127.0.0.1']),
    );
  });
});
