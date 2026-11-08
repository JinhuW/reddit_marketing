import { afterEach, describe, expect, it } from 'vitest';
import {
  DockerManager,
  type DockerManagerOptions,
  MEMORY_LIMIT_BYTES,
  SHM_SIZE_BYTES,
  containerSpec,
  exitResult,
  proxyUrl,
} from './docker';
import { createLogger } from './log';
import type { AgentEvent } from './registry';
import { FakeDocker, startCmd } from './testing/fake-docker';

const managers: DockerManager[] = [];
afterEach(() => {
  for (const m of managers.splice(0)) m.close();
});

function setup(over: Partial<DockerManagerOptions> & { ready?: boolean | (() => boolean) } = {}) {
  const docker = new FakeDocker();
  const events: AgentEvent[] = [];
  let now = 1_000_000;
  const ready = over.ready ?? true;
  const m = new DockerManager({
    backend: docker,
    log: createLogger({ level: 'silent' }),
    emit: (e) => events.push(e),
    nodeName: 'browser-1',
    image: 'threadline/browser-profile:test',
    network: 'tl-browsers',
    maxProfiles: 3,
    seatLimit: null,
    licenseKey: 'cloak-license-key',
    readyProbe: async () => (typeof ready === 'function' ? ready() : ready),
    readyTimeoutMs: 50,
    pollMs: 5,
    reconcileMs: 0,
    now: () => now,
    ...over,
  });
  managers.push(m);
  const signal = new AbortController().signal;
  return {
    m,
    docker,
    events,
    signal,
    advance: (ms: number) => {
      now += ms;
    },
  };
}

describe('containerSpec', () => {
  it('maps profile.start to env, labels, volume and limits, with no ports and no proxy credentials', () => {
    const spec = containerSpec(startCmd(), {
      image: 'img@sha256:abc',
      network: 'tl-browsers',
      nodeName: 'browser-1',
      licenseKey: 'lic-123',
    });
    expect(spec).toEqual({
      name: 'tl-profile-p1',
      image: 'img@sha256:abc',
      env: {
        CLOAK_SEED: '4242',
        CLOAK_PERSONA: 'windows',
        CLOAK_GPU: 'nvidia',
        TZ: 'America/New_York',
        LOCALE: 'en-US',
        SCREEN: '1920x1080',
        PROXY_URL: 'http://proxy.example:8080',
        CLOAKBROWSER_LICENSE_KEY: 'lic-123',
      },
      labels: {
        'dev.threadline.role': 'browser-profile',
        'dev.threadline.node': 'browser-1',
        'dev.threadline.profile-id': 'p1',
      },
      network: 'tl-browsers',
      volume: 'tl-profile-p1',
      shmSizeBytes: SHM_SIZE_BYTES,
      memoryBytes: MEMORY_LIMIT_BYTES,
      securityOpt: [],
    });
    expect(JSON.stringify(spec)).not.toContain('proxy-pass-1');
    expect(JSON.stringify(spec)).not.toContain('u1');
    expect(SHM_SIZE_BYTES).toBe(1073741824);
    expect(MEMORY_LIMIT_BYTES).toBe(1610612736);
  });

  it('omits PROXY_URL without a proxy and the key without a license', () => {
    const spec = containerSpec(startCmd('p2', { proxy: null }), {
      image: 'i',
      network: 'n',
      nodeName: 'browser-1',
      licenseKey: undefined,
    });
    expect(spec.env.PROXY_URL).toBeUndefined();
    expect(spec.env.CLOAKBROWSER_LICENSE_KEY).toBeUndefined();
  });

  it('formats socks5 and IPv6 proxies', () => {
    expect(proxyUrl({ protocol: 'socks5', host: '10.0.0.1', port: 1080 })).toBe('socks5://10.0.0.1:1080');
    expect(proxyUrl({ protocol: 'http', host: '::1', port: 3128 })).toBe('http://[::1]:3128');
    expect(proxyUrl(null)).toBeNull();
  });

  it('maps exit codes', () => {
    expect(exitResult(78).outcome).toBe('license_denied');
    expect(exitResult(64).error?.code).toBe('bad_config');
    expect(exitResult(1)).toMatchObject({ outcome: 'error', error: { code: 'container_exited' } });
    expect(exitResult(137, true).error?.message).toMatch(/memory/);
  });
});

describe('DockerManager', () => {
  it('starts a profile: network, volume, container, CDP ready, seats and running report', async () => {
    const { m, docker, signal } = setup();
    const r = await m.start(startCmd(), signal);
    expect(r).toMatchObject({
      outcome: 'ok',
      data: { profileId: 'p1', adopted: false, imageDigest: 'sha256:img1' },
    });
    expect(docker.networks.has('tl-browsers')).toBe(true);
    expect(docker.volumes.has('tl-profile-p1')).toBe(true);
    expect(docker.containers.get('tl-profile-p1')?.state).toBe('running');
    expect(m.seats()).toEqual({ inUse: 1, limit: null });
    expect(m.running()).toEqual([{ profileId: 'p1', startedAt: 1_000_000 }]);
    expect(m.proxyFor('p1')?.password).toBe('proxy-pass-1');
  });

  it('a second start of a running profile adopts it instead of replacing it', async () => {
    const { m, docker, signal } = setup();
    await m.start(startCmd(), signal);
    const r = await m.start(startCmd(), signal);
    expect(r).toMatchObject({ outcome: 'ok', data: { adopted: true } });
    expect(docker.calls.filter((c) => c.startsWith('create'))).toHaveLength(1);
    expect(m.seats().inUse).toBe(1);
  });

  it('concurrent starts of one profile create one container', async () => {
    const { m, docker, signal } = setup();
    const [a, b] = await Promise.all([m.start(startCmd(), signal), m.start(startCmd(), signal)]);
    expect(a.outcome).toBe('ok');
    expect(b.outcome).toBe('ok');
    expect(docker.calls.filter((c) => c.startsWith('create'))).toHaveLength(1);
  });

  it('replaces a stopped leftover container but keeps its volume', async () => {
    const { m, docker, signal } = setup();
    docker.volumes.add('tl-profile-p1');
    await docker.create(
      containerSpec(startCmd(), { image: 'x', network: 'n', nodeName: 'browser-1', licenseKey: undefined }),
    );
    docker.kill('tl-profile-p1', 0);
    const r = await m.start(startCmd(), signal);
    expect(r.outcome).toBe('ok');
    expect(docker.calls).toEqual([
      'create tl-profile-p1',
      'remove tl-profile-p1',
      'create tl-profile-p1',
      'start tl-profile-p1',
    ]);
    expect(docker.containers.get('tl-profile-p1')?.spec.image).toBe('threadline/browser-profile:test');
    expect(docker.volumes.has('tl-profile-p1')).toBe(true);
  });

  it('exit 78 during start is license_denied, the container is removed and relaunch waits 60 s', async () => {
    const { m, docker, signal, advance } = setup({ crashBackoffMs: 60_000 });
    docker.dieWith = 78;
    const r = await m.start(startCmd(), signal);
    expect(r).toMatchObject({ outcome: 'license_denied', error: { code: 'license_denied' } });
    expect(docker.containers.has('tl-profile-p1')).toBe(false);
    expect(m.seats().inUse).toBe(0);

    docker.dieWith = null;
    const early = await m.start(startCmd(), signal);
    expect(early).toMatchObject({ outcome: 'error', error: { code: 'crash_backoff' } });
    advance(59_000);
    expect((await m.start(startCmd(), signal)).error?.code).toBe('crash_backoff');
    advance(1_000);
    expect((await m.start(startCmd(), signal)).outcome).toBe('ok');
  });

  it('exit 64 is bad_config; other exits are container_exited', async () => {
    const { m, docker, signal } = setup({ crashBackoffMs: 0 });
    docker.dieWith = 64;
    expect((await m.start(startCmd('a'), signal)).error?.code).toBe('bad_config');
    docker.dieWith = 1;
    expect(await m.start(startCmd('b'), signal)).toMatchObject({
      outcome: 'error',
      error: { code: 'container_exited' },
    });
  });

  it('no CDP within the timeout is an error and the container is stopped', async () => {
    let t = 0;
    // the manager clock moves 20 ms per read, so the 50 ms timeout passes after a few probes
    const { m, docker, signal } = setup({
      ready: false,
      now: () => {
        t += 20;
        return t;
      },
    });
    const r = await m.start(startCmd(), signal);
    expect(r).toMatchObject({ outcome: 'error', error: { code: 'cdp_timeout' } });
    expect(docker.calls).toContain('stop tl-profile-p1');
    expect(docker.containers.has('tl-profile-p1')).toBe(false);
    expect(m.seats().inUse).toBe(0);
  });

  it('an aborted start stops the container', async () => {
    const { m, docker } = setup({ ready: false, readyTimeoutMs: 60_000 });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 20);
    const r = await m.start(startCmd(), ac.signal);
    expect(r.error?.code).toBe('aborted');
    expect(docker.containers.has('tl-profile-p1')).toBe(false);
  });

  it('refuses a start above NODE_MAX_PROFILES', async () => {
    const { m, signal } = setup({ maxProfiles: 2 });
    expect((await m.start(startCmd('a'), signal)).outcome).toBe('ok');
    expect((await m.start(startCmd('b'), signal)).outcome).toBe('ok');
    expect(await m.start(startCmd('c'), signal)).toMatchObject({
      outcome: 'error',
      error: { code: 'max_profiles' },
    });
    // a running profile can still be "started" again (adopt), it takes no new seat
    expect((await m.start(startCmd('a'), signal)).outcome).toBe('ok');
  });

  it('refuses a start above the seat limit, and parallel starts cannot overshoot', async () => {
    const { m, signal } = setup({ maxProfiles: 8, seatLimit: 2 });
    const rs = await Promise.all(['a', 'b', 'c', 'd'].map((id) => m.start(startCmd(id), signal)));
    expect(rs.filter((r) => r.outcome === 'ok')).toHaveLength(2);
    expect(rs.filter((r) => r.error?.code === 'seat_limit')).toHaveLength(2);
    expect(m.seats()).toEqual({ inUse: 2, limit: 2 });
  });

  it('pulls the image when it is missing', async () => {
    const { m, docker, signal } = setup();
    docker.image = null;
    const r = await m.start(startCmd(), signal);
    expect(r.outcome).toBe('ok');
    expect(docker.pulls).toBe(1);
    expect(m.imageDigest()).toBe('repo@sha256:pulled');
  });

  it('rejects a profile id that is not a safe container name', async () => {
    const { m, signal } = setup();
    expect((await m.start(startCmd('../x'), signal)).error?.code).toBe('bad_profile_id');
    expect((await m.stop('a b')).error?.code).toBe('bad_profile_id');
  });

  it('stop removes the container, keeps the volume, frees the seat and forgets the proxy', async () => {
    const { m, docker, signal, events } = setup();
    await m.start(startCmd(), signal);
    const r = await m.stop('p1');
    expect(r).toEqual({ outcome: 'ok', data: { profileId: 'p1', stopped: true } });
    expect(docker.containers.has('tl-profile-p1')).toBe(false);
    expect(docker.volumes.has('tl-profile-p1')).toBe(true);
    expect(m.seats().inUse).toBe(0);
    expect(m.proxyFor('p1')).toBeNull();
    await m.reconcile();
    expect(events).toEqual([]);
    // stopping again is fine
    expect(await m.stop('p1')).toEqual({ outcome: 'ok', data: { profileId: 'p1', stopped: false } });
  });

  it('reports up with the proxy once CDP answers, and down on stop', async () => {
    const seen: string[] = [];
    const { m, signal } = setup({
      onUp: (id, proxy) => seen.push(`up ${id} ${proxy?.username ?? '-'}`),
      onDown: (id) => seen.push(`down ${id}`),
    });
    await m.start(startCmd(), signal);
    await m.start(startCmd(), signal); // adopted: up again, so a restarted agent resumes proxy auth
    await m.stop('p1');
    expect(seen).toEqual(['up p1 u1', 'up p1 u1', 'down p1']);
  });

  it('reports down when the container exits during start, never up', async () => {
    const seen: string[] = [];
    const { m, docker, signal } = setup({
      ready: () => {
        docker.kill('tl-profile-p1', 1);
        return false;
      },
      onUp: (id) => seen.push(`up ${id}`),
      onDown: (id) => seen.push(`down ${id}`),
    });
    expect((await m.start(startCmd(), signal)).outcome).toBe('error');
    expect(seen).toEqual(['down p1']);
  });

  it('reconcile reports a crash as container.exited, frees the seat and starts the relaunch backoff', async () => {
    const { m, docker, signal, events } = setup({ crashBackoffMs: 60_000 });
    await m.start(startCmd(), signal);
    docker.kill('tl-profile-p1', 139);
    await m.reconcile();
    expect(events).toEqual([
      {
        profileId: 'p1',
        kind: 'container.exited',
        detail: { exitCode: 139, reason: 'crashed', relaunchAfter: 1_060_000 },
      },
    ]);
    expect(m.seats().inUse).toBe(0);
    expect(docker.containers.has('tl-profile-p1')).toBe(false);
    expect((await m.start(startCmd(), signal)).error?.code).toBe('crash_backoff');
  });

  it('reconcile reports OOM, license failures and removed containers', async () => {
    const { m, docker, signal, events } = setup();
    for (const id of ['a', 'b', 'c']) await m.start(startCmd(id), signal);
    docker.kill('tl-profile-a', 137, true);
    docker.kill('tl-profile-b', 78);
    docker.containers.delete('tl-profile-c');
    await m.reconcile();
    const reasons = Object.fromEntries(
      events.map((e) => [e.profileId, (e.detail as { reason: string }).reason]),
    );
    expect(reasons).toEqual({ a: 'oom', b: 'license_denied', c: 'removed' });
    expect(m.running()).toEqual([]);
  });

  it('a clean external stop is reported without a relaunch backoff', async () => {
    const { m, docker, signal, events } = setup();
    await m.start(startCmd(), signal);
    docker.kill('tl-profile-p1', 0);
    await m.reconcile();
    expect(events[0]?.detail).toEqual({ exitCode: 0, reason: 'stopped', relaunchAfter: null });
    expect((await m.start(startCmd(), signal)).outcome).toBe('ok');
  });

  it('init adopts running containers from a previous agent and ignores other nodes', async () => {
    const { m, docker } = setup();
    for (const [id, node] of [
      ['old', 'browser-1'],
      ['other', 'browser-2'],
    ] as const) {
      const spec = containerSpec(startCmd(id), {
        image: 'i',
        network: 'n',
        nodeName: node,
        licenseKey: undefined,
      });
      await docker.create(spec);
      await docker.start(spec.name);
    }
    await m.init();
    expect(m.running()).toEqual([{ profileId: 'old', startedAt: 1_000_000 }]);
    expect(m.imageDigest()).toBe('sha256:img1');
    // init is read-only: no network is created until the first start
    expect(docker.networks.size).toBe(0);
  });

  it('docker down: init does not throw, health reports error, start fails cleanly', async () => {
    const { m, docker, signal } = setup();
    docker.down = true;
    await expect(m.init()).resolves.toBeUndefined();
    expect(await m.docker()).toBe('error');
    expect(await m.start(startCmd(), signal)).toMatchObject({
      outcome: 'error',
      error: { code: 'docker_unavailable' },
    });
    docker.down = false;
    expect(await m.docker()).toBe('ok');
  });
});
