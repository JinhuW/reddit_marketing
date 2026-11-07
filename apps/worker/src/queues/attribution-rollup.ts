import { prisma } from '@threadline/db';
import { ATTRIBUTION_WINDOW_DAYS, lastClick, stageAfterEvent } from '@threadline/shared';
import { log } from '../log';

/**
 * attribution.rollup — every 15 min. Matches signup/trial/payment SiteEvents to the visitor's last
 * tracked-link click (30 days), then to a lead (a click visitor already attributed to a lead, or the
 * lead whose signupEmail matches), writes Attribution, and moves the lead stage forward.
 */
export async function attributionRollup() {
  const events = await prisma.siteEvent.findMany({
    where: { kind: { in: ['signup', 'trial', 'payment'] }, attributions: { none: {} } },
    orderBy: { occurredAt: 'asc' },
    take: 500,
  });
  let written = 0;
  for (const ev of events) {
    const clicks = ev.visitorId
      ? await prisma.clickEvent.findMany({
          where: {
            workspaceId: ev.workspaceId,
            visitorId: ev.visitorId,
            occurredAt: {
              gte: new Date(ev.occurredAt.getTime() - ATTRIBUTION_WINDOW_DAYS * 86_400_000),
              lte: ev.occurredAt,
            },
          },
        })
      : [];
    const click = lastClick(ev, clicks);
    if (!click) continue;

    const prior = ev.visitorId
      ? await prisma.attribution.findFirst({
          where: {
            workspaceId: ev.workspaceId,
            leadId: { not: null },
            siteEvent: { visitorId: ev.visitorId },
          },
        })
      : null;
    const lead = prior?.leadId
      ? await prisma.lead.findUnique({ where: { id: prior.leadId } })
      : ev.email
        ? await prisma.lead.findFirst({ where: { workspaceId: ev.workspaceId, signupEmail: ev.email } })
        : null;

    await prisma.$transaction(async (tx) => {
      await tx.attribution.create({
        data: {
          workspaceId: ev.workspaceId,
          siteEventId: ev.id,
          trackedLinkId: click.trackedLinkId,
          leadId: lead?.id ?? null,
          model: 'last_click',
        },
      });
      if (!lead || ev.kind === 'pageview') return;
      const next = stageAfterEvent(lead.stage, ev.kind);
      await tx.lead.update({
        where: { id: lead.id },
        data: {
          stage: next as never,
          signupEmail: lead.signupEmail ?? ev.email,
          revenueCents: { increment: ev.kind === 'payment' ? ev.amountCents : 0 },
          lastActivityAt: ev.occurredAt,
        },
      });
      if (next !== lead.stage)
        await tx.auditEvent.create({
          data: {
            workspaceId: ev.workspaceId,
            action: 'lead.stage_changed',
            targetType: 'Lead',
            targetId: lead.id,
            meta: { from: lead.stage, to: next, reason: `attributed ${ev.kind}` },
          },
        });
    });
    written++;
  }
  log.info({ scanned: events.length, written }, 'attribution.rollup done');
  return { written };
}
