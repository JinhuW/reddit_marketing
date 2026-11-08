import type { Command, Result } from '@threadline/shared';
import { afterEach, describe, expect, it } from 'vitest';
import { type Agent, startAgent } from '../agent';
import { containerSpec } from '../docker';
import { SecretSet, createLogger } from '../log';
import { FakeDocker, startCmd } from '../testing/fake-docker';
import { FakeGateway } from '../testing/fake-gateway';
import { TEST_LICENSE, sleep, testConfig } from '../testing/helpers';
import { createProfileModule, profileManager } from './profile';

const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

async function until<T>(fn: () => T | undefined, ms = 3_000): Promise<T> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const v = fn();
    if (v !== undefined) return v;
    await sleep(10);
  }
  throw new Error('timed out');
}

async function setup(docker: FakeDocker, env: NodeJS.ProcessEnv = {}) {
  const gw = await FakeGateway.start();
  const mod = createProfileModule({
    backend: () => docker,
    env,
    manager: { readyProbe: async () => true, pollMs: 5, reconcileMs: 20 },
  });
  const secrets = new SecretSet();
  const agent: Agent = await startAgent({
    config: testConfig(gw.url, { NODE_MAX_PROFILES: '4' }),
    modules: [mod],
    secrets,
    log: createLogger({ level: 'silent', secrets }),
    backoff: { minMs: 10, maxMs: 40 },
  });
  cleanup.push(
    () => gw.close(),
    () => agent.stop(),
  );
  const conn = await until(() => gw.conns[0]);
  const results = () => conn.frames.filter((f): f is Result => f.type === 'result');
  const send = (cmdId: string, cmd: Command['cmd']) =>
    gw.send(conn, { type: 'command', cmdId, deadlineMs: 10_000, cmd });
  return { gw, conn, agent, mod, results, send };
}

describe('profile module', () => {
  it('reports adopted containers in hello and serves start/stop over the gateway', async () => {
    const docker = new FakeDocker();
    const old = containerSpec(startCmd('old'), {
      image: 'i',
      network: 'n',
      nodeName: 'browser-1',
      licenseKey: undefined,
    });
    await docker.create(old);
    await docker.start(old.name);

    const { conn, results, send, agent, mod } = await setup(docker, { NODE_SEAT_LIMIT: '3' });
    const hello = await until(() => conn.frames.find((f) => f.type === 'hello'));
    expect(hello).toMatchObject({
      imageDigest: 'sha256:img1',
      maxProfiles: 4,
      seats: { inUse: 1, limit: 3 },
      running: [{ profileId: 'old', startedAt: 1_000_000 }],
    });
    expect(profileManager()).toBe(mod.manager());

    send('bj-profile.start-p1', startCmd('p1'));
    const started = await until(() => results().find((r) => r.cmdId === 'bj-profile.start-p1'));
    expect(started).toMatchObject({ outcome: 'ok', data: { profileId: 'p1', adopted: false } });
    expect(JSON.stringify(started)).not.toContain(TEST_LICENSE);
    expect(docker.containers.get('tl-profile-p1')?.spec.env.CLOAKBROWSER_LICENSE_KEY).toBe(TEST_LICENSE);
    expect(agent.status.seats()).toEqual({ inUse: 2, limit: 3 });
    expect(await agent.status.docker()).toBe('ok');

    send('bj-profile.stop-p1', { kind: 'profile.stop', profileId: 'p1' });
    const stopped = await until(() => results().find((r) => r.cmdId === 'bj-profile.stop-p1'));
    expect(stopped).toMatchObject({ outcome: 'ok', data: { profileId: 'p1', stopped: true } });
    expect(agent.status.running().map((r) => r.profileId)).toEqual(['old']);
  });

  it('sends container.exited when a profile container dies', async () => {
    const docker = new FakeDocker();
    const { conn, results, send } = await setup(docker);
    send('bj-profile.start-p2', startCmd('p2'));
    await until(() => results().find((r) => r.cmdId === 'bj-profile.start-p2'));
    docker.kill('tl-profile-p2', 139);
    const ev = await until(() => conn.frames.find((f) => f.type === 'event'));
    expect(ev).toMatchObject({
      type: 'event',
      profileId: 'p2',
      kind: 'container.exited',
      detail: { exitCode: 139, reason: 'crashed' },
    });
  });

  it('maps exit 78 to license_denied for the gateway', async () => {
    const docker = new FakeDocker();
    docker.dieWith = 78;
    const { results, send } = await setup(docker);
    send('bj-profile.start-p3', startCmd('p3'));
    const r = await until(() => results().find((x) => x.cmdId === 'bj-profile.start-p3'));
    expect(r).toMatchObject({ outcome: 'license_denied', error: { code: 'license_denied' } });
  });

  it('starts with docker down and reports docker error in health', async () => {
    const docker = new FakeDocker();
    docker.down = true;
    const { results, send, agent } = await setup(docker);
    expect(await agent.status.docker()).toBe('error');
    send('bj-profile.start-p4', startCmd('p4'));
    const r = await until(() => results().find((x) => x.cmdId === 'bj-profile.start-p4'));
    expect(r?.error?.code).toBe('docker_unavailable');
  });
});
