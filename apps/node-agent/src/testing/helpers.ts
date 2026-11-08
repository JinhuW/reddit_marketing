import { Writable } from 'node:stream';
import { type AgentConfig, loadConfig } from '../config';

export const TEST_TOKEN = 'node-token-0123456789abcdef';
export const TEST_LICENSE = 'cloak-license-key-XYZ-9876';

export function testConfig(
  gatewayUrl = 'ws://127.0.0.1:1/agent',
  extra: NodeJS.ProcessEnv = {},
): AgentConfig {
  return loadConfig({
    GATEWAY_URL: gatewayUrl,
    NODE_NAME: 'browser-1',
    NODE_TOKEN: TEST_TOKEN,
    CLOAKBROWSER_LICENSE_KEY: TEST_LICENSE,
    LOG_LEVEL: 'silent',
    ...extra,
  });
}

/** A writable that collects pino's JSON lines. */
export function captureStream(): {
  stream: Writable;
  text: () => string;
  lines: () => Record<string, unknown>[];
} {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _enc, cb) {
      chunks.push(chunk.toString());
      cb();
    },
  });
  const text = () => chunks.join('');
  return {
    stream,
    text,
    lines: () =>
      text()
        .split('\n')
        .filter(Boolean)
        .map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
