/** Integration: API keys for /api/v1 (docs/plans/0004-browser-parity.md, phase 7). */
import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '../client';
import { testWorkspace } from '../testing/fixtures';
import * as apiKeys from './api-keys';

afterAll(() => prisma.$disconnect());

describe('apiKeys', () => {
  it('shows a key once, stores only its hash, and verifies it as its member', async () => {
    const ws = await testWorkspace();
    try {
      const me = await ws.member();
      const made = await apiKeys.createApiKey(ws.id, me.id, '  inventory   script ');
      expect(made.name).toBe('inventory script');
      expect(made.key).toMatch(/^tl_[A-Za-z0-9_-]{43}$/);
      const row = await prisma.apiKey.findUniqueOrThrow({ where: { id: made.id } });
      expect(row.keyHash).toMatch(/^[0-9a-f]{64}$/);
      expect(JSON.stringify([row, await apiKeys.listApiKeys(ws.id)])).not.toContain(made.key);
      expect((await apiKeys.listApiKeys(ws.id))[0]).toMatchObject({
        name: 'inventory script',
        lastUsedAt: null,
      });

      expect(await apiKeys.verifyApiKey(made.key)).toMatchObject({
        keyId: made.id,
        workspaceId: ws.id,
        id: me.id,
        role: 'editor',
      });
      expect((await prisma.apiKey.findUniqueOrThrow({ where: { id: made.id } })).lastUsedAt).not.toBeNull();
      for (const bad of ['', 'tl_', `${made.key}x`, made.key.replace('tl_', 'xx_'), 'tl_'.padEnd(46, 'A')])
        expect(await apiKeys.verifyApiKey(bad)).toBeNull();
      await expect(apiKeys.createApiKey(ws.id, me.id, '   ')).rejects.toThrow(/name/);
    } finally {
      await ws.cleanup();
    }
  });

  it('a revoked key stops working at once; another workspace cannot revoke it', async () => {
    const ws = await testWorkspace();
    const other = await testWorkspace();
    try {
      const me = await ws.member();
      const made = await apiKeys.createApiKey(ws.id, me.id, 'k');
      await expect(apiKeys.revokeApiKey(other.id, (await other.member()).id, made.id)).rejects.toThrow(
        /not found/,
      );
      expect(await apiKeys.verifyApiKey(made.key)).not.toBeNull();
      expect(await apiKeys.revokeApiKey(ws.id, me.id, made.id)).toEqual({ changed: true });
      expect(await apiKeys.revokeApiKey(ws.id, me.id, made.id)).toEqual({ changed: false });
      expect(await apiKeys.verifyApiKey(made.key)).toBeNull();
      const actions = (
        await prisma.auditEvent.findMany({ where: { workspaceId: ws.id, targetId: made.id } })
      ).map((a) => a.action);
      expect(actions.sort()).toEqual(['api_key.created', 'api_key.revoked']);
    } finally {
      await ws.cleanup();
      await other.cleanup();
    }
  });
});
