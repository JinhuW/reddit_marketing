import { CloseCode, SUBPROTOCOL } from '@threadline/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type Agent, startAgent } from './agent';
import { backoffDelay } from './client';
import { SecretSet, createLogger } from './log';
import type { AgentModule } from './registry';
import { FakeGateway, type FakeGatewayOptions } from './testing/fake-gateway';
import { TEST_LICENSE, TEST_TOKEN, captureStream, sleep, testConfig } from './testing/helpers';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (cleanup.length) await cleanup.pop()!();
});

async function setup(opts: { gateway?: FakeGatewayOptions; modules?: AgentModule[] } = {}) {
  const gw = await FakeGateway.start(opts.gateway);
  const cap = captureStream();
  const secrets = new SecretSet();
  const agent: Agent = await startAgent({
    config: testConfig(gw.url),
    modules: opts.modules,
    secrets,
    log: createLogger({ level: 'debug', secrets, destination: cap.stream }),
    backoff: { minMs: 10, maxMs: 40 },
  });
  cleanup.push(
    () => gw.close(),
    () => agent.stop(),
  );
  return { gw, agent, cap };
}

const dm = {
  kind: 'action.sendDm',
  profileId: 'p1',
  draftId: 'd1',
  to: 'u',
  subject: 's',
  body: 'b',
} as const;

describe('backoffDelay', () => {
  it('stays within 1–30 s and grows with attempts', () => {
    expect(backoffDelay(0, undefined, () => 0)).toBe(1_000);
    expect(backoffDelay(0, undefined, () => 1)).toBe(1_000);
    expect(backoffDelay(2, undefined, () => 1)).toBe(4_000);
    expect(backoffDelay(50, undefined, () => 1)).toBe(30_000);
    for (let a = 0; a < 40; a++) {
      const d = backoffDelay(a);
      expect(d).toBeGreaterThanOrEqual(1_000);
      expect(d).toBeLessThanOrEqual(30_000);
    }
  });
});

describe('GatewayClient', () => {
  it('dials with subprotocol, bearer token and node name, then says hello', async () => {
    const { gw, agent } = await setup();
    await gw.waitFor(() => agent.client.ready);
    const c = gw.last;
    expect(c.protocol).toBe(SUBPROTOCOL);
    expect(c.headers.authorization).toBe(`Bearer ${TEST_TOKEN}`);
    expect(c.headers['x-node-name']).toBe('browser-1');
    expect(c.frames[0]).toEqual({
      type: 'hello',
      node: 'browser-1',
      agentVersion: '0.1.0',
      imageDigest: null,
      maxProfiles: 8,
      seats: { inUse: 0, limit: null },
      running: [],
    });
  });

  it('heartbeats every heartbeatSec', async () => {
    const { gw } = await setup({ gateway: { heartbeatSec: 1 } });
    const beats = await gw.waitFor(() => {
      const hb = gw.allFrames('heartbeat');
      return hb.length >= 2 && hb;
    }, 3_500);
    expect(beats[0]).toMatchObject({ type: 'heartbeat', running: [], seats: { inUse: 0, limit: null } });
  });

  it('reconnects after the gateway drops the socket', async () => {
    const { gw, agent } = await setup();
    await gw.waitFor(() => agent.client.connections === 1);
    gw.last.ws.terminate();
    await gw.waitFor(() => agent.client.connections === 2);
    expect(gw.conns).toHaveLength(2);
    expect(gw.frames(gw.last, 'hello')).toHaveLength(1);
  });

  it('keeps retrying when the gateway rejects the token', async () => {
    const { gw, agent } = await setup({ gateway: { autoWelcome: false } });
    await gw.waitFor(() => gw.conns.length === 1);
    gw.last.ws.close(CloseCode.badToken, 'bad token');
    await gw.waitFor(() => gw.conns.length >= 2);
    expect(agent.client.lastClose?.code).toBe(CloseCode.badToken);
  });

  it('a command interrupted by a disconnect runs once and its result is replayed after reconnect', async () => {
    let runs = 0;
    const actions: AgentModule = {
      name: 'test-actions',
      handlers: {
        'action.sendDm': async () => {
          runs++;
          await sleep(200);
          return { outcome: 'posted', data: { fullname: 't4_dm1' } };
        },
      },
    };
    const { gw, agent } = await setup({ modules: [actions] });
    await gw.waitFor(() => agent.client.ready);
    const first = gw.last;
    gw.command(first, 'bj-action.sendDm-d1', dm);
    await gw.waitFor(() => gw.frames(first, 'ack').length === 1);
    first.ws.terminate(); // drop mid-command, before the result

    await gw.waitFor(() => agent.client.connections === 2);
    const second = gw.last;
    gw.command(second, 'bj-action.sendDm-d1', dm); // the gateway's retry, same job id
    const r1 = await gw.waitFor(() => gw.frames(second, 'result')[0]);
    expect(r1).toMatchObject({ outcome: 'posted', data: { fullname: 't4_dm1' } });

    gw.command(second, 'bj-action.sendDm-d1', dm); // and once more: pure replay
    await gw.waitFor(() => gw.frames(second, 'result').length === 2);
    expect(gw.frames(second, 'result')[1]).toEqual(r1);
    expect(runs).toBe(1);
    expect(gw.frames(first, 'result')).toHaveLength(0);
  });

  it('sends a deadline error before the deadline', async () => {
    const slow: AgentModule = {
      name: 'slow',
      handlers: {
        'health.check': async (_c, ctx) => {
          await new Promise((r) => ctx.signal.addEventListener('abort', r));
          return { outcome: 'error', error: { code: 'aborted', message: 'aborted' } };
        },
      },
    };
    const { gw, agent } = await setup({ modules: [slow] });
    await gw.waitFor(() => agent.client.ready);
    const t0 = Date.now();
    gw.command(gw.last, 'bj-health.check-1', { kind: 'health.check' }, 300);
    const r = await gw.waitFor(() => gw.frames(gw.last, 'result')[0]);
    expect(Date.now() - t0).toBeLessThan(300);
    expect(r).toMatchObject({ outcome: 'error', error: { code: 'deadline_exceeded' } });
  });

  it('closes with 4426 on a protocol version mismatch', async () => {
    const { gw } = await setup({ gateway: { protocol: 2 } });
    await gw.waitFor(() => gw.conns.length === 1);
    expect((await gw.conns[0]!.closed).code).toBe(CloseCode.protocolVersion);
  });

  it('closes with 4400 on an unknown frame type', async () => {
    const { gw, agent } = await setup();
    await gw.waitFor(() => agent.client.ready);
    gw.send(gw.last, { type: 'surprise' });
    expect((await gw.conns[0]!.closed).code).toBe(CloseCode.protocolError);
  });

  it('forwards module events to the gateway', async () => {
    let emit: ((e: { profileId: string; kind: 'container.exited' }) => void) | undefined;
    const mod: AgentModule = {
      name: 'events',
      handlers: {},
      start: (ctx) => {
        emit = (e) => ctx.emit(e);
      },
    };
    const { gw, agent } = await setup({ modules: [mod] });
    await gw.waitFor(() => agent.client.ready);
    emit!({ profileId: 'p1', kind: 'container.exited' });
    const ev = await gw.waitFor(() => gw.frames(gw.last, 'event')[0]);
    expect(ev).toEqual({ type: 'event', profileId: 'p1', kind: 'container.exited' });
  });

  it('never logs the node token, license key or proxy passwords', async () => {
    const { gw, agent, cap } = await setup();
    await gw.waitFor(() => agent.client.ready);
    gw.command(gw.last, 'bj-profile.start-p1', {
      kind: 'profile.start',
      profileId: 'p1',
      seed: 7,
      persona: 'windows',
      gpu: 'intel',
      tz: 'UTC',
      locale: 'en-US',
      screen: '1920x1080',
      proxy: {
        protocol: 'socks5',
        host: 'proxy.example',
        port: 1080,
        username: 'u',
        password: 'proxy-pw-123',
      },
    });
    await gw.waitFor(() => gw.frames(gw.last, 'result')[0]);
    agent.log.info({ config: testConfig(gw.url) }, `token=${TEST_TOKEN} key=${TEST_LICENSE} pw=proxy-pw-123`);
    await sleep(20);
    const out = cap.text();
    expect(out.length).toBeGreaterThan(0);
    expect(out).not.toContain(TEST_TOKEN);
    expect(out).not.toContain(TEST_LICENSE);
    expect(out).not.toContain('proxy-pw-123');
  });
});
