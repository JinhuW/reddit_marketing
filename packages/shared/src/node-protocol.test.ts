import { describe, expect, it } from 'vitest';
import {
  type AgentMessage,
  CloseCode,
  Cmd,
  type Command,
  type GatewayMessage,
  HealthData,
  PostedData,
  TestProxyData,
  WhoamiData,
  encodeAgentMessage,
  encodeGatewayMessage,
  nodeTokenEnvName,
  parseAgentMessage,
  parseGatewayMessage,
} from './node-protocol';

const running = [{ profileId: 'prof_1', startedAt: 1_762_500_000_000 }];
const seats = { inUse: 1, limit: 5 };

const agentMessages: AgentMessage[] = [
  {
    type: 'hello',
    node: 'browser-1',
    agentVersion: '0.1.0',
    imageDigest: 'sha256:abc',
    maxProfiles: 8,
    seats,
    running,
  },
  {
    type: 'hello',
    node: 'browser-2',
    agentVersion: '0.1.0',
    imageDigest: null,
    maxProfiles: 1,
    seats: { inUse: 0, limit: null },
    running: [],
  },
  { type: 'heartbeat', ts: 1_762_500_015_000, running, seats },
  { type: 'ack', cmdId: 'bj-action.submitComment-draft_1' },
  {
    type: 'result',
    cmdId: 'bj-action.submitComment-draft_1',
    outcome: 'posted',
    data: { fullname: 't1_abc' },
  },
  { type: 'result', cmdId: 'c2', outcome: 'error', error: { code: 'not_implemented', message: 'stub' } },
  { type: 'result', cmdId: 'c3', outcome: 'license_denied' },
  { type: 'result', cmdId: 'bj-profile.whoami-prof_1', outcome: 'ok', data: { loggedIn: false } },
  {
    type: 'result',
    cmdId: 'bj-profile.whoami-prof_2',
    outcome: 'ok',
    data: { loggedIn: true, name: 'jane_from_acme', id: '1a2b3c', totalKarma: 4210, createdUtc: 1546300800 },
  },
  { type: 'event', profileId: 'prof_1', kind: 'container.exited', detail: { exitCode: 78 } },
  { type: 'event', profileId: 'prof_1', kind: 'session.activity' },
  { type: 'event', profileId: 'prof_1', kind: 'needs_human' },
];

const cmds: Cmd[] = [
  {
    kind: 'profile.start',
    profileId: 'prof_1',
    seed: 123456,
    persona: 'windows',
    gpu: 'nvidia',
    tz: 'America/New_York',
    locale: 'en-US',
    screen: '1920x1080',
    proxy: { protocol: 'http', host: 'proxy.example', port: 22225, username: 'u', password: 'p' },
  },
  {
    kind: 'profile.start',
    profileId: 'prof_2',
    seed: 0,
    persona: 'macos',
    gpu: 'intel',
    tz: 'Europe/Berlin',
    locale: 'de-DE',
    screen: '1440x900',
    proxy: null,
  },
  { kind: 'profile.stop', profileId: 'prof_1' },
  {
    kind: 'action.submitComment',
    profileId: 'prof_1',
    draftId: 'draft_1',
    threadUrl: 'https://www.reddit.com/r/projectmanagement/comments/abc123/x/',
    parentFullname: 't3_abc123',
    body: 'Hello',
  },
  {
    kind: 'action.sendDm',
    profileId: 'prof_1',
    draftId: 'draft_2',
    to: 'ops_kat',
    subject: 'Hi',
    body: 'Hello',
  },
  { kind: 'profile.testProxy', profileId: 'prof_1' },
  {
    kind: 'vnc.open',
    profileId: 'prof_1',
    sessionId: 'sess_1',
    upstreamUrl: 'wss://nodes.example.com/vnc/sess_1?t=abc',
    token: 'abc',
  },
  { kind: 'health.check' },
  { kind: 'profile.whoami', profileId: 'prof_1' },
  { kind: 'profile.signIn', profileId: 'prof_1', startUrl: 'https://www.reddit.com/' },
];

const gatewayMessages: GatewayMessage[] = [
  { type: 'welcome', serverTime: 1_762_500_000_000, heartbeatSec: 15, protocol: 1 },
  ...cmds.map((cmd, i): Command => ({ type: 'command', cmdId: `cmd-${i}`, deadlineMs: 60_000, cmd })),
];

describe('node protocol round-trips', () => {
  for (const m of agentMessages) {
    it(`agent → gateway: ${m.type}${'kind' in m ? ` ${m.kind}` : ''}${'outcome' in m ? ` ${m.outcome}` : ''}`, () => {
      const wire = encodeAgentMessage(m);
      const back = parseAgentMessage(wire);
      expect(back).toEqual({ ok: true, msg: m });
      // also from a Buffer, as `ws` delivers it
      expect(parseAgentMessage(Buffer.from(wire))).toEqual({ ok: true, msg: m });
    });
  }
  for (const m of gatewayMessages) {
    it(`gateway → agent: ${m.type}${m.type === 'command' ? ` ${m.cmd.kind}` : ''}`, () => {
      const wire = encodeGatewayMessage(m);
      expect(parseGatewayMessage(wire)).toEqual({ ok: true, msg: m });
      expect(parseGatewayMessage([Buffer.from(wire.slice(0, 5)), Buffer.from(wire.slice(5))])).toEqual({
        ok: true,
        msg: m,
      });
    });
  }

  it('covers every Cmd kind', () => {
    const kinds = new Set(cmds.map((c) => c.kind));
    expect([...kinds].sort()).toEqual(Cmd.options.map((o) => o.shape.kind.value).sort());
  });

  it('result data payloads round-trip', () => {
    for (const [schema, v] of [
      [TestProxyData, { pageIp: '73.218.44.19', agentIp: '73.218.44.19' }],
      [HealthData, { running, seats, docker: 'ok' }],
      [PostedData, { fullname: 't1_abc' }],
      [WhoamiData, { loggedIn: false }],
      [WhoamiData, { loggedIn: true, name: 'jane_from_acme', id: '1a2b3c' }],
      [WhoamiData, { loggedIn: true, name: 'Leo-B', id: 'k9', totalKarma: -3, createdUtc: 1546300800.5 }],
    ] as const) {
      expect(schema.parse(JSON.parse(JSON.stringify(v)))).toEqual(v);
    }
  });

  it('whoami data refuses malformed or oversharing payloads', () => {
    for (const bad of [
      {},
      { loggedIn: true },
      { loggedIn: true, name: 'jane', id: 't2_1a2b3c' },
      { loggedIn: true, name: 'has space', id: '1a2b3c' },
      { loggedIn: true, name: 'jane', id: '1a2b3c', totalKarma: 1.5 },
      { loggedIn: true, name: 'jane', id: '1a2b3c', createdUtc: -1 },
      // extra keys (e.g. the rest of me.json, or a cookie) are refused, not passed through
      { loggedIn: true, name: 'jane', id: '1a2b3c', modhash: 'abc' },
      { loggedIn: false, name: 'jane' },
    ]) {
      expect(WhoamiData.safeParse(bad).success).toBe(false);
    }
  });
});

describe('node protocol rejects', () => {
  const bad: [string, unknown][] = [
    ['unknown type', JSON.stringify({ type: 'bogus' })],
    ['missing type', JSON.stringify({ cmdId: 'x' })],
    ['not JSON', '{nope'],
    ['binary garbage', Buffer.from([0xff, 0xfe, 0x00])],
    ['bad outcome', JSON.stringify({ type: 'result', cmdId: 'x', outcome: 'maybe' })],
    ['bad event kind', JSON.stringify({ type: 'event', profileId: 'p', kind: 'reboot' })],
    ['bad node name', JSON.stringify({ ...agentMessages[0], node: 'Browser 1' })],
    [
      'negative seats',
      JSON.stringify({ type: 'heartbeat', ts: 1, running: [], seats: { inUse: -1, limit: null } }),
    ],
    ['gateway frame sent by agent', JSON.stringify(gatewayMessages[0])],
  ];
  for (const [name, raw] of bad) {
    it(`agent frame: ${name} → 4400`, () => {
      const r = parseAgentMessage(raw);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.closeCode).toBe(CloseCode.protocolError);
    });
  }

  it('gateway frame: unknown command kind → 4400', () => {
    const r = parseGatewayMessage(
      JSON.stringify({ type: 'command', cmdId: 'c', deadlineMs: 1000, cmd: { kind: 'shell.exec' } }),
    );
    expect(r.ok).toBe(false);
  });

  it('gateway frame: zero deadline and bad proxy port are refused', () => {
    expect(
      parseGatewayMessage(
        JSON.stringify({ type: 'command', cmdId: 'c', deadlineMs: 0, cmd: { kind: 'health.check' } }),
      ).ok,
    ).toBe(false);
    const start = { ...cmds[0], proxy: { protocol: 'http', host: 'h', port: 70_000 } };
    expect(
      parseGatewayMessage(JSON.stringify({ type: 'command', cmdId: 'c', deadlineMs: 1000, cmd: start })).ok,
    ).toBe(false);
  });

  it('errors never echo the frame (it may carry proxy credentials)', () => {
    const secret = 'hunter2-super-secret';
    const start = {
      ...cmds[0],
      screen: 'huge',
      proxy: { protocol: 'http', host: 'h', port: 1, password: secret },
    };
    const r = parseGatewayMessage(
      JSON.stringify({ type: 'command', cmdId: 'c', deadlineMs: 1000, cmd: start }),
    );
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).not.toContain(secret);
    const r2 = parseGatewayMessage(`{"password":"${secret}"`);
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.error).not.toContain(secret);
  });

  it('encode refuses an off-contract frame', () => {
    expect(() => encodeAgentMessage({ type: 'ack' } as unknown as AgentMessage)).toThrow();
  });
});

describe('nodeTokenEnvName', () => {
  it('maps node names to gateway env vars', () => {
    expect(nodeTokenEnvName('browser-1')).toBe('NODE_TOKEN_BROWSER_1');
    expect(() => nodeTokenEnvName('Browser 1')).toThrow();
  });
});
