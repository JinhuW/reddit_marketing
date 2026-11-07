/**
 * browser.health with an in-memory node queue against the seeded Postgres, plus the Redis-backed producer
 * against the local Redis (REDIS_URL; a throwaway node queue that is obliterated afterwards).
 */
import { nodes, prisma } from '@threadline/db';
import { type BrowserJob, browserQueue } from '@threadline/shared';
import { Queue } from 'bullmq';
import { afterAll, describe, expect, it } from 'vitest';
import { redisConnection } from '../connection';
import {
  HEALTH_EVERY_MS,
  browserHealth,
  createBrowserQueues,
  memoryBrowserQueues,
  seatsFromResult,
} from './browser-health';

afterAll(async () => {
  const n = await prisma.browserNode.findFirst({ where: { name: 'browser-1' } });
  if (n) await nodes.markOffline(n.id, 'test');
  await prisma.$disconnect();
});

describe('seatsFromResult', () => {
  it('reads HealthData bare or under data, and ignores anything else', () => {
    const seats = { inUse: 2, limit: 5 };
    expect(seatsFromResult({ running: [], seats, docker: 'ok' })).toEqual(seats);
    expect(seatsFromResult({ outcome: 'ok', data: { running: [], seats, docker: 'ok' } })).toEqual(seats);
    expect(seatsFromResult({ outcome: 'ok', data: { seats: { inUse: -1, limit: null } } })).toBeNull();
    expect(seatsFromResult(null)).toBeNull();
    expect(seatsFromResult('ok')).toBeNull();
  });
});

describe('browser.health', () => {
  it('queues one health.check per online node and none for offline nodes', async () => {
    const n = await prisma.browserNode.findFirstOrThrow({ where: { name: 'browser-1' } });
    await nodes.markOffline(n.id, 'test');
    const mem = memoryBrowserQueues();
    expect(await browserHealth(undefined, { browser: mem })).toEqual({ enqueued: 0, recorded: 0 });

    await nodes.markOnline(n.id, {
      agentVersion: 't',
      imageDigest: null,
      maxProfiles: 8,
      seats: { inUse: 0, limit: 5 },
    });
    const now = new Date();
    const bucket = Math.floor(now.getTime() / HEALTH_EVERY_MS);
    expect(await browserHealth(undefined, { browser: mem, now })).toEqual({ enqueued: 1, recorded: 0 });
    expect(mem.jobs.get(`browser-1/bj-health.check-${n.workspaceId}-${bucket}`)?.job).toEqual({
      kind: 'health.check',
      workspaceId: n.workspaceId,
    });
    // same window again: deduplicated by job id
    expect((await browserHealth(undefined, { browser: mem, now })).enqueued).toBe(0);
  });

  it("records the seats from the previous window's completed check", async () => {
    const n = await prisma.browserNode.findFirstOrThrow({ where: { name: 'browser-1' } });
    await nodes.markOnline(n.id, {
      agentVersion: 't',
      imageDigest: null,
      maxProfiles: 8,
      seats: { inUse: 0, limit: 5 },
    });
    const mem = memoryBrowserQueues();
    const t0 = new Date();
    await browserHealth(undefined, { browser: mem, now: t0 });
    const bucket = Math.floor(t0.getTime() / HEALTH_EVERY_MS);
    mem.finish('browser-1', `bj-health.check-${n.workspaceId}-${bucket}`, {
      outcome: 'ok',
      data: { running: [{ profileId: 'p', startedAt: 1 }], seats: { inUse: 3, limit: 5 }, docker: 'ok' },
    });

    const out = await browserHealth(undefined, {
      browser: mem,
      now: new Date(t0.getTime() + HEALTH_EVERY_MS),
    });
    expect(out).toEqual({ enqueued: 1, recorded: 1 });
    const after = await prisma.browserNode.findUniqueOrThrow({ where: { id: n.id } });
    expect(after.seatsInUse).toBe(3);
    expect(after.seatsLimit).toBe(5);
  });
});

describe('createBrowserQueues (Redis)', () => {
  const node = `t25-${process.pid}`;
  const browser = createBrowserQueues();

  afterAll(async () => {
    await browser.close();
    const q = new Queue(browserQueue(node), { connection: redisConnection() });
    await q.obliterate({ force: true });
    await q.close();
  });

  const job: BrowserJob = { kind: 'action.sendDm', workspaceId: 'w1', profileId: 'p1', draftId: 'd1' };

  it('adds once per job id, reports state and in-flight drafts', async () => {
    expect(await browser.add(node, job, 'bj-action.sendDm-d1')).toBe(true);
    expect(await browser.add(node, job, 'bj-action.sendDm-d1')).toBe(false);
    expect((await browser.get(node, 'bj-action.sendDm-d1'))?.state).toBe('waiting');
    expect(await browser.get(node, 'bj-action.sendDm-nope')).toBeNull();
    expect(await browser.inFlight(node, 'd1')).toBe(true);
    expect(await browser.inFlight(node, 'd2')).toBe(false);
  });

  it('a delayed job sits in delayed and counts as in flight', async () => {
    const later = { ...job, draftId: 'd4' };
    expect(await browser.add(node, later, 'bj-action.sendDm-d4-s1', { delay: 10_000 })).toBe(true);
    expect((await browser.get(node, 'bj-action.sendDm-d4-s1'))?.state).toBe('delayed');
    expect(await browser.inFlight(node, 'd4')).toBe(true);
  });

  it('refuses payloads with extra fields and bad node names', async () => {
    const leaky = { ...job, draftId: 'd3', password: 'hunter2' } as unknown as BrowserJob;
    await expect(browser.add(node, leaky, 'bj-action.sendDm-d3')).rejects.toThrow();
    await expect(browser.add('Bad Name', job, 'bj-x')).rejects.toThrow();
  });
});
