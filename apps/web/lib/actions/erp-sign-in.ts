'use server';
import { sessions } from '@threadline/db';
import { cookies, headers } from 'next/headers';
import { redirect } from 'next/navigation';
import { erpLogin, memberRoleForErp } from '../erp-auth';
import { allow } from '../rate-limit';

/**
 * Password sign-in against the ERP. On success it writes the same database session Auth.js would and sets
 * Auth.js's session cookie, so `auth()`, sign-out and every role check work unchanged.
 */
export async function erpSignIn(form: FormData) {
  const email = String(form.get('email') ?? '')
    .trim()
    .toLowerCase();
  const password = String(form.get('password') ?? '');
  if (!email || !password) redirect('/login?error=erp_invalid');

  const h = await headers();
  const ip = (h.get('x-forwarded-for') ?? '').split(',')[0]?.trim() || 'unknown';
  if (!(await allow(`erp-login:${ip}`, 10, 300)) || !(await allow(`erp-login:${email}`, 10, 300)))
    redirect('/login?error=erp_locked');

  const r = await erpLogin(email, password);
  if (!r.ok) redirect(`/login?error=erp_${r.reason}`);

  const { user } = await sessions.ensureErpMember({
    email: r.user.email,
    name: r.user.name,
    ...memberRoleForErp(r.user.role),
    workspaceSlug: process.env.ERP_WORKSPACE_SLUG || null,
  });
  const { sessionToken, expires } = await sessions.createSession(user.id);

  const secure = h.get('x-forwarded-proto') === 'https' || (process.env.APP_URL ?? '').startsWith('https://');
  (await cookies()).set(secure ? '__Secure-authjs.session-token' : 'authjs.session-token', sessionToken, {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    secure,
    expires,
  });
  redirect('/');
}
