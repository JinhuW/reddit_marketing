import { PrismaAdapter } from '@auth/prisma-adapter';
import { prisma } from '@threadline/db';
import NextAuth from 'next-auth';
import type { Provider } from 'next-auth/providers';
import Google from 'next-auth/providers/google';
import Resend from 'next-auth/providers/resend';
import { devSendMagicLink } from './lib/auth-dev-mail';

const from = process.env.AUTH_EMAIL_FROM ?? 'login@threadline.app';

const providers: Provider[] = [
  process.env.RESEND_API_KEY
    ? Resend({ apiKey: process.env.RESEND_API_KEY, from })
    : {
        id: 'resend',
        name: 'Email',
        type: 'email',
        from,
        maxAge: 60 * 60,
        options: {},
        async sendVerificationRequest({ identifier, url }) {
          await devSendMagicLink(identifier, url);
        },
      },
];
if (process.env.AUTH_GOOGLE_ID && process.env.AUTH_GOOGLE_SECRET) providers.push(Google);

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(prisma),
  session: { strategy: 'database' },
  trustHost: true,
  providers,
  pages: { signIn: '/login', verifyRequest: '/login', error: '/login' },
  callbacks: {
    // Invite-only: a person can sign in only if they already belong to a workspace.
    async signIn({ user }) {
      if (!user.email) return false;
      const member = await prisma.workspaceMember.findFirst({
        where: { user: { email: user.email.toLowerCase() } },
      });
      return member ? true : '/login?error=not_invited';
    },
  },
});
