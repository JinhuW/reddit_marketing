import { describe, expect, it } from 'vitest';
import { REDACTED, SecretSet, createLogger } from './log';
import { TEST_LICENSE, TEST_TOKEN, captureStream } from './testing/helpers';

function setup() {
  const cap = captureStream();
  const secrets = new SecretSet([TEST_TOKEN, TEST_LICENSE]);
  const log = createLogger({ level: 'debug', secrets, destination: cap.stream });
  return { cap, secrets, log };
}

describe('log redaction', () => {
  it('censors secret keys at any of the first levels', () => {
    const { cap, log } = setup();
    log.info(
      {
        password: 'p1-secret',
        token: 'vnc-hmac-secret',
        CLOAKBROWSER_LICENSE_KEY: 'lic-secret',
        cmd: { kind: 'profile.start', proxy: { host: 'proxy.example', password: 'p2-secret' } },
        env: { CLOAKBROWSER_LICENSE_KEY: 'lic2-secret' },
        headers: { authorization: 'Bearer hdr-secret' },
      },
      'starting',
    );
    const out = cap.text();
    for (const s of [
      'p1-secret',
      'vnc-hmac-secret',
      'lic-secret',
      'p2-secret',
      'lic2-secret',
      'hdr-secret',
    ]) {
      expect(out).not.toContain(s);
    }
    const [line] = cap.lines();
    expect((line?.cmd as { proxy: { host: string; password: string } }).proxy).toEqual({
      host: 'proxy.example',
      password: REDACTED,
    });
  });

  it('scrubs known secret values from messages, fields and errors', () => {
    const { cap, log, secrets } = setup();
    secrets.add('proxy-pass-777');
    log.warn(`dial failed with token ${TEST_TOKEN}`);
    log.info({ url: 'http://u:proxy-pass-777@proxy.example:8080' }, 'proxy');
    log.error({ err: new Error(`license ${TEST_LICENSE} rejected`) }, 'boom');
    const out = cap.text();
    expect(out).not.toContain(TEST_TOKEN);
    expect(out).not.toContain(TEST_LICENSE);
    expect(out).not.toContain('proxy-pass-777');
    expect(out).toContain(REDACTED);
    expect(out).toContain('rejected');
  });

  it('ignores trivially short values', () => {
    const s = new SecretSet(['ab']);
    expect(s.size).toBe(0);
    expect(s.scrub('abc')).toBe('abc');
  });
});
