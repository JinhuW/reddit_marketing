import { z } from 'zod';

/** The creator's device as the browser form captures it ({@link useDeviceFingerprint}); drives the CloakBrowser persona. */
export const DeviceFingerprint = z.object({
  userAgent: z.string().max(500),
  screen: z.string().max(40),
  tz: z.string().max(80),
  locale: z.string().max(80),
  os: z.string().max(80).optional(),
});

/** Hidden-field JSON → fingerprint with `capturedAt`, or `{}` when missing or malformed (never throws). */
export function parseDeviceFingerprint(raw: string, now = new Date()) {
  let v: unknown = {};
  try {
    v = JSON.parse(raw || '{}');
  } catch {}
  const fp = DeviceFingerprint.safeParse(v);
  return fp.success ? { ...fp.data, capturedAt: now.toISOString() } : {};
}
