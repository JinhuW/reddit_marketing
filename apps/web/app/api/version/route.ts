/** The build this server runs. Open tabs poll it and show the update banner when it differs from theirs. */
export const dynamic = 'force-dynamic';

export function GET() {
  return Response.json(
    { buildId: process.env.NEXT_PUBLIC_BUILD_ID ?? null },
    { headers: { 'Cache-Control': 'no-store, max-age=0' } },
  );
}
