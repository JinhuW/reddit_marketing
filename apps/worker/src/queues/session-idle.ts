import { prisma } from '@threadline/db';

const IDLE_MS = 15 * 60_000;

/** session.idle — ends human VNC sessions with no log activity for 15 minutes and resumes the agent. */
export async function sessionIdle() {
  const open = await prisma.browserSession.findMany({ where: { endedAt: null, driver: 'human' } });
  let ended = 0;
  for (const s of open) {
    const last = await prisma.auditEvent.findFirst({
      where: { sessionId: s.id },
      orderBy: { at: 'desc' },
      select: { at: true },
    });
    const lastAt = last?.at ?? s.startedAt;
    if (Date.now() - lastAt.getTime() < IDLE_MS) continue;
    await prisma.$transaction([
      prisma.browserSession.update({ where: { id: s.id }, data: { endedAt: new Date() } }),
      prisma.auditEvent.create({
        data: {
          workspaceId: s.workspaceId,
          action: 'session.ended',
          targetType: 'BrowserSession',
          targetId: s.id,
          sessionId: s.id,
          meta: { reason: 'idle 15 minutes' },
        },
      }),
    ]);
    ended++;
  }
  return { ended };
}
