import { QUEUES } from '@threadline/shared';
import type { Queue } from 'bullmq';
import { describe, expect, it } from 'vitest';
import { coreProcessors } from './core';

describe('core role', () => {
  const processors = coreProcessors(() => ({}) as Queue);

  it('runs every queue except browser.health', () => {
    const expected = Object.values(QUEUES).filter((n) => n !== QUEUES.browserHealth);
    expect(Object.keys(processors).sort()).toEqual([...expected].sort());
    expect(processors).not.toHaveProperty(QUEUES.browserHealth);
  });

  it('runs no per-node browser queue', () => {
    expect(Object.keys(processors).filter((n) => n.startsWith('browser.'))).toEqual([]);
  });

  it('publishes one post at a time', () => {
    expect(processors[QUEUES.postPublish].concurrency).toBe(1);
  });
});
