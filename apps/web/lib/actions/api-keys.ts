'use server';

// Plan 0004 phase 7: API keys for /api/v1. Admins only. A key acts as the admin who made it.
import { ForbiddenError, requireRole } from '@/lib/session';
import { apiKeys } from '@threadline/db';
import { revalidatePath } from 'next/cache';

export interface KeyState {
  ok: boolean;
  message: string;
  /** the new key; present once, right after it was made */
  key?: string;
}

const say = (e: unknown) =>
  e instanceof ForbiddenError || e instanceof apiKeys.ApiKeyError ? e.message : null;

export async function createApiKeyAction(_prev: KeyState | null, form: FormData): Promise<KeyState> {
  try {
    const me = await requireRole('admin');
    const r = await apiKeys.createApiKey(me.workspaceId, me.id, String(form.get('name') ?? ''));
    revalidatePath('/browsers/api');
    return { ok: true, message: `Key ${r.name} created. Copy it now: it is not shown again.`, key: r.key };
  } catch (e) {
    const m = say(e);
    if (m) return { ok: false, message: m };
    throw e;
  }
}

export async function revokeApiKeyAction(_prev: KeyState | null, form: FormData): Promise<KeyState> {
  try {
    const me = await requireRole('admin');
    await apiKeys.revokeApiKey(me.workspaceId, me.id, String(form.get('id') ?? ''));
    revalidatePath('/browsers/api');
    return { ok: true, message: 'Key revoked. Calls with it are refused from now on.' };
  } catch (e) {
    const m = say(e);
    if (m) return { ok: false, message: m };
    throw e;
  }
}
