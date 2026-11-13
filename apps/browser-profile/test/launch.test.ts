import { mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  CLOAK_FLAGS,
  ConfigError,
  EXIT,
  browserArgs,
  browserEnv,
  checkFingerprintLock,
  containerExitCode,
  looksLikeLicenseFailure,
  parseEnv,
  posixToBcp47,
  proxyServerFlag,
  redact,
  staleSingletonFiles,
} from '../lib/launch.mjs';

const cloakEnv = {
  CLOAKBROWSER_BINARY_PATH: '/opt/cloakbrowser/cloakbrowser',
  CLOAK_SEED: '123456',
  CLOAK_PERSONA: 'windows',
  CLOAK_GPU: 'intel',
  TZ: 'America/New_York',
  LOCALE: 'en-US',
  SCREEN: '1920x1080',
};

describe('parseEnv', () => {
  it('reads a CloakBrowser profile env', () => {
    const c = parseEnv(cloakEnv);
    expect(c).toMatchObject({
      engine: 'cloak',
      binary: '/opt/cloakbrowser/cloakbrowser',
      seed: 123456,
      persona: 'windows',
      gpu: 'intel',
      tz: 'America/New_York',
      locale: 'en-US',
      screen: { width: 1920, height: 1080 },
      proxyServer: null,
      cdpPort: 9222,
      cdpInternalPort: 9223,
      vncPort: 6080,
    });
  });

  it('refuses a CloakBrowser launch without a seed: a random seed is a new device on every start', () => {
    const { CLOAK_SEED: _, ...env } = cloakEnv;
    expect(() => parseEnv(env)).toThrow(/CLOAK_SEED is required/);
  });

  it.each([
    ['CLOAK_SEED', '-1'],
    ['CLOAK_SEED', '1.5'],
    ['CLOAK_SEED', '2147483648'],
    ['CLOAK_PERSONA', 'android'],
    ['CLOAK_GPU', 'apple'],
    ['SCREEN', 'big'],
    ['LOCALE', 'en US'],
    ['CDP_PORT', '70000'],
    ['ENGINE', 'firefox'],
  ])('rejects %s=%s', (key, value) => {
    expect(() => parseEnv({ ...cloakEnv, [key]: value })).toThrow(ConfigError);
  });

  it('needs the binary path for the cloak engine', () => {
    const { CLOAKBROWSER_BINARY_PATH: _, ...env } = cloakEnv;
    expect(() => parseEnv(env)).toThrow(/CLOAKBROWSER_BINARY_PATH/);
  });

  it('allows the stock chromium engine without a seed', () => {
    const c = parseEnv({ ENGINE: 'chromium' });
    expect(c).toMatchObject({
      engine: 'chromium',
      binary: '/usr/bin/chromium',
      seed: null,
      persona: 'windows',
    });
  });

  it('derives the locale from LANG when LOCALE is unset', () => {
    const { LOCALE: _, ...env } = cloakEnv;
    expect(parseEnv({ ...env, LANG: 'de_DE.UTF-8' }).locale).toBe('de-DE');
    expect(posixToBcp47('en_US.UTF-8@euro')).toBe('en-US');
  });

  it('collects every secret value for redaction, including the proxy password', () => {
    const c = parseEnv({
      ...cloakEnv,
      CLOAKBROWSER_LICENSE_KEY: 'lic-abcdef',
      PROXY_URL: 'http://user:p%40ss-word@proxy.example:8000',
    });
    expect(c.secrets).toContain('lic-abcdef');
    expect(c.secrets).toContain('p@ss-word');
    expect(c.proxyServer).toBe('http://proxy.example:8000');
  });

  it('parses a custom license exit code list', () => {
    expect(parseEnv({ ...cloakEnv, CLOAK_LICENSE_EXIT_CODES: '3, 9' }).licenseExitCodes).toEqual([3, 9]);
  });
});

describe('proxyServerFlag', () => {
  it('drops credentials so they never reach argv', () => {
    expect(proxyServerFlag('socks5://u:secret@10.0.0.1:1080')).toBe('socks5://10.0.0.1:1080');
  });
  it('rejects unknown schemes and missing ports', () => {
    expect(() => proxyServerFlag('ftp://h:21')).toThrow(ConfigError);
    expect(() => proxyServerFlag('http://h')).toThrow(ConfigError);
    expect(() => proxyServerFlag('not a url')).toThrow(ConfigError);
  });
});

describe('browserArgs', () => {
  it('passes the seed, persona and GPU, CDP on loopback, and no UA or viewport override', () => {
    const args = browserArgs(parseEnv(cloakEnv));
    expect(args).toContain(`${CLOAK_FLAGS.seed}=123456`);
    expect(args).toContain(`${CLOAK_FLAGS.platform}=windows`);
    expect(args).toContain(`${CLOAK_FLAGS.gpuVendor}=intel`);
    expect(args).toContain('--remote-debugging-address=127.0.0.1');
    expect(args).toContain('--remote-debugging-port=9223');
    expect(args).toContain('--lang=en-US');
    expect(args).toContain('--window-size=1920,1080');
    expect(args.some((a) => a.startsWith('--user-agent'))).toBe(false);
    expect(args.some((a) => /headless/.test(a))).toBe(false);
    expect(args.some((a) => a.startsWith('--proxy-server'))).toBe(false);
  });

  it('adds the proxy without credentials and keeps WebRTC on it', () => {
    const args = browserArgs(parseEnv({ ...cloakEnv, PROXY_URL: 'http://u:pw@p.example:9000' }));
    expect(args).toContain('--proxy-server=http://p.example:9000');
    expect(args).toContain('--force-webrtc-ip-handling-policy=disable_non_proxied_udp');
    expect(args.join(' ')).not.toContain('pw');
  });

  it('keeps the Chromium sandbox unless BROWSER_SANDBOX=off', () => {
    expect(browserArgs(parseEnv(cloakEnv))).not.toContain('--no-sandbox');
    expect(browserArgs(parseEnv({ ...cloakEnv, BROWSER_SANDBOX: 'off' }))).toContain('--no-sandbox');
    expect(() => parseEnv({ ...cloakEnv, BROWSER_SANDBOX: 'maybe' })).toThrow(ConfigError);
  });

  it('sends optional fingerprint settings only when they are set (plan 0004)', () => {
    const plain = browserArgs(parseEnv(cloakEnv));
    for (const f of [CLOAK_FLAGS.cpu, CLOAK_FLAGS.memory, CLOAK_FLAGS.noise, CLOAK_FLAGS.webrtcIp])
      expect(plain.some((a) => a.startsWith(f))).toBe(false);
    const args = browserArgs(parseEnv({ ...cloakEnv, FP_CPU: '8', FP_MEMORY_GB: '4', FP_NOISE: 'off' }));
    expect(args).toContain('--fingerprint-hardware-concurrency=8');
    expect(args).toContain('--fingerprint-device-memory=4');
    expect(args).toContain('--fingerprint-noise=false');
    expect(() => parseEnv({ ...cloakEnv, FP_CPU: '0' })).toThrow(ConfigError);
    expect(() => parseEnv({ ...cloakEnv, FP_MEMORY_GB: 'lots' })).toThrow(ConfigError);
  });

  it('WebRTC: replace reports the proxy exit IP; real never applies behind a proxy', () => {
    const proxied = { ...cloakEnv, PROXY_URL: 'http://p.example:9000' };
    const policy = '--force-webrtc-ip-handling-policy=disable_non_proxied_udp';
    const replace = browserArgs(parseEnv({ ...proxied, FP_WEBRTC: 'replace', FP_WEBRTC_IP: '203.0.113.9' }));
    expect(replace).toContain('--fingerprint-webrtc-ip=203.0.113.9');
    expect(replace).not.toContain(policy);
    expect(browserArgs(parseEnv({ ...proxied, FP_WEBRTC: 'replace' }))).toContain(
      '--fingerprint-webrtc-ip=auto',
    );
    // `real` behind a proxy would leak the node's address: the policy stays.
    const real = browserArgs(parseEnv({ ...proxied, FP_WEBRTC: 'real' }));
    expect(real).toContain(policy);
    expect(real.some((a) => a.startsWith(CLOAK_FLAGS.webrtcIp))).toBe(false);
    // No proxy: nothing to protect and nothing to replace.
    const direct = browserArgs(parseEnv({ ...cloakEnv, FP_WEBRTC: 'replace', FP_WEBRTC_IP: '203.0.113.9' }));
    expect(direct.some((a) => /webrtc/.test(a))).toBe(false);
    // Stock chromium cannot replace the address, so it keeps the policy.
    expect(
      browserArgs(parseEnv({ ENGINE: 'chromium', PROXY_URL: 'http://p.example:9000', FP_WEBRTC: 'replace' })),
    ).toContain(policy);
    expect(() => parseEnv({ ...proxied, FP_WEBRTC: 'open' })).toThrow(ConfigError);
    expect(() => parseEnv({ ...proxied, FP_WEBRTC_IP: '1.2.3.4 --no-sandbox' })).toThrow(ConfigError);
  });

  it('sends no fingerprint flags to stock chromium', () => {
    const args = browserArgs(parseEnv({ ENGINE: 'chromium' }));
    expect(args.some((a) => a.startsWith('--fingerprint'))).toBe(false);
  });
});

describe('browserEnv', () => {
  it('sets TZ and LANG from the profile and passes only the license key through', () => {
    const c = parseEnv(cloakEnv);
    const env = browserEnv(c, {
      CLOAKBROWSER_LICENSE_KEY: 'k',
      PROXY_URL: 'http://u:p@h:1',
      HOME: '/home/browser',
    });
    expect(env).toMatchObject({ TZ: 'America/New_York', LANG: 'en_US.UTF-8', DISPLAY: ':99' });
    expect(env.CLOAKBROWSER_LICENSE_KEY).toBe('k');
    expect(env).not.toHaveProperty('PROXY_URL');
  });
});

describe('license failure', () => {
  it.each([
    'License denied: key revoked',
    'ERROR license check failed (unreachable)',
    'cloakbrowser: licence expired',
    'Seat limit reached for this key',
    'no free seats available',
  ])('recognises %j', (line) => {
    expect(looksLikeLicenseFailure(line)).toBe(true);
  });

  it.each(['DevTools listening on ws://127.0.0.1:9223', 'Fontconfig warning: ignoring license.conf'])(
    'ignores %j',
    (line) => {
      expect(looksLikeLicenseFailure(line)).toBe(false);
    },
  );

  const codes = [76, 77, 78, 79];
  it('maps license exit codes and license output to 78', () => {
    expect(
      containerExitCode({ code: 77, signal: null, licenseSignalSeen: false, stopping: false }, codes),
    ).toBe(EXIT.licenseDenied);
    expect(
      containerExitCode({ code: 1, signal: null, licenseSignalSeen: true, stopping: false }, codes),
    ).toBe(78);
    expect(containerExitCode({ code: 78, signal: null, licenseSignalSeen: false, stopping: false }, [])).toBe(
      78,
    );
  });

  it('keeps other crashes distinct from license_denied', () => {
    expect(
      containerExitCode({ code: 139, signal: null, licenseSignalSeen: false, stopping: false }, codes),
    ).toBe(139);
    expect(
      containerExitCode({ code: 0, signal: null, licenseSignalSeen: false, stopping: false }, codes),
    ).toBe(1);
    expect(
      containerExitCode({ code: null, signal: 'SIGKILL', licenseSignalSeen: false, stopping: false }, codes),
    ).toBe(1);
  });

  it('exits 0 when the container is being stopped', () => {
    expect(
      containerExitCode({ code: 77, signal: null, licenseSignalSeen: true, stopping: true }, codes),
    ).toBe(0);
  });
});

describe('fingerprint lock', () => {
  const c = parseEnv(cloakEnv);
  it('writes the lock on the first launch', () => {
    expect(checkFingerprintLock(null, c)).toEqual({ ok: true, write: true });
  });
  it('accepts the same fingerprint', () => {
    expect(checkFingerprintLock({ seed: 123456, persona: 'windows', gpu: 'intel' }, c)).toEqual({
      ok: true,
      write: false,
    });
  });
  it('refuses a different seed or GPU on the same volume', () => {
    expect(checkFingerprintLock({ seed: 1, persona: 'windows', gpu: 'intel' }, c)).toMatchObject({
      ok: false,
    });
    expect(checkFingerprintLock({ seed: 123456, persona: 'windows', gpu: 'amd' }, c)).toMatchObject({
      ok: false,
    });
  });
  it('does not lock stock chromium', () => {
    expect(checkFingerprintLock(null, parseEnv({ ENGINE: 'chromium' }))).toEqual({ ok: true, write: false });
  });
});

describe('redact', () => {
  it('replaces every occurrence of every secret', () => {
    expect(redact('key=abc123 again abc123 pw=hunter2', ['abc123', 'hunter2'])).toBe(
      'key=[redacted] again [redacted] pw=[redacted]',
    );
  });
});

describe('staleSingletonFiles', () => {
  it('lists the three Chromium profile-in-use markers', () => {
    expect(staleSingletonFiles('/data/browser')).toEqual([
      '/data/browser/SingletonLock',
      '/data/browser/SingletonSocket',
      '/data/browser/SingletonCookie',
    ]);
    expect(staleSingletonFiles('/data/browser/')[0]).toBe('/data/browser/SingletonLock');
  });

  it('removes a dangling lock left by another host, and is a no-op when nothing is there', () => {
    const dir = mkdtempSync(join(tmpdir(), 'tl-profile-'));
    try {
      symlinkSync('old-container-id-42', join(dir, 'SingletonLock'));
      symlinkSync('/tmp/.org.chromium.Chromium.gone/SingletonSocket', join(dir, 'SingletonSocket'));
      symlinkSync('/tmp/.org.chromium.Chromium.gone/SingletonCookie', join(dir, 'SingletonCookie'));
      writeFileSync(join(dir, 'Local State'), '{}');
      for (const f of staleSingletonFiles(dir)) rmSync(f, { force: true });
      expect(readdirSync(dir)).toEqual(['Local State']);
      for (const f of staleSingletonFiles(dir)) rmSync(f, { force: true });
      expect(readdirSync(dir)).toEqual(['Local State']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
