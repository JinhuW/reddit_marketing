import { signIn } from '@/auth';
import { Icon } from '@/components/ui/icon';
import { erpSignIn } from '@/lib/actions/erp-sign-in';
import { erpConfigured } from '@/lib/erp-auth';
import { getCurrentMember } from '@/lib/session';
import type { Metadata } from 'next';
import { redirect } from 'next/navigation';

export const metadata: Metadata = { title: 'Sign in' };

const ERRORS: Record<string, string> = {
  not_invited: 'That email is not a member of any workspace. Ask an admin to invite you.',
  Verification: 'That sign-in link has expired or was already used. Request a new one.',
  AccessDenied: 'That email is not a member of any workspace. Ask an admin to invite you.',
  erp_invalid: 'Wrong email or password. Use your Recycle Servers ERP login.',
  erp_locked: 'Too many attempts. Wait 15 minutes and try again.',
  erp_unavailable: 'The ERP did not answer. Try again in a minute.',
};

export default async function LoginPage({
  searchParams,
}: { searchParams: Promise<Record<string, string | undefined>> }) {
  if (await getCurrentMember()) redirect('/');
  const sp = await searchParams;
  const error = sp.error ? (ERRORS[sp.error] ?? 'Sign-in failed. Try again.') : null;
  const google = Boolean(process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET);
  const erp = erpConfigured();
  // With ERP sign-in on, magic links are offered only when real mail delivery is configured.
  const magicLink = !erp || Boolean(process.env.RESEND_API_KEY);

  async function emailSignIn(form: FormData) {
    'use server';
    await signIn('resend', {
      email: String(form.get('email') ?? '')
        .trim()
        .toLowerCase(),
      redirectTo: '/',
    });
  }
  async function googleSignIn() {
    'use server';
    await signIn('google', { redirectTo: '/' });
  }

  return (
    <main className="grid min-h-screen place-items-center px-4">
      <div className="panel flex w-full max-w-[380px] flex-col gap-5 p-7">
        <div className="flex items-center gap-2.5">
          <span className="grid h-8 w-8 place-items-center rounded-lg bg-accent text-white">
            <Icon name="logo" strokeWidth={1.9} />
          </span>
          <span className="text-lg font-bold tracking-[-0.01em]">Threadline</span>
        </div>
        {sp.type === 'email' ? (
          <div className="flex flex-col gap-2">
            <h1 className="m-0 text-lg font-semibold">Check your email</h1>
            <p className="muted m-0 text-[13px]">We sent a sign-in link. It expires in one hour.</p>
          </div>
        ) : (
          <>
            <div>
              <h1 className="m-0 text-lg font-semibold">Sign in</h1>
              <p className="muted m-0 mt-1 text-[13px]">
                {erp
                  ? 'Use your Recycle Servers ERP email and password.'
                  : 'We’ll email you a link. No password.'}
              </p>
            </div>
            {error ? (
              <p role="alert" className="m-0 rounded-[9px] bg-bad-soft px-3 py-2 text-[13px] text-bad">
                {error}
              </p>
            ) : null}
            {erp ? (
              <form action={erpSignIn} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                  Email
                  <input name="email" type="email" required autoComplete="username" className="field" />
                </label>
                <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                  Password
                  <input
                    name="password"
                    type="password"
                    required
                    autoComplete="current-password"
                    className="field"
                  />
                </label>
                <button type="submit" className="btn btn-primary !h-9">
                  Sign in
                </button>
              </form>
            ) : null}
            {magicLink ? (
              <form action={emailSignIn} className="flex flex-col gap-3">
                <label className="flex flex-col gap-1.5 text-[13px] font-medium">
                  Work email
                  <input
                    name="email"
                    type="email"
                    required
                    autoComplete="email"
                    className="field"
                    placeholder="jane@acme.so"
                  />
                </label>
                <button type="submit" className={erp ? 'btn !h-9' : 'btn btn-primary !h-9'}>
                  Email me a sign-in link
                </button>
              </form>
            ) : null}
            {google ? (
              <form action={googleSignIn}>
                <button type="submit" className="btn !h-9 w-full">
                  Continue with Google
                </button>
              </form>
            ) : null}
          </>
        )}
      </div>
    </main>
  );
}
