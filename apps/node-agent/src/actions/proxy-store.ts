/**
 * Per-profile proxy credentials, in agent memory only (ADR-0001: they arrive with `profile.start`, decrypted by
 * the gateway, and never touch disk, argv or logs).
 *
 * The profile module (T21) records the proxy when it starts a container and forgets it when the container stops;
 * the actions read it to answer the browser's proxy challenge over CDP `Fetch.authRequired` and to reach the
 * proxy from the agent for `profile.testProxy`.
 */
import type { ProxySpec } from '@threadline/shared';
import type { SecretSet } from '../log';

/** Returns the proxy a running profile was started with: `null` for "no proxy", `undefined` for "unknown". */
export type ProxyLookup = (profileId: string) => ProxySpec | null | undefined;

export class ProfileProxies {
  private readonly byProfile = new Map<string, ProxySpec | null>();

  /** Record the proxy from `profile.start`; pass `secrets` so the password is scrubbed from logs and results. */
  set(profileId: string, proxy: ProxySpec | null, secrets?: SecretSet): void {
    if (proxy?.password) secrets?.add(proxy.password);
    this.byProfile.set(profileId, proxy ? { ...proxy } : null);
  }

  get(profileId: string): ProxySpec | null | undefined {
    return this.byProfile.get(profileId);
  }

  delete(profileId: string): void {
    this.byProfile.delete(profileId);
  }

  clear(): void {
    this.byProfile.clear();
  }

  readonly lookup: ProxyLookup = (profileId) => this.get(profileId);
}

/** The agent-wide store. T21's `profile.start` calls `profileProxies.set(...)`, `profile.stop` calls `delete`. */
export const profileProxies = new ProfileProxies();
