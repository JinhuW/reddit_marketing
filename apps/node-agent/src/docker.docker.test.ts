/**
 * @docker: the docker manager against the local Docker daemon with a tiny fake profile image (busybox httpd
 * answering `/json/version` on 9222). Skipped when no daemon is reachable (CI without Docker) or when
 * `SKIP_DOCKER_TESTS=1`. Everything it creates carries a per-run name and is removed afterwards.
 *
 * The fake image's behaviour is keyed on CLOAK_SEED: 78 → exit 78 (license failure), 64 → exit 64, otherwise
 * serve CDP. Readiness is checked with `docker exec … wget` because the test runner is not on the browser network.
 */
import { execFile, execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { promisify } from 'node:util';
import Docker from 'dockerode';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  DockerManager,
  LABEL_NODE,
  MEMORY_LIMIT_BYTES,
  type ReadyProbe,
  SHM_SIZE_BYTES,
  dockerodeBackend,
  profileResourceName,
} from './docker';
import { createLogger } from './log';
import type { AgentEvent } from './registry';
import { startCmd } from './testing/fake-docker';

const run = promisify(execFile);

function dockerAvailable(): boolean {
  if (process.env.SKIP_DOCKER_TESTS === '1') return false;
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe', timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

/** dockerode does not read docker CLI contexts (Colima, Docker Desktop); use the current context's socket. */
function localDocker(): Docker {
  if (process.env.DOCKER_HOST) return new Docker();
  try {
    const host = execFileSync('docker', ['context', 'inspect', '--format', '{{.Endpoints.docker.Host}}'], {
      stdio: 'pipe',
    })
      .toString()
      .trim();
    if (host.startsWith('unix://')) return new Docker({ socketPath: host.slice('unix://'.length) });
  } catch {
    // fall through to the default socket
  }
  return new Docker();
}

const IMAGE = 'threadline/fake-browser-profile:t21';
const DOCKERFILE = `FROM busybox:1.36.1
RUN mkdir -p /www/json && echo '{"Browser":"fake"}' > /www/json/version
CMD ["sh", "-c", "case \\"$CLOAK_SEED\\" in 78) exit 78;; 64) exit 64;; esac; mkdir -p /data/browser && echo \\"$CLOAK_SEED\\" > /data/seed && exec httpd -f -p 9222 -h /www"]
`;

const execProbe: ReadyProbe = async (profileId) => {
  try {
    await run('docker', [
      'exec',
      profileResourceName(profileId),
      'wget',
      '-q',
      '-O',
      '/dev/null',
      'http://127.0.0.1:9222/json/version',
    ]);
    return true;
  } catch {
    return false;
  }
};

describe.skipIf(!dockerAvailable())('@docker DockerManager on the local daemon', () => {
  const tag = randomBytes(3).toString('hex');
  const node = `t21test-${tag}`;
  const network = `tl-t21-test-${tag}`;
  const ids = { a: `t21-${tag}-a`, lic: `t21-${tag}-lic`, b: `t21-${tag}-b` };
  const docker = localDocker();
  const events: AgentEvent[] = [];
  const signal = new AbortController().signal;
  let m: DockerManager;

  beforeAll(async () => {
    execFileSync('docker', ['build', '-q', '-t', IMAGE, '-'], {
      input: DOCKERFILE,
      stdio: 'pipe',
      timeout: 120_000,
    });
    m = new DockerManager({
      backend: dockerodeBackend(docker),
      log: createLogger({ level: 'silent' }),
      emit: (e) => events.push(e),
      nodeName: node,
      image: IMAGE,
      network,
      maxProfiles: 2,
      seatLimit: null,
      licenseKey: 'fake-license-key',
      readyProbe: execProbe,
      readyTimeoutMs: 20_000,
      pollMs: 200,
      reconcileMs: 0,
    });
    await m.init();
  }, 180_000);

  afterAll(async () => {
    m?.close();
    const all = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ label: [`${LABEL_NODE}=${node}`] }),
    });
    for (const c of all) await docker.getContainer(c.Id).remove({ force: true });
    for (const id of Object.values(ids))
      await docker
        .getVolume(profileResourceName(id))
        .remove()
        .catch(() => {});
    await docker
      .getNetwork(network)
      .remove()
      .catch(() => {});
  }, 60_000);

  it('starts a profile container with the volume, network, limits and no published ports', async () => {
    const r = await m.start(startCmd(ids.a), signal);
    expect(r).toMatchObject({ outcome: 'ok', data: { profileId: ids.a, adopted: false } });

    const c = await docker.getContainer(profileResourceName(ids.a)).inspect();
    expect(c.State.Running).toBe(true);
    expect(c.HostConfig.ShmSize).toBe(SHM_SIZE_BYTES);
    expect(c.HostConfig.Memory).toBe(MEMORY_LIMIT_BYTES);
    expect(c.HostConfig.PortBindings ?? {}).toEqual({});
    expect(Object.values(c.NetworkSettings.Ports ?? {}).every((b) => !b)).toBe(true);
    expect(c.HostConfig.NetworkMode).toBe(network);
    expect(c.Mounts).toEqual([
      expect.objectContaining({ Type: 'volume', Name: profileResourceName(ids.a), Destination: '/data' }),
    ]);
    expect(c.Config.Env).toEqual(
      expect.arrayContaining(['CLOAK_SEED=4242', 'PROXY_URL=http://proxy.example:8080']),
    );
    expect(c.Config.Env.join('\n')).not.toContain('proxy-pass-1');
    expect(m.seats().inUse).toBe(1);
    expect(m.imageDigest()).toMatch(/^sha256:|@sha256:/);
  }, 60_000);

  it('maps exit 78 to license_denied and leaves no container behind', async () => {
    const r = await m.start(startCmd(ids.lic, { seed: 78 }), signal);
    expect(r.outcome).toBe('license_denied');
    expect(await m.start(startCmd(ids.lic, { seed: 78 }), signal)).toMatchObject({
      error: { code: 'crash_backoff' },
    });
    const left = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ name: [profileResourceName(ids.lic)] }),
    });
    expect(left).toHaveLength(0);
  }, 60_000);

  it('refuses a start above NODE_MAX_PROFILES', async () => {
    expect((await m.start(startCmd(ids.b), signal)).outcome).toBe('ok');
    expect(await m.start(startCmd(`t21-${tag}-c`), signal)).toMatchObject({
      error: { code: 'max_profiles' },
    });
  }, 60_000);

  it('reports a killed container as container.exited and frees its seat', async () => {
    await docker.getContainer(profileResourceName(ids.b)).kill();
    await docker.getContainer(profileResourceName(ids.b)).wait();
    await m.reconcile();
    expect(events).toContainEqual(
      expect.objectContaining({
        profileId: ids.b,
        kind: 'container.exited',
        detail: expect.objectContaining({ reason: 'crashed' }),
      }),
    );
    expect(m.running().map((r) => r.profileId)).toEqual([ids.a]);
  }, 60_000);

  it('a new manager adopts the running container; stop removes it and keeps the volume', async () => {
    const again = new DockerManager({
      backend: dockerodeBackend(docker),
      log: createLogger({ level: 'silent' }),
      emit: () => {},
      nodeName: node,
      image: IMAGE,
      network,
      maxProfiles: 2,
      seatLimit: null,
      licenseKey: undefined,
      readyProbe: execProbe,
      reconcileMs: 0,
      stopTimeoutSec: 1, // busybox httpd as PID 1 ignores SIGTERM; the real image runs under tini
    });
    await again.init();
    expect(again.running().map((r) => r.profileId)).toEqual([ids.a]);
    expect(await again.stop(ids.a)).toEqual({ outcome: 'ok', data: { profileId: ids.a, stopped: true } });
    const left = await docker.listContainers({
      all: true,
      filters: JSON.stringify({ name: [profileResourceName(ids.a)] }),
    });
    expect(left).toHaveLength(0);
    const vol = await docker.getVolume(profileResourceName(ids.a)).inspect();
    expect(vol.Name).toBe(profileResourceName(ids.a));
  }, 60_000);
});
