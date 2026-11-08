import { browsers, prisma } from '@threadline/db';
import { type BrowserJob, browserJobId } from '@threadline/shared';
import type { Job } from 'bullmq';
import { log } from '../log';
import { type BrowserQueues, sharedBrowserQueues } from './browser-health';
import { FALLBACK_ATTEMPTS, fallbackJob } from './post-publish';

const IDLE_MS = 15 * 60_000;
/** How far back the sweep looks for hand-backs. Job ids keyed on the session make re-runs no-ops. */
export const HANDBACK_LOOKBACK_MS = 60 * 60_000;
/** A re-queued browser action waits this long in `delayed`, so the account's pause is cleared before dispatch. */
export const REQUEUE_DELAY_MS = 10_000;

export interface SessionIdleDeps {
  browser?: BrowserQueues;
  now?: Date;
}

/**
 * session.idle (every minute):
 * 1. Ends human VNC sessions with no log activity for 15 minutes and resumes the agent; the profile's container
 *    is stopped through its node queue (`profile.stop`, reason `idle`).
 * 2. Picks up hand-backs (`session.handed_back`): every approved comment/DM the browser already tried for that
 *    account is queued again (delayed by REQUEUE_DELAY_MS), and only then is the `needs_human` pause that sent the
 *    owner to the browser cleared, so the queue finishes the post (PLAN §8 M6 acceptance) and post.publish never
 *    sees the account runnable without the browser job in flight. The gateway re-checks approval before it acts.
 */
export async function sessionIdle(_job?: Job, deps: SessionIdleDeps = {}) {
  const now = deps.now ?? new Date();
  let browser = deps.browser;
  const q = () => {
    browser ??= sharedBrowserQueues();
    return browser;
  };

  const open = await prisma.browserSession.findMany({
    where: { endedAt: null, driver: 'human' },
    include: { profile: { select: { id: true, node: { select: { name: true } } } } },
  });
  let ended = 0;
  let stopped = 0;
  for (const s of open) {
    const last = await prisma.auditEvent.findFirst({
      where: { sessionId: s.id },
      orderBy: { at: 'desc' },
      select: { at: true },
    });
    const lastAt = last?.at ?? s.startedAt;
    if (now.getTime() - lastAt.getTime() < IDLE_MS) continue;
    const changed = await prisma.$transaction(async (tx) => {
      const { count } = await tx.browserSession.updateMany({
        where: { id: s.id, endedAt: null },
        data: { endedAt: now },
      });
      if (count === 0) return false; // handed back or ended elsewhere meanwhile
      await tx.auditEvent.create({
        data: {
          workspaceId: s.workspaceId,
          action: 'session.ended',
          targetType: 'BrowserSession',
          targetId: s.id,
          sessionId: s.id,
          meta: { reason: 'idle 15 minutes' },
        },
      });
      return true;
    });
    if (!changed) continue;
    ended++;
    const node = s.profile.node?.name;
    if (node) {
      const job: BrowserJob = {
        kind: 'profile.stop',
        workspaceId: s.workspaceId,
        profileId: s.profile.id,
        reason: 'idle',
      };
      if (await q().add(node, job, browserJobId(job, s.id))) stopped++;
    }
  }

  const handBacks = await resumeHandedBack(now, q);
  return { ended, stopped, ...handBacks };
}

async function resumeHandedBack(now: Date, q: () => BrowserQueues) {
  const events = await prisma.auditEvent.findMany({
    where: {
      action: 'session.handed_back',
      at: { gte: new Date(now.getTime() - HANDBACK_LOOKBACK_MS) },
      sessionId: { not: null },
    },
    orderBy: { at: 'asc' },
    select: { sessionId: true, actorMemberId: true, at: true, workspaceId: true },
  });
  let resumed = 0;
  let requeued = 0;
  for (const ev of events) {
    const s = await prisma.browserSession.findUnique({
      where: { id: ev.sessionId! },
      select: {
        id: true,
        workspaceId: true,
        profile: {
          select: {
            id: true,
            node: { select: { name: true } },
            account: { select: { id: true, pausedReason: true, pausedAt: true } },
          },
        },
      },
    });
    if (!s) continue;
    const acc = s.profile.account;

    // Only a needs_human pause from before the hand-back: a newer one means the browser hit another wall.
    const resumable = acc.pausedReason === 'needs_human' && acc.pausedAt !== null && acc.pausedAt <= ev.at;
    if (acc.pausedReason && !resumable) continue;

    // Re-queue BEFORE the resume. While the account is paused, post.publish skips it; once it runs again,
    // publishDraft's inFlight() check must already see the browser job, or the minute sweep (which fires at the
    // same moment as this one) could post the same draft through the API while the browser posts it too. The
    // job is delayed so it sits in `delayed` (in flight) and is not dispatched before the pause is cleared.
    const node = s.profile.node?.name;
    if (node) {
      const due = await prisma.draft.findMany({
        where: {
          accountId: acc.id,
          type: { in: ['comment', 'dm'] },
          approverMemberId: { not: null },
          OR: [{ status: 'approved' }, { status: 'scheduled', scheduledFor: { lte: now } }],
        },
        select: { id: true, workspaceId: true, type: true },
      });
      for (const d of due) {
        const job = fallbackJob(d, s.profile.id);
        if (!job) continue;
        // Never tried in the browser: the post.publish sweep takes it through the API once the account runs.
        if (!(await q().get(node, browserJobId(job)))) continue;
        if (await q().inFlight(node, d.id)) continue;
        // A new id per hand-back: the agent would replay the stored needs_human result for the old one.
        const added = await q().add(node, job, browserJobId(job, s.id), {
          attempts: FALLBACK_ATTEMPTS,
          delay: REQUEUE_DELAY_MS,
        });
        if (added) {
          requeued++;
          log.info({ draftId: d.id, node, sessionId: s.id }, 'browser action re-queued after hand-back');
        }
      }
    }

    if (resumable) {
      const r = await browsers.resumeAccount({
        workspaceId: s.workspaceId,
        accountId: acc.id,
        actorMemberId: ev.actorMemberId,
        onlyReasons: ['needs_human'],
      });
      if (r.changed) resumed++;
    }
  }
  return { resumed, requeued };
}
