'use server';

import { WS_COOKIE, requireMember } from '@/lib/session';
import { members } from '@threadline/db';
import { cookies } from 'next/headers';
import { redirect } from 'next/navigation';

export async function switchWorkspace(form: FormData) {
  const me = await requireMember();
  const slug = String(form.get('slug') ?? '');
  const target = await members.findMembership(me.userId, slug);
  if (target) (await cookies()).set(WS_COOKIE, slug, { httpOnly: true, sameSite: 'lax', path: '/' });
  redirect('/');
}
