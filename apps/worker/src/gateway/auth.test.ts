import type { IncomingMessage } from 'node:http';
import { CloseCode, SUBPROTOCOL } from '@threadline/shared';
import { describe, expect, it } from 'vitest';
import {
  type NodeRow,
  authenticate,
  checkEnvTokens,
  nodeNameFromEnv,
  pickSubprotocol,
  readCredentials,
} from './auth';

const req = (headers: Record<string, string | string[]>) => ({ headers }) as unknown as IncomingMessage;
const row = { id: 'n1', name: 'browser-1', workspaceId: 'w1' } as NodeRow;
const verify = async (name: string, token: string) =>
  name === 'browser-1' && token === 'good-token-0123456789' ? row : null;

describe('gateway auth', () => {
  it('picks tl-node.v1, keeps other tl-node versions for a 4426, and refuses the rest', () => {
    expect(pickSubprotocol(new Set(['x', SUBPROTOCOL]))).toBe(SUBPROTOCOL);
    expect(pickSubprotocol(new Set(['tl-node.v2']))).toBe('tl-node.v2');
    expect(pickSubprotocol(new Set(['chat']))).toBe(false);
  });

  it('reads the node name and bearer token', () => {
    expect(readCredentials(req({ 'x-node-name': 'browser-1', authorization: 'Bearer abc' }))).toEqual({
      name: 'browser-1',
      token: 'abc',
    });
    expect(readCredentials(req({ 'x-node-name': 'browser-1', authorization: 'Basic abc' }))).toBeNull();
    expect(readCredentials(req({ authorization: 'Bearer abc' }))).toBeNull();
    expect(readCredentials(req({ 'x-node-name': ['a', 'b'], authorization: 'Bearer abc' }))).toBeNull();
  });

  it('maps failures to close codes', async () => {
    const good = req({ 'x-node-name': 'browser-1', authorization: 'Bearer good-token-0123456789' });
    expect(await authenticate(good, SUBPROTOCOL, verify)).toEqual({ ok: true, node: row });
    expect(await authenticate(good, 'tl-node.v2', verify)).toMatchObject({
      closeCode: CloseCode.protocolVersion,
    });
    expect(await authenticate(good, '', verify)).toMatchObject({ closeCode: CloseCode.protocolVersion });
    const bad = req({ 'x-node-name': 'browser-1', authorization: 'Bearer nope-nope-nope-nope' });
    const r = await authenticate(bad, SUBPROTOCOL, verify);
    expect(r).toMatchObject({ ok: false, closeCode: CloseCode.badToken });
    expect(JSON.stringify(r)).not.toContain('nope-nope');
    expect(await authenticate(req({}), SUBPROTOCOL, verify)).toMatchObject({ closeCode: CloseCode.badToken });
  });

  it('maps NODE_TOKEN_<NAME> variables to node names', () => {
    expect(nodeNameFromEnv('NODE_TOKEN_BROWSER_1')).toBe('browser-1');
    expect(nodeNameFromEnv('NODE_TOKEN_')).toBeNull();
    expect(nodeNameFromEnv('OTHER_BROWSER_1')).toBeNull();
  });

  it('reports NODE_TOKEN_* variables that do not match the stored hash, by name only', async () => {
    const out = await checkEnvTokens(
      {
        NODE_TOKEN_BROWSER_1: 'good-token-0123456789',
        NODE_TOKEN_BROWSER_2: 'stale-token-0123456',
        PATH: '/bin',
      },
      verify,
    );
    expect(out).toEqual({ ok: ['NODE_TOKEN_BROWSER_1'], mismatched: ['NODE_TOKEN_BROWSER_2'] });
  });
});
