/**
 * `profile.start` / `profile.stop` / `profile.remove`: one CloakBrowser container per profile through the local Docker socket
 * (see `../docker.ts`). On agent start the module adopts running profile containers and plugs the real
 * running/seats/imageDigest/docker readers into the status store, so `hello`, `heartbeat` and `health.check`
 * report what Docker actually runs.
 *
 * Optional node env read here (not part of the agent's core config):
 * - `NODE_SEAT_LIMIT`: CloakBrowser seats on this node's license tier; starts above it are refused.
 * - `BROWSER_SECCOMP_PROFILE`: path to a seccomp JSON that allows the Chromium sandbox's user namespaces
 *   (apps/browser-profile/README.md "Sandbox"); passed as `--security-opt seccomp=…`.
 */
import { readFileSync } from 'node:fs';
import { z } from 'zod';
import { profileProxies, proxyAuthWatchers } from '../actions';
import { geoWatchers } from '../actions/geo-watch';
import { type DockerBackend, DockerManager, type DockerManagerOptions, dockerodeBackend } from '../docker';
import type { AgentModule } from '../registry';

const ProfileEnv = z.object({
  NODE_SEAT_LIMIT: z.coerce.number().int().positive().optional(),
  BROWSER_SECCOMP_PROFILE: z.string().min(1).optional(),
});

export interface ProfileModuleOptions {
  /** Defaults to dockerode on the local socket (`DOCKER_HOST` or `/var/run/docker.sock`). */
  backend?: () => DockerBackend;
  env?: NodeJS.ProcessEnv;
  /** Test overrides for timings and the readiness probe. */
  manager?: Partial<
    Pick<
      DockerManagerOptions,
      'readyProbe' | 'readyTimeoutMs' | 'crashBackoffMs' | 'pollMs' | 'reconcileMs' | 'now' | 'seatLimit'
    >
  >;
}

let current: DockerManager | undefined;

/** The running agent's docker manager (actions use it for proxy credentials); undefined before start. */
export function profileManager(): DockerManager | undefined {
  return current;
}

export function createProfileModule(opts: ProfileModuleOptions = {}): AgentModule & {
  manager(): DockerManager | undefined;
} {
  let manager: DockerManager | undefined;
  const need = () => {
    if (!manager) throw new Error('profile module used before start');
    return manager;
  };
  return {
    name: 'profile',
    manager: () => manager,
    handlers: {
      'profile.start': (cmd, ctx) => need().start(cmd, ctx.signal),
      'profile.stop': (cmd) => need().stop(cmd.profileId),
      'profile.remove': (cmd) => need().remove(cmd.profileId),
    },
    async start(ctx) {
      const env = ProfileEnv.parse(opts.env ?? process.env);
      const securityOpt = env.BROWSER_SECCOMP_PROFILE
        ? [`seccomp=${readFileSync(env.BROWSER_SECCOMP_PROFILE, 'utf8')}`]
        : [];
      manager = new DockerManager({
        backend: (opts.backend ?? dockerodeBackend)(),
        log: ctx.log,
        emit: ctx.emit,
        nodeName: ctx.config.nodeName,
        image: ctx.config.browserImage,
        network: ctx.config.browserNetwork,
        maxProfiles: ctx.config.maxProfiles,
        seatLimit: env.NODE_SEAT_LIMIT ?? null,
        licenseKey: ctx.config.cloakLicenseKey,
        securityOpt,
        // Proxy credentials stay in agent memory; the watcher answers the browser's 407 from launch on, so
        // neither actions nor the owner over VNC ever see Chromium's proxy sign-in dialog.
        onUp: (profileId, proxy, geo) => {
          // Plan 0004 phase 8: the browser's location setting, applied to every tab while it runs.
          geoWatchers.set(profileId, geo ?? null);
          profileProxies.set(profileId, proxy, ctx.secrets);
          if (proxy?.username) proxyAuthWatchers.watch(profileId);
          else proxyAuthWatchers.unwatch(profileId);
        },
        onDown: (profileId) => {
          geoWatchers.set(profileId, null);
          proxyAuthWatchers.unwatch(profileId);
          profileProxies.delete(profileId);
        },
        ...opts.manager,
      });
      current = manager;
      proxyAuthWatchers.useLogger(ctx.log);
      geoWatchers.useLogger(ctx.log);
      const m = manager;
      ctx.status.setProvider({
        running: () => m.running(),
        seats: () => m.seats(),
        imageDigest: () => m.imageDigest(),
        docker: () => m.docker(),
      });
      await m.init();
    },
    stop() {
      manager?.close();
      if (current === manager) current = undefined;
    },
  };
}

export const profileModule = createProfileModule();
