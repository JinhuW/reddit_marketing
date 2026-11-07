import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

/**
 * Dev / CI mail sink: with no RESEND_API_KEY the magic link is printed to the server log and appended to
 * data/dev-mail.log so Playwright can read it. Never used when RESEND_API_KEY is set.
 */
export async function devSendMagicLink(to: string, url: string) {
  console.info(`\n[auth] Magic link for ${to}:\n${url}\n`);
  const dir = join(process.cwd(), '..', '..', 'data');
  await mkdir(dir, { recursive: true });
  await appendFile(
    join(dir, 'dev-mail.log'),
    `${JSON.stringify({ to, url, at: new Date().toISOString() })}\n`,
  );
}
