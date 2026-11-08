/**
 * What the agent reports in `hello`, `heartbeat` and `health.check`. The docker manager (T21) plugs in real
 * providers via {@link StatusStore.setProvider}; until then the node reports no running profiles, no seats in use
 * and docker `error` (it has no way to know docker is fine).
 */
import type { ProfileRef, Seats } from '@threadline/shared';

export interface StatusProvider {
  running(): ProfileRef[];
  seats(): Seats;
  imageDigest(): string | null;
  docker(): Promise<'ok' | 'error'>;
}

const defaults: StatusProvider = {
  running: () => [],
  seats: () => ({ inUse: 0, limit: null }),
  imageDigest: () => null,
  docker: async () => 'error',
};

export class StatusStore {
  private provider: StatusProvider = { ...defaults };

  constructor(readonly maxProfiles: number) {}

  setProvider(p: Partial<StatusProvider>): void {
    this.provider = { ...this.provider, ...p };
  }

  running(): ProfileRef[] {
    return this.provider.running();
  }

  seats(): Seats {
    return this.provider.seats();
  }

  imageDigest(): string | null {
    return this.provider.imageDigest();
  }

  async docker(): Promise<'ok' | 'error'> {
    try {
      return await this.provider.docker();
    } catch {
      return 'error';
    }
  }
}
