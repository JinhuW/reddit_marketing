/**
 * Per-profile browser containers through the node's local Docker socket (plan §4 T21, ADR-0001).
 *
 * One `BrowserProfile` = one volume `tl-profile-<id>` (mounted at `/data`) and one container `tl-profile-<id>` from
 * `BROWSER_IMAGE` on the node's browser network. Containers publish no host ports: the agent reaches CDP (9222) and
 * websockify (6080) by container name on that network, so the agent itself must be attached to it (it attaches
 * itself when it runs in a container).
 *
 * Rules:
 * - `profile.start` is idempotent: a running container is adopted, not replaced. It waits up to 30 s for CDP;
 *   exit 78 → `license_denied`, exit 64 → `error/bad_config`, any other exit or no CDP → `error`.
 * - Seats = running profile containers. A start is refused at `NODE_MAX_PROFILES` or the CloakBrowser seat limit.
 * - A profile whose container crashed (non-zero exit, OOM, or a license failure, which can keep holding a seat on
 *   the license server) is not relaunched for 60 s.
 * - A reconcile loop adopts containers left running by a previous agent and reports unexpected exits as
 *   `container.exited` events.
 * - Proxy credentials never reach the container: `PROXY_URL` carries only scheme, host and port, and the
 *   credentials stay in agent memory ({@link DockerManager.proxyFor}) for the CDP `Fetch.authRequired` answer.
 *   The license key is the only secret in the container's environment.
 */
import { hostname } from 'node:os';
import type { CmdOf, ProfileRef, ProxySpec, Seats } from '@threadline/shared';
import Docker from 'dockerode';
import type { Logger } from './log';
import type { AgentEvent, HandlerResult } from './registry';

export const CDP_PORT = 9222;
export const VNC_PORT = 6080;
export const SHM_SIZE_BYTES = 1024 ** 3; // --shm-size=1g
export const MEMORY_LIMIT_BYTES = 1.5 * 1024 ** 3; // 1.5 GB, no swap on top
export const READY_TIMEOUT_MS = 30_000;
export const CRASH_BACKOFF_MS = 60_000;
export const STOP_TIMEOUT_SEC = 10;
/** Container exit codes from apps/browser-profile/README.md. */
export const EXIT_LICENSE_DENIED = 78;
export const EXIT_BAD_CONFIG = 64;

export const LABEL_ROLE = 'dev.threadline.role';
export const LABEL_PROFILE = 'dev.threadline.profile-id';
export const LABEL_NODE = 'dev.threadline.node';
export const ROLE_VALUE = 'browser-profile';

const SAFE_ID = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;

/** `tl-profile-<id>`: the container name, the volume name and the host name on the browser network. */
export const profileResourceName = (profileId: string) => `tl-profile-${profileId}`;

export const cdpUrl = (profileId: string) => `http://${profileResourceName(profileId)}:${CDP_PORT}`;
export const websockifyUrl = (profileId: string) =>
  `ws://${profileResourceName(profileId)}:${VNC_PORT}/websockify`;

// ── Docker access, narrowed to what the manager needs (dockerode in production, a fake in unit tests) ──

export type ContainerState = 'created' | 'running' | 'restarting' | 'paused' | 'exited' | 'dead' | 'removing';

export interface ContainerInfo {
  name: string;
  profileId: string;
  state: ContainerState;
  /** epoch ms; 0 when docker does not report it */
  startedAt: number;
  exitCode: number | null;
  oomKilled: boolean;
}

export interface ContainerSpec {
  name: string;
  image: string;
  env: Record<string, string>;
  labels: Record<string, string>;
  network: string;
  volume: string;
  shmSizeBytes: number;
  memoryBytes: number;
  securityOpt: string[];
}

export interface DockerBackend {
  ping(): Promise<void>;
  /** RepoDigest (or image id) of a local image; null when the image is not present. */
  imageDigest(image: string): Promise<string | null>;
  pullImage(image: string): Promise<void>;
  ensureNetwork(name: string, labels: Record<string, string>): Promise<void>;
  ensureVolume(name: string, labels: Record<string, string>): Promise<void>;
  /** Containers carrying every given label, in any state. */
  list(labels: Record<string, string>): Promise<ContainerInfo[]>;
  inspect(name: string): Promise<ContainerInfo | null>;
  create(spec: ContainerSpec): Promise<void>;
  start(name: string): Promise<void>;
  /** Stop; a missing or already stopped container is not an error. */
  stop(name: string, timeoutSec: number): Promise<void>;
  /** Remove the container (never its volume); a missing container is not an error. */
  remove(name: string): Promise<void>;
  /** When the agent runs in a container, attach it to `network`. Returns false when it is not in a container. */
  attachSelf(network: string): Promise<boolean>;
}

/** Map a container exit code to the result the gateway sees. */
export function exitResult(code: number | null, oomKilled = false): HandlerResult {
  if (code === EXIT_LICENSE_DENIED)
    return {
      outcome: 'license_denied',
      error: { code: 'license_denied', message: 'CloakBrowser license check failed' },
    };
  if (code === EXIT_BAD_CONFIG)
    return {
      outcome: 'error',
      error: {
        code: 'bad_config',
        message: 'profile container refused its environment or fingerprint lock (exit 64)',
      },
    };
  return {
    outcome: 'error',
    error: {
      code: 'container_exited',
      message: oomKilled
        ? 'profile container was killed for exceeding its memory limit'
        : `profile container exited with code ${code ?? 'unknown'} before CDP was ready`,
    },
  };
}

/** `PROXY_URL` for the container: scheme, host and port only. Credentials stay in the agent. */
export function proxyUrl(proxy: ProxySpec | null): string | null {
  if (!proxy) return null;
  const host = proxy.host.includes(':') && !proxy.host.startsWith('[') ? `[${proxy.host}]` : proxy.host;
  return `${proxy.protocol}://${host}:${proxy.port}`;
}

export interface SpecOptions {
  image: string;
  network: string;
  nodeName: string;
  licenseKey: string | undefined;
  securityOpt?: string[];
}

/** The container for one `profile.start`. Pure, so the exact Docker request is unit-tested. */
export function containerSpec(cmd: CmdOf<'profile.start'>, opts: SpecOptions): ContainerSpec {
  const name = profileResourceName(cmd.profileId);
  const env: Record<string, string> = {
    CLOAK_SEED: String(cmd.seed),
    CLOAK_PERSONA: cmd.persona,
    CLOAK_GPU: cmd.gpu,
    TZ: cmd.tz,
    LOCALE: cmd.locale,
    SCREEN: cmd.screen,
  };
  const proxy = proxyUrl(cmd.proxy);
  if (proxy) env.PROXY_URL = proxy;
  if (opts.licenseKey) env.CLOAKBROWSER_LICENSE_KEY = opts.licenseKey;
  return {
    name,
    image: opts.image,
    env,
    labels: profileLabels(opts.nodeName, cmd.profileId),
    network: opts.network,
    volume: name,
    shmSizeBytes: SHM_SIZE_BYTES,
    memoryBytes: MEMORY_LIMIT_BYTES,
    securityOpt: opts.securityOpt ?? [],
  };
}

export function profileLabels(nodeName: string, profileId?: string): Record<string, string> {
  const labels: Record<string, string> = { [LABEL_ROLE]: ROLE_VALUE, [LABEL_NODE]: nodeName };
  if (profileId) labels[LABEL_PROFILE] = profileId;
  return labels;
}

// ── dockerode backend ──

const statusCode = (err: unknown) => (err as { statusCode?: number } | null)?.statusCode;

function toInfo(
  name: string,
  labels: Record<string, string> | undefined,
  state: Docker.ContainerInspectInfo['State'],
): ContainerInfo {
  const started = Date.parse(state.StartedAt);
  return {
    name,
    profileId: labels?.[LABEL_PROFILE] ?? name.replace(/^tl-profile-/, ''),
    state: state.Status as ContainerState,
    startedAt: Number.isFinite(started) && started > 0 ? started : 0,
    exitCode: state.Status === 'running' || state.Status === 'created' ? null : state.ExitCode,
    oomKilled: state.OOMKilled,
  };
}

export function dockerodeBackend(docker: Docker = new Docker()): DockerBackend {
  const inspect = async (name: string): Promise<ContainerInfo | null> => {
    try {
      const c = await docker.getContainer(name).inspect();
      return toInfo(c.Name.replace(/^\//, ''), c.Config.Labels, c.State);
    } catch (err) {
      if (statusCode(err) === 404) return null;
      throw err;
    }
  };
  return {
    async ping() {
      await docker.ping();
    },
    async imageDigest(image) {
      try {
        const i = await docker.getImage(image).inspect();
        return i.RepoDigests?.[0] ?? i.Id;
      } catch (err) {
        if (statusCode(err) === 404) return null;
        throw err;
      }
    },
    async pullImage(image) {
      const stream = await docker.pull(image);
      await new Promise<void>((resolve, reject) =>
        docker.modem.followProgress(stream, (err) => (err ? reject(err) : resolve())),
      );
    },
    async ensureNetwork(name, labels) {
      try {
        await docker.getNetwork(name).inspect();
        return;
      } catch (err) {
        if (statusCode(err) !== 404) throw err;
      }
      try {
        // A plain bridge, not `Internal`: browsers reach the internet (through their proxies); nothing is published.
        await docker.createNetwork({ Name: name, Driver: 'bridge', Labels: labels, CheckDuplicate: true });
      } catch (err) {
        if (statusCode(err) !== 409) throw err;
      }
    },
    async ensureVolume(name, labels) {
      try {
        await docker.getVolume(name).inspect();
        return;
      } catch (err) {
        if (statusCode(err) !== 404) throw err;
      }
      await docker.createVolume({ Name: name, Labels: labels });
    },
    async list(labels) {
      const filters = { label: Object.entries(labels).map(([k, v]) => `${k}=${v}`) };
      const rows = await docker.listContainers({ all: true, filters: JSON.stringify(filters) });
      const out: ContainerInfo[] = [];
      for (const row of rows) {
        const info = await inspect(row.Id);
        if (info) out.push(info);
      }
      return out;
    },
    inspect,
    async create(spec) {
      await docker.createContainer({
        name: spec.name,
        Image: spec.image,
        Env: Object.entries(spec.env).map(([k, v]) => `${k}=${v}`),
        Labels: spec.labels,
        Hostname: spec.name,
        HostConfig: {
          NetworkMode: spec.network,
          Mounts: [{ Type: 'volume', Source: spec.volume, Target: '/data' }],
          PortBindings: {},
          PublishAllPorts: false,
          ShmSize: spec.shmSizeBytes,
          Memory: spec.memoryBytes,
          MemorySwap: spec.memoryBytes,
          RestartPolicy: { Name: 'no' },
          SecurityOpt: spec.securityOpt.length ? spec.securityOpt : undefined,
        },
      });
    },
    async start(name) {
      await docker.getContainer(name).start();
    },
    async stop(name, timeoutSec) {
      try {
        await docker.getContainer(name).stop({ t: timeoutSec });
      } catch (err) {
        const code = statusCode(err);
        if (code !== 404 && code !== 304) throw err;
      }
    },
    async remove(name) {
      try {
        await docker.getContainer(name).remove({ force: true, v: false });
      } catch (err) {
        const code = statusCode(err);
        if (code !== 404 && code !== 409) throw err;
      }
    },
    async attachSelf(network) {
      let self: Docker.ContainerInspectInfo;
      try {
        self = await docker.getContainer(hostname()).inspect();
      } catch {
        return false;
      }
      if (self.NetworkSettings.Networks?.[network]) return true;
      try {
        await docker.getNetwork(network).connect({ Container: self.Id });
      } catch (err) {
        if (statusCode(err) !== 403 && statusCode(err) !== 409) throw err;
      }
      return true;
    },
  };
}

// ── readiness ──

/** True once the container answers CDP. */
export type ReadyProbe = (profileId: string, signal: AbortSignal) => Promise<boolean>;

/** Default probe: `GET http://tl-profile-<id>:9222/json/version` over the browser network. */
export const httpCdpProbe: ReadyProbe = async (profileId, signal) => {
  try {
    const res = await fetch(`${cdpUrl(profileId)}/json/version`, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1_000)]),
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
};

// ── manager ──

export interface DockerManagerOptions {
  backend: DockerBackend;
  log: Logger;
  /** Sends a node event to the gateway. */
  emit: (event: AgentEvent) => void;
  nodeName: string;
  image: string;
  network: string;
  maxProfiles: number;
  /** CloakBrowser seat cap; null when unknown or uncapped. */
  seatLimit: number | null;
  licenseKey: string | undefined;
  securityOpt?: string[];
  readyProbe?: ReadyProbe;
  readyTimeoutMs?: number;
  crashBackoffMs?: number;
  pollMs?: number;
  /** 0 disables the periodic reconcile. */
  reconcileMs?: number;
  stopTimeoutSec?: number;
  now?: () => number;
  /**
   * The profile's browser answers CDP (fresh start or adopted by `profile.start`). `proxy` is the one it was
   * started with. The profile module uses it to begin answering proxy challenges before anyone browses.
   */
  onUp?: (profileId: string, proxy: ProxySpec | null) => void;
  /** The agent forgot the profile (stopped, exited, removed, or start failed). */
  onDown?: (profileId: string) => void;
}

interface Tracked {
  startedAt: number;
}

export interface StartData {
  profileId: string;
  startedAt: number;
  adopted: boolean;
  imageDigest: string | null;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener('abort', done);
      resolve();
    }
    signal.addEventListener('abort', done, { once: true });
  });

const fail = (code: string, message: string): HandlerResult => ({
  outcome: 'error',
  error: { code, message },
});

export class DockerManager {
  private readonly tracked = new Map<string, Tracked>();
  private readonly proxies = new Map<string, ProxySpec>();
  private readonly crashedAt = new Map<string, number>();
  /** Profiles with a start/stop in progress: the reconcile loop leaves them alone. */
  private readonly busy = new Set<string>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private reserved = 0;
  private digest: string | null = null;
  private networkReady = false;
  private timer: NodeJS.Timeout | undefined;
  private reconciling: Promise<void> | undefined;
  private readonly now: () => number;
  private readonly probe: ReadyProbe;

  constructor(private readonly o: DockerManagerOptions) {
    this.now = o.now ?? Date.now;
    this.probe = o.readyProbe ?? httpCdpProbe;
  }

  /**
   * Read-only start-up: adopt running profile containers and read the image digest, then reconcile on a timer.
   * Docker being down is logged, not thrown: the agent still connects and reports `docker: error`.
   */
  async init(): Promise<void> {
    try {
      await this.refreshDigest();
      await this.reconcile();
    } catch (err) {
      this.o.log.error({ err }, 'docker not reachable at start; will retry on reconcile');
    }
    const every = this.o.reconcileMs ?? 10_000;
    if (every > 0) {
      this.timer = setInterval(() => {
        this.reconcile().catch((err) => this.o.log.warn({ err }, 'reconcile failed'));
      }, every);
      this.timer.unref();
    }
  }

  close(): void {
    clearInterval(this.timer);
    this.timer = undefined;
  }

  running(): ProfileRef[] {
    return [...this.tracked].map(([profileId, t]) => ({ profileId, startedAt: t.startedAt }));
  }

  seats(): Seats {
    return { inUse: this.tracked.size, limit: this.o.seatLimit };
  }

  imageDigest(): string | null {
    return this.digest;
  }

  async docker(): Promise<'ok' | 'error'> {
    try {
      await this.o.backend.ping();
      return 'ok';
    } catch {
      return 'error';
    }
  }

  /** Proxy credentials for a running profile, for the CDP `Fetch.authRequired` answer (actions, T22). */
  proxyFor(profileId: string): ProxySpec | null {
    return this.proxies.get(profileId) ?? null;
  }

  isRunning(profileId: string): boolean {
    return this.tracked.has(profileId);
  }

  start(cmd: CmdOf<'profile.start'>, signal: AbortSignal): Promise<HandlerResult> {
    if (!SAFE_ID.test(cmd.profileId))
      return Promise.resolve(fail('bad_profile_id', 'profile id is not a valid container name'));
    return this.exclusive(cmd.profileId, () => this.doStart(cmd, signal));
  }

  stop(profileId: string): Promise<HandlerResult> {
    if (!SAFE_ID.test(profileId))
      return Promise.resolve(fail('bad_profile_id', 'profile id is not a valid container name'));
    return this.exclusive(profileId, () => this.doStop(profileId));
  }

  /**
   * Align `tracked` with Docker: adopt running containers, drop and report containers that stopped without a
   * `profile.stop`, and report tracked containers that disappeared.
   */
  reconcile(): Promise<void> {
    this.reconciling ??= this.doReconcile().finally(() => {
      this.reconciling = undefined;
    });
    return this.reconciling;
  }

  // ── internals ──

  private async exclusive<T>(profileId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(profileId) ?? Promise.resolve();
    const run = prev
      .catch(() => undefined)
      .then(async () => {
        this.busy.add(profileId);
        try {
          return await fn();
        } finally {
          this.busy.delete(profileId);
        }
      });
    this.locks.set(profileId, run);
    try {
      return await run;
    } finally {
      if (this.locks.get(profileId) === run) this.locks.delete(profileId);
    }
  }

  private async refreshDigest(): Promise<string | null> {
    this.digest = await this.o.backend.imageDigest(this.o.image);
    return this.digest;
  }

  private limit(): { cap: number; code: string } {
    const seats = this.o.seatLimit;
    if (seats !== null && seats < this.o.maxProfiles) return { cap: seats, code: 'seat_limit' };
    return { cap: this.o.maxProfiles, code: 'max_profiles' };
  }

  private async doStart(cmd: CmdOf<'profile.start'>, signal: AbortSignal): Promise<HandlerResult> {
    const { profileId } = cmd;
    const name = profileResourceName(profileId);
    const log = this.o.log.child({ profileId });
    const b = this.o.backend;

    let existing: ContainerInfo | null;
    try {
      existing = await b.inspect(name);
    } catch (err) {
      log.error({ err }, 'docker inspect failed');
      return fail('docker_unavailable', 'docker is not reachable on this node');
    }

    if (existing?.state === 'running') {
      // Already up (a retried start, or adopted after an agent restart): never replace a live browser.
      const startedAt = this.tracked.get(profileId)?.startedAt ?? (existing.startedAt || this.now());
      this.tracked.set(profileId, { startedAt });
      if (cmd.proxy) this.proxies.set(profileId, cmd.proxy);
      const ready = await this.waitReady(profileId, signal, log);
      if (ready.outcome !== 'ok') return ready;
      return this.started(profileId, startedAt, true);
    }

    const crashed = this.crashedAt.get(profileId);
    const backoff = this.o.crashBackoffMs ?? CRASH_BACKOFF_MS;
    if (crashed !== undefined && this.now() - crashed < backoff) {
      const wait = Math.ceil((backoff - (this.now() - crashed)) / 1000);
      return fail('crash_backoff', `profile crashed recently; relaunch allowed in ${wait} s`);
    }

    const { cap, code } = this.limit();
    if (this.tracked.size + this.reserved >= cap) {
      return fail(code, `node is at its limit of ${cap} running profiles`);
    }

    this.reserved++;
    try {
      if (existing) await b.remove(name); // a stopped leftover; the volume (the profile) stays
      if (!this.networkReady) {
        await b.ensureNetwork(this.o.network, profileLabels(this.o.nodeName));
        await b.attachSelf(this.o.network).catch((err) => {
          log.warn({ err }, 'could not attach the agent to the browser network');
          return false;
        });
        this.networkReady = true;
      }
      if (!(await this.refreshDigest())) {
        log.info({ image: this.o.image }, 'browser image not present; pulling');
        try {
          await b.pullImage(this.o.image);
        } catch (err) {
          log.error({ err, image: this.o.image }, 'image pull failed');
          return fail('image_unavailable', 'browser image is not present and could not be pulled');
        }
        await this.refreshDigest();
      }
      const spec = containerSpec(cmd, {
        image: this.o.image,
        network: this.o.network,
        nodeName: this.o.nodeName,
        licenseKey: this.o.licenseKey,
        securityOpt: this.o.securityOpt,
      });
      await b.ensureVolume(spec.volume, spec.labels);
      await b.create(spec);
      await b.start(name);
    } catch (err) {
      log.error({ err }, 'could not start profile container');
      await b.remove(name).catch(() => undefined);
      return fail('docker_error', 'docker refused to create or start the profile container');
    } finally {
      this.reserved--;
    }

    const startedAt = this.now();
    this.tracked.set(profileId, { startedAt });
    if (cmd.proxy) this.proxies.set(profileId, cmd.proxy);
    log.info({ image: this.o.image }, 'profile container started; waiting for CDP');
    const ready = await this.waitReady(profileId, signal, log);
    if (ready.outcome !== 'ok') return ready;
    return this.started(profileId, startedAt, false);
  }

  private started(profileId: string, startedAt: number, adopted: boolean): HandlerResult {
    this.crashedAt.delete(profileId);
    this.o.onUp?.(profileId, this.proxies.get(profileId) ?? null);
    const data: StartData = { profileId, startedAt, adopted, imageDigest: this.digest };
    return { outcome: 'ok', data };
  }

  /** Poll until CDP answers, the container exits, the timeout passes or the command is aborted. */
  private async waitReady(profileId: string, signal: AbortSignal, log: Logger): Promise<HandlerResult> {
    const name = profileResourceName(profileId);
    const until = this.now() + (this.o.readyTimeoutMs ?? READY_TIMEOUT_MS);
    const poll = this.o.pollMs ?? 500;
    while (true) {
      const info = await this.o.backend.inspect(name).catch(() => null);
      if (!info || info.state !== 'running') {
        const result = exitResult(info?.exitCode ?? null, info?.oomKilled);
        log.warn(
          { exitCode: info?.exitCode ?? null, outcome: result.outcome },
          'profile container exited during start',
        );
        await this.drop(profileId, true);
        return result;
      }
      if (await this.probe(profileId, signal)) return { outcome: 'ok' };
      if (signal.aborted || this.now() >= until) {
        const why = signal.aborted ? 'aborted' : 'cdp_timeout';
        log.warn({ why }, 'CDP not ready; stopping the profile container');
        await this.o.backend.stop(name, this.o.stopTimeoutSec ?? STOP_TIMEOUT_SEC).catch(() => undefined);
        await this.drop(profileId, false);
        return signal.aborted
          ? fail('aborted', 'profile start aborted at the command deadline')
          : fail(
              'cdp_timeout',
              `CDP did not answer within ${(this.o.readyTimeoutMs ?? READY_TIMEOUT_MS) / 1000} s`,
            );
      }
      await sleep(poll, signal);
    }
  }

  /** Forget a profile and remove its container (never the volume). `crashed` starts the relaunch backoff. */
  private async drop(profileId: string, crashed: boolean): Promise<void> {
    this.tracked.delete(profileId);
    this.proxies.delete(profileId);
    this.o.onDown?.(profileId);
    if (crashed) this.crashedAt.set(profileId, this.now());
    await this.o.backend.remove(profileResourceName(profileId)).catch(() => undefined);
  }

  private async doStop(profileId: string): Promise<HandlerResult> {
    const name = profileResourceName(profileId);
    const was = this.tracked.has(profileId);
    try {
      await this.o.backend.stop(name, this.o.stopTimeoutSec ?? STOP_TIMEOUT_SEC);
      await this.o.backend.remove(name);
    } catch (err) {
      this.o.log.error({ err, profileId }, 'could not stop profile container');
      return fail('docker_error', 'docker refused to stop the profile container');
    }
    this.tracked.delete(profileId);
    this.proxies.delete(profileId);
    this.o.onDown?.(profileId);
    this.o.log.info({ profileId, was }, 'profile container stopped');
    return { outcome: 'ok', data: { profileId, stopped: was } };
  }

  private async doReconcile(): Promise<void> {
    const rows = await this.o.backend.list(profileLabels(this.o.nodeName));
    const seen = new Set<string>();
    for (const c of rows) {
      seen.add(c.profileId);
      if (this.busy.has(c.profileId)) continue;
      if (c.state === 'running') {
        if (!this.tracked.has(c.profileId)) {
          this.tracked.set(c.profileId, { startedAt: c.startedAt || this.now() });
          this.o.log.info({ profileId: c.profileId }, 'adopted running profile container');
        }
        continue;
      }
      if (c.state === 'created' || c.state === 'restarting' || c.state === 'removing') continue;
      // exited / dead / paused without a profile.stop from us. Re-checked under the profile's lock so a start
      // that began meanwhile is never torn down.
      await this.exclusive(c.profileId, () => this.settleExited(c.profileId));
    }
    for (const profileId of [...this.tracked.keys()]) {
      if (seen.has(profileId) || this.busy.has(profileId)) continue;
      await this.exclusive(profileId, () => this.settleExited(profileId));
    }
  }

  private async settleExited(profileId: string): Promise<void> {
    const c = await this.o.backend.inspect(profileResourceName(profileId));
    if (c?.state === 'running' || c?.state === 'created' || c?.state === 'restarting') return;
    const wasTracked = this.tracked.has(profileId);
    if (!c) {
      if (!wasTracked) return;
      this.tracked.delete(profileId);
      this.proxies.delete(profileId);
      this.o.onDown?.(profileId);
      this.o.log.warn({ profileId }, 'profile container disappeared');
      this.exited(profileId, { exitCode: null, reason: 'removed' });
      return;
    }
    const crashed = c.exitCode !== 0 || c.oomKilled;
    let reason = crashed ? 'crashed' : 'stopped';
    if (c.oomKilled) reason = 'oom';
    if (c.exitCode === EXIT_LICENSE_DENIED) reason = 'license_denied';
    await this.drop(profileId, crashed);
    this.o.log.warn({ profileId, exitCode: c.exitCode, reason }, 'profile container exited');
    if (wasTracked) this.exited(profileId, { exitCode: c.exitCode, reason });
  }

  private exited(profileId: string, detail: { exitCode: number | null; reason: string }): void {
    const crashed = this.crashedAt.get(profileId);
    const backoff = this.o.crashBackoffMs ?? CRASH_BACKOFF_MS;
    this.o.emit({
      profileId,
      kind: 'container.exited',
      detail: { ...detail, relaunchAfter: crashed === undefined ? null : crashed + backoff },
    });
  }
}
