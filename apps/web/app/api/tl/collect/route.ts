import { allow, clientIp } from '@/lib/rate-limit';
import { prisma } from '@threadline/db';
import { CollectBeacon } from '@threadline/shared';

export const dynamic = 'force-dynamic';

function cors(origin: string | null, allowed: boolean): Record<string, string> {
  return allowed && origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        Vary: 'Origin',
      }
    : {};
}

async function allowedOrigin(ws: string, origin: string | null) {
  if (!origin) return null;
  const w = await prisma.workspace.findUnique({ where: { slug: ws }, select: { id: true, settings: true } });
  const list = ((w?.settings as { allowedOrigins?: string[] } | null)?.allowedOrigins ?? []).map((o) =>
    o.replace(/\/$/, ''),
  );
  return w && list.includes(origin.replace(/\/$/, '')) ? w.id : null;
}

export async function OPTIONS(req: Request) {
  const origin = req.headers.get('origin');
  const ws = new URL(req.url).searchParams.get('ws') ?? '';
  return new Response(null, { status: 204, headers: cors(origin, Boolean(await allowedOrigin(ws, origin))) });
}

/** Beacon from public/tl.js: pageview / signup / trial. Origin must be in the workspace's allowed origins. */
export async function POST(req: Request) {
  const origin = req.headers.get('origin');
  if (!(await allow(`collect:${clientIp(req)}`, 120, 60)))
    return new Response('Too many requests', { status: 429 });
  let body: unknown;
  try {
    body = JSON.parse(await req.text());
  } catch {
    return new Response('Bad JSON', { status: 400 });
  }
  const parsed = CollectBeacon.safeParse(body);
  if (!parsed.success) return new Response('Invalid beacon', { status: 400 });
  const workspaceId = await allowedOrigin(parsed.data.ws, origin);
  if (!workspaceId) return new Response('Origin not allowed', { status: 403 });

  const { vid, kind, email, url, ref } = parsed.data;
  await prisma.siteEvent.create({
    data: {
      workspaceId,
      visitorId: vid,
      kind,
      email: email?.toLowerCase() ?? null,
      meta: { url: url ?? null, ref: ref ?? null },
    },
  });
  return new Response(null, { status: 204, headers: cors(origin, true) });
}
