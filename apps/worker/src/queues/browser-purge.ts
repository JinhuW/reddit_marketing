import { browsers } from '@threadline/db';
import { type BrowserJob, browserJobId } from '@threadline/shared';
import type { Job } from 'bullmq';
import { log } from '../log';
import { type BrowserQueues, sharedBrowserQueues } from './browser-health';

export const PURGE_EVERY_MS = 6 * 3600_000;

export interface BrowserPurgeDeps {
  browser?: BrowserQueues;
  now?: Date;
}

/**
 * trash.purge (every 6 hours; docs/plans/0004-browser-parity.md): browsers that sat in the trash for
 * `browsers.TRASH_DAYS` are deleted for good.
 * - On a node that is online: `profile.remove` (then `purge`) goes on the node's queue; the gateway marks the
 *   browser purged only after the node deleted the container and volume.
 * - Never assigned to a node: there is no volume anywhere, so it is marked purged here.
 * - Node offline or draining: left for the next run, so no volume is orphaned.
 */
export async function browserPurge(_job?: Job, deps: BrowserPurgeDeps = {}) {
  const now = deps.now ?? new Date();
  let browser = deps.browser;
  const day = Math.floor(now.getTime() / (24 * 3600_000)).toString(36);
  let queued = 0;
  let purged = 0;
  let waiting = 0;
  for (const p of await browsers.listPurgeDue(now)) {
    if (!p.node) {
      if ((await browsers.purgeProfile(p.workspaceId, p.id, null)).purged) purged++;
      continue;
    }
    if (p.node.status !== 'online') {
      waiting++;
      continue;
    }
    browser ??= sharedBrowserQueues();
    const job: BrowserJob = {
      kind: 'profile.remove',
      workspaceId: p.workspaceId,
      profileId: p.id,
      then: 'purge',
    };
    // One try per day: a node that keeps refusing is retried tomorrow under a new id.
    if (await browser.add(p.node.name, job, browserJobId(job, day), { attempts: 3, keepSec: 2 * 24 * 3600 }))
      queued++;
  }
  if (queued || purged || waiting) log.info({ queued, purged, waiting }, 'trash.purge sweep');
  return { queued, purged, waiting };
}
