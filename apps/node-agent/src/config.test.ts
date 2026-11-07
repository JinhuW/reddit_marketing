import { describe, expect, it } from 'vitest';
import { ConfigError, loadConfig, secretValues } from './config';
import { TEST_LICENSE, TEST_TOKEN, testConfig } from './testing/helpers';

describe('loadConfig', () => {
  it('reads the node env with defaults', () => {
    const c = testConfig('wss://nodes.example.com/agent');
    expect(c).toMatchObject({
      gatewayUrl: 'wss://nodes.example.com/agent',
      nodeName: 'browser-1',
      browserNetwork: 'tl-browsers',
      maxProfiles: 8,
      agentVersion: '0.1.0',
    });
    expect(secretValues(c)).toEqual([TEST_TOKEN, TEST_LICENSE]);
  });

  it('appends /agent to a bare gateway origin', () => {
    expect(testConfig('wss://nodes.example.com').gatewayUrl).toBe('wss://nodes.example.com/agent');
  });

  it('coerces NODE_MAX_PROFILES and honours AGENT_VERSION', () => {
    const c = testConfig(undefined, { NODE_MAX_PROFILES: '3', AGENT_VERSION: 'sha-abc' });
    expect(c.maxProfiles).toBe(3);
    expect(c.agentVersion).toBe('sha-abc');
  });

  it('rejects bad values and never echoes them', () => {
    const bad = {
      GATEWAY_URL: 'https://nodes.example.com',
      NODE_NAME: 'Browser_1',
      NODE_TOKEN: 'short-secret',
    };
    let err: unknown;
    try {
      loadConfig(bad);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ConfigError);
    const msg = (err as Error).message;
    expect(msg).toContain('GATEWAY_URL');
    expect(msg).toContain('NODE_NAME');
    expect(msg).toContain('NODE_TOKEN');
    expect(msg).not.toContain('short-secret');
  });
});
