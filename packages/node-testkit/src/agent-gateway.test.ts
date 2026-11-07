import { CloseCode, type Cmd, HEARTBEAT_SEC, PROTOCOL_VERSION } from '@threadline/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AgentClosedError, FakeAgent, type FakeAgentOptions } from './fake-agent';
import { FakeGateway, FakeGatewayError } from './fake-gateway';

const NODE = 'browser-1';
const TOKEN = 'node-token-1';

const submit: Cmd = {
  kind: 'action.submitComment',
  profileId: 'prof_1',
  draftId: 'draft_1',
  threadUrl: 'http://127.0.0.1/r/testkit_sandbox/comments/1abc2de/x/',
  parentFullname: 't3_1abc2de',
  body: 'hello',
};

let gw: FakeGateway;
const agents: FakeAgent[] = [];

function agent(over: Partial<FakeAgentOptions> = {}): FakeAgent {
  const a = new FakeAgent({ url: gw.url, node: NODE, token: TOKEN, heartbeat: false, ...over });
  agents.push(a);
  return a;
}

beforeEach(async () => {
  gw = await FakeGateway.start({ tokens: { [NODE]: TOKEN, 'browser-2': 'node-token-2' } });
});

afterEach(async () => {
  await Promise.all(agents.splice(0).map((a) => a.close()));
  await gw.close();
});

describe('handshake', () => {
  it('sends hello with the real headers and receives welcome', async () => {
    const a = agent({ maxProfiles: 5, imageDigest: 'sha256:abc', seats: { inUse: 1, limit: 5 } });
    const welcome = await a.connect();
    expect(welcome).toMatchObject({
      type: 'welcome',
      heartbeatSec: HEARTBEAT_SEC,
      protocol: PROTOCOL_VERSION,
    });
    const conn = await gw.waitForAgent(NODE);
    expect(conn.hello).toMatchObject({
      node: NODE,
      maxProfiles: 5,
      imageDigest: 'sha256:abc',
      seats: { inUse: 1, limit: 5 },
    });
    expect(gw.isConnected(NODE)).toBe(true);
    expect(a.connected).toBe(true);
  });

  it('accepts a URL that already ends in /agent', async () => {
    await agent({ url: gw.agentUrl }).connect();
    expect(gw.isConnected(NODE)).toBe(true);
  });

  it('refuses a bad token with 4401', async () => {
    const err = await agent({ token: 'wrong' })
      .connect()
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AgentClosedError);
    expect((err as AgentClosedError).code).toBe(CloseCode.badToken);
    expect(gw.rejected.items).toEqual([expect.objectContaining({ node: NODE, code: CloseCode.badToken })]);
  });

  it("refuses another node's token with 4401", async () => {
    const err = await agent({ node: 'browser-2', token: TOKEN })
      .connect()
      .catch((e: unknown) => e);
    expect((err as AgentClosedError).code).toBe(CloseCode.badToken);
  });

  it('refuses a second connection for the same node with 4409', async () => {
    await agent().connect();
    const err = await agent()
      .connect()
      .catch((e: unknown) => e);
    expect((err as AgentClosedError).code).toBe(CloseCode.duplicateNode);
    expect(gw.isConnected(NODE)).toBe(true);
  });

  it('refuses a client without the tl-node.v1 subprotocol with 4426', async () => {
    const err = await agent({ subprotocol: null })
      .connect()
      .catch((e: unknown) => e);
    expect((err as AgentClosedError).code).toBe(CloseCode.protocolVersion);
  });

  it('agent closes with 4426 when the gateway speaks another protocol version', async () => {
    await gw.close();
    gw = await FakeGateway.start({ welcome: { protocol: PROTOCOL_VERSION + 1 } });
    const err = await agent()
      .connect()
      .catch((e: unknown) => e);
    expect((err as AgentClosedError).code).toBe(CloseCode.protocolVersion);
  });

  it('rejectNext closes the next connection with the given code', async () => {
    gw.rejectNext(CloseCode.badToken, 'scripted');
    const err = await agent()
      .connect()
      .catch((e: unknown) => e);
    expect(err).toMatchObject({ code: CloseCode.badToken, reason: 'scripted' });
    await agent().connect();
  });
});

describe('commands', () => {
  it('answers ok by default and acks before the result', async () => {
    await agent().connect();
    const result = await gw.send(NODE, { kind: 'health.check' }, { cmdId: 'bj-health.check-1' });
    expect(result).toEqual({ type: 'result', cmdId: 'bj-health.check-1', outcome: 'ok' });
    const types = gw.received.items.map((f) => f.msg.type);
    expect(types).toEqual(['hello', 'ack', 'result']);
  });

  it('answers with the scripted result per kind, static or computed', async () => {
    const a = agent({
      script: {
        'profile.testProxy': { outcome: 'ok', data: { pageIp: '203.0.113.10', agentIp: '203.0.113.10' } },
        'action.submitComment': (cmd) => ({ outcome: 'posted', data: { fullname: `t1_for_${cmd.draftId}` } }),
      },
    });
    await a.connect();
    await expect(gw.send(NODE, { kind: 'profile.testProxy', profileId: 'prof_1' })).resolves.toMatchObject({
      outcome: 'ok',
      data: { pageIp: '203.0.113.10' },
    });
    await expect(gw.send(NODE, submit)).resolves.toMatchObject({
      outcome: 'posted',
      data: { fullname: 't1_for_draft_1' },
    });
    expect(a.commands.items.map((c) => c.cmd.kind)).toEqual(['profile.testProxy', 'action.submitComment']);
  });

  it('one-shot steps take precedence, then the standing script resumes', async () => {
    const a = agent({ script: { 'action.sendDm': { outcome: 'posted', data: { fullname: 't4_1' } } } });
    a.next('action.sendDm', { outcome: 'needs_human', error: { code: 'verification', message: 'wall' } });
    await a.connect();
    const dm: Cmd = { kind: 'action.sendDm', profileId: 'p', draftId: 'd', to: 'u', subject: 's', body: 'b' };
    expect((await gw.send(NODE, dm)).outcome).toBe('needs_human');
    expect((await gw.send(NODE, dm)).outcome).toBe('posted');
  });

  it('a script that throws answers error/script_error', async () => {
    agent({
      script: {
        'health.check': () => {
          throw new Error('boom');
        },
      },
    });
    await agents[0]!.connect();
    await expect(gw.send(NODE, { kind: 'health.check' })).resolves.toMatchObject({
      outcome: 'error',
      error: { code: 'script_error', message: 'boom' },
    });
  });

  it('delays the result on cue', async () => {
    await agent({ script: { 'health.check': { delayMs: 100, result: { outcome: 'ok' } } } }).connect();
    const t0 = Date.now();
    await gw.send(NODE, { kind: 'health.check' });
    expect(Date.now() - t0).toBeGreaterThanOrEqual(90);
  });

  it('a silent agent makes the gateway fail with NodeTimeout after the deadline', async () => {
    await agent({ script: { 'health.check': { silent: true } } }).connect();
    const err = await gw.send(NODE, { kind: 'health.check' }, { deadlineMs: 150 }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FakeGatewayError);
    expect((err as FakeGatewayError).code).toBe('NodeTimeout');
    expect(gw.frames(NODE, 'ack')).toHaveLength(1);
  });

  it('can skip acks entirely', async () => {
    await agent({ ack: false }).connect();
    await gw.send(NODE, { kind: 'health.check' });
    expect(gw.frames(NODE, 'ack')).toHaveLength(0);
  });

  it('send to a node that is not connected fails with NodeDisconnected', async () => {
    await expect(gw.send(NODE, { kind: 'health.check' })).rejects.toMatchObject({ code: 'NodeDisconnected' });
  });
});

describe('drops, reconnect and replay', () => {
  it('drop before ack: the gateway sees no ack and fails NodeDisconnected', async () => {
    const a = agent();
    a.dropOn('health.check', 'beforeAck');
    await a.connect();
    await expect(gw.send(NODE, { kind: 'health.check' })).rejects.toMatchObject({ code: 'NodeDisconnected' });
    expect(gw.frames(NODE, 'ack')).toHaveLength(0);
    expect((await a.closes.waitFor()).code).toBe(1006);
  });

  it('drop after ack: the command did not run, so a retry runs it', async () => {
    let runs = 0;
    const a = agent({
      script: {
        'action.submitComment': () => {
          runs += 1;
          return { outcome: 'posted', data: { fullname: 't1_new' } };
        },
      },
    });
    a.dropOn('action.submitComment');
    await a.connect();
    await expect(gw.send(NODE, submit, { cmdId: 'bj-action.submitComment-draft_1' })).rejects.toMatchObject({
      code: 'NodeDisconnected',
    });
    expect(runs).toBe(0);

    const from = gw.connections.items.length;
    await a.connect();
    await gw.waitForAgent(NODE, { from });
    expect(gw.connectCount(NODE)).toBe(2);
    const r = await gw.send(NODE, submit, { cmdId: 'bj-action.submitComment-draft_1' });
    expect(r.outcome).toBe('posted');
    expect(runs).toBe(1);
    expect(a.replays.items).toEqual([]);
  });

  it('drop after run: a retry with the same cmdId is replayed, never re-run', async () => {
    let runs = 0;
    const a = agent({
      script: {
        'action.submitComment': () => {
          runs += 1;
          return { outcome: 'posted', data: { fullname: 't1_should_not_appear' } };
        },
      },
    });
    a.dropOn('action.submitComment', 'afterRun', { outcome: 'posted', data: { fullname: 't1_posted_once' } });
    await a.connect();
    const cmdId = 'bj-action.submitComment-draft_1';
    await expect(gw.send(NODE, submit, { cmdId })).rejects.toMatchObject({ code: 'NodeDisconnected' });

    await a.connect();
    const r = await gw.send(NODE, submit, { cmdId });
    expect(r).toMatchObject({ outcome: 'posted', data: { fullname: 't1_posted_once' } });
    expect(runs).toBe(0);
    expect(a.replays.items).toEqual([cmdId]);
    // and again: still a replay
    await gw.send(NODE, submit, { cmdId });
    expect(a.replays.items).toEqual([cmdId, cmdId]);
  });

  it('gateway-side terminate is seen by the agent as 1006 and pending sends fail', async () => {
    const a = agent({ script: { 'health.check': { silent: true } } });
    await a.connect();
    const pending = gw.send(NODE, { kind: 'health.check' });
    await a.waitForCommand('health.check');
    gw.terminate(NODE);
    await expect(pending).rejects.toMatchObject({ code: 'NodeDisconnected' });
    expect((await a.closes.waitFor()).code).toBe(1006);
  });

  it('gateway-side disconnect sends a close code', async () => {
    const a = agent();
    await a.connect();
    const closed = a.waitForClose();
    gw.disconnect(NODE, 4000, 'bye');
    expect(await closed).toEqual({ code: 4000, reason: 'bye' });
  });
});

describe('heartbeats, events and protocol errors', () => {
  it('sends heartbeats on the configured interval with running profiles and seats', async () => {
    const a = agent({ heartbeat: 30, running: [{ profileId: 'p1', startedAt: 1 }] });
    a.setSeats({ inUse: 1, limit: 5 });
    await a.connect();
    const hb = await gw.waitForFrame(NODE, 'heartbeat');
    expect(hb).toMatchObject({ running: [{ profileId: 'p1', startedAt: 1 }], seats: { inUse: 1, limit: 5 } });
  });

  it('forwards node events', async () => {
    const a = agent();
    await a.connect();
    a.sendEvent('p1', 'needs_human', { wall: 'verification' });
    await expect(gw.waitForFrame(NODE, 'event')).resolves.toMatchObject({
      profileId: 'p1',
      kind: 'needs_human',
      detail: { wall: 'verification' },
    });
  });

  it('the gateway closes with 4400 on an off-contract frame from the agent', async () => {
    const a = agent();
    await a.connect();
    const closed = a.waitForClose();
    a.sendRaw(JSON.stringify({ type: 'nope' }));
    expect((await closed).code).toBe(CloseCode.protocolError);
    expect(gw.rejected.items.at(-1)?.code).toBe(CloseCode.protocolError);
  });

  it('the agent closes with 4400 on an off-contract frame from the gateway', async () => {
    const a = agent();
    await a.connect();
    const conn = await gw.waitForAgent(NODE);
    gw.sendRaw(NODE, '{"type":"command","cmdId":"x"}');
    expect((await conn.closed).code).toBe(CloseCode.protocolError);
    expect(a.connected).toBe(false);
  });
});
