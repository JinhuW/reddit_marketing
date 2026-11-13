/** In-memory Docker backend and a `profile.start` builder for docker manager and profile module tests. */
import type { CmdOf } from '@threadline/shared';
import { type ContainerInfo, type ContainerSpec, type DockerBackend, LABEL_PROFILE } from '../docker';

/** In-memory Docker: containers, volumes, networks and an image, with knobs for failure modes. */
export class FakeDocker implements DockerBackend {
  containers = new Map<string, ContainerInfo & { spec: ContainerSpec }>();
  volumes = new Set<string>();
  networks = new Set<string>();
  image: string | null = 'sha256:img1';
  pulls = 0;
  calls: string[] = [];
  /** exit code a freshly started container dies with (null = keeps running) */
  dieWith: number | null = null;
  down = false;
  clock = 1_000_000;

  private check() {
    if (this.down) throw Object.assign(new Error('connect ENOENT /var/run/docker.sock'), { code: 'ENOENT' });
  }
  async ping() {
    this.check();
  }
  async imageDigest() {
    this.check();
    return this.image;
  }
  async pullImage() {
    this.pulls++;
    this.image = 'repo@sha256:pulled';
  }
  async ensureNetwork(name: string) {
    this.networks.add(name);
  }
  async ensureVolume(name: string) {
    this.volumes.add(name);
  }
  async list(labels: Record<string, string>) {
    this.check();
    return [...this.containers.values()].filter((c) =>
      Object.entries(labels).every(([k, v]) => c.spec.labels[k] === v),
    );
  }
  async inspect(name: string) {
    this.check();
    const c = this.containers.get(name);
    return c ? { ...c } : null;
  }
  async create(spec: ContainerSpec) {
    this.calls.push(`create ${spec.name}`);
    if (this.containers.has(spec.name)) throw Object.assign(new Error('conflict'), { statusCode: 409 });
    this.containers.set(spec.name, {
      name: spec.name,
      profileId: spec.labels[LABEL_PROFILE] ?? '',
      state: 'created',
      startedAt: 0,
      exitCode: null,
      oomKilled: false,
      spec,
    });
  }
  async start(name: string) {
    this.calls.push(`start ${name}`);
    const c = this.containers.get(name);
    if (!c) throw new Error('no such container');
    if (this.dieWith !== null) Object.assign(c, { state: 'exited', exitCode: this.dieWith });
    else Object.assign(c, { state: 'running', startedAt: this.clock, exitCode: null });
  }
  async stop(name: string) {
    this.calls.push(`stop ${name}`);
    const c = this.containers.get(name);
    if (c && c.state === 'running') Object.assign(c, { state: 'exited', exitCode: 0 });
  }
  async remove(name: string) {
    this.calls.push(`remove ${name}`);
    this.containers.delete(name);
  }
  async removeVolume(name: string) {
    this.calls.push(`removeVolume ${name}`);
    this.volumes.delete(name);
  }
  async attachSelf() {
    return false;
  }
  /** Simulate a container dying on its own. */
  kill(name: string, exitCode: number, oomKilled = false) {
    const c = this.containers.get(name);
    if (c) Object.assign(c, { state: 'exited', exitCode, oomKilled });
  }
}

export const startCmd = (
  profileId = 'p1',
  extra: Partial<CmdOf<'profile.start'>> = {},
): CmdOf<'profile.start'> => ({
  kind: 'profile.start',
  profileId,
  seed: 4242,
  persona: 'windows',
  gpu: 'nvidia',
  tz: 'America/New_York',
  locale: 'en-US',
  screen: '1920x1080',
  proxy: { protocol: 'http', host: 'proxy.example', port: 8080, username: 'u1', password: 'proxy-pass-1' },
  ...extra,
});
