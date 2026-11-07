import { getCurrentMember } from '@/lib/session';
import { shell } from '@threadline/db';

export const dynamic = 'force-dynamic';

/**
 * Server-Sent Events: queue counts for the sidebar every 10s.
 * Agent status and browser session logs are added to this stream by their milestones.
 */
export async function GET(req: Request) {
  const me = await getCurrentMember();
  if (!me) return new Response('Unauthorized', { status: 401 });
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream({
    async start(controller) {
      const push = async () => {
        try {
          const counts = await shell.shellCounts(me.workspaceId, me.id);
          controller.enqueue(enc.encode(`event: counts\ndata: ${JSON.stringify(counts)}\n\n`));
        } catch {
          // DB hiccup: skip this tick
        }
      };
      controller.enqueue(enc.encode('retry: 10000\n\n'));
      await push();
      timer = setInterval(push, 10_000);
      req.signal.addEventListener('abort', () => {
        clearInterval(timer);
        try {
          controller.close();
        } catch {}
      });
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
    },
  });
}
