// Plan 0004 phase 2: the settings a person can change on a browser's fingerprint. Everything else (canvas, WebGL,
// audio, fonts, client rects, GPU model) comes from the CloakBrowser seed and is not editable on purpose: the
// seed draws those values together as one coherent device.
import { z } from 'zod';
import { GeoMode, WebRtcMode } from './enums';

export const SCREEN_PRESETS = [
  '1920x1080',
  '2560x1440',
  '1536x864',
  '1600x900',
  '1440x900',
  '1366x768',
  '1280x720',
] as const;
/** `navigator.hardwareConcurrency` choices; null = whatever the seed gives. */
export const CPU_OPTIONS = [2, 4, 6, 8, 12, 16] as const;
/** `navigator.deviceMemory` choices in GB (Chrome never reports more than 8); null = from the seed. */
export const MEMORY_OPTIONS = [2, 4, 8] as const;
/** GPU families the engine can present. */
export const GPU_OPTIONS = ['intel', 'nvidia'] as const;

export function isTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}
const BCP47 = /^[A-Za-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;

/** What the fingerprint form submits. `proxy` modes follow the proxy's last connection test at every start. */
export const FingerprintSettings = z
  .object({
    screen: z.string().regex(/^\d{3,4}x\d{3,4}$/, 'Screen must look like 1920x1080'),
    tzMode: z.enum(['proxy', 'custom']),
    tz: z.string().min(1).max(64).refine(isTimeZone, 'Unknown time zone'),
    localeMode: z.enum(['proxy', 'custom']),
    locale: z.string().regex(BCP47, 'Language must look like en-US'),
    cpu: z
      .number()
      .int()
      .refine((n) => (CPU_OPTIONS as readonly number[]).includes(n))
      .nullable(),
    memoryGb: z
      .number()
      .int()
      .refine((n) => (MEMORY_OPTIONS as readonly number[]).includes(n))
      .nullable(),
    webrtc: z.enum(WebRtcMode),
    noise: z.boolean(),
    /**
     * Location a site gets when it asks (phase 8). `ask`: the browser's default. `block`: always refused. `proxy`:
     * where the proxy's last connection test put its exit IP. `custom`: `geoLat` / `geoLon`.
     */
    geoMode: z.enum(GeoMode).default('ask'),
    geoLat: z.number().min(-90).max(90).nullable().default(null),
    geoLon: z.number().min(-180).max(180).nullable().default(null),
  })
  .refine((s) => s.geoMode !== 'custom' || (s.geoLat !== null && s.geoLon !== null), {
    message: 'A custom location needs a latitude and a longitude.',
  });
/** What the form submits; the location fields may be left out (`ask`). */
export type FingerprintSettingsInput = z.input<typeof FingerprintSettings>;
export type FingerprintSettings = z.infer<typeof FingerprintSettings>;

/** Main language of a country (ISO 3166-1 alpha-2), for "match proxy IP". Unknown countries keep the custom value. */
const COUNTRY_LOCALE: Record<string, string> = {
  US: 'en-US',
  GB: 'en-GB',
  CA: 'en-CA',
  AU: 'en-AU',
  NZ: 'en-NZ',
  IE: 'en-IE',
  IN: 'en-IN',
  SG: 'en-SG',
  ZA: 'en-ZA',
  DE: 'de-DE',
  AT: 'de-AT',
  CH: 'de-CH',
  FR: 'fr-FR',
  BE: 'nl-BE',
  NL: 'nl-NL',
  ES: 'es-ES',
  MX: 'es-MX',
  AR: 'es-AR',
  CO: 'es-CO',
  CL: 'es-CL',
  PT: 'pt-PT',
  BR: 'pt-BR',
  IT: 'it-IT',
  PL: 'pl-PL',
  SE: 'sv-SE',
  NO: 'nb-NO',
  DK: 'da-DK',
  FI: 'fi-FI',
  CZ: 'cs-CZ',
  RO: 'ro-RO',
  HU: 'hu-HU',
  GR: 'el-GR',
  TR: 'tr-TR',
  UA: 'uk-UA',
  RU: 'ru-RU',
  IL: 'he-IL',
  AE: 'ar-AE',
  SA: 'ar-SA',
  JP: 'ja-JP',
  KR: 'ko-KR',
  CN: 'zh-CN',
  TW: 'zh-TW',
  HK: 'zh-HK',
  TH: 'th-TH',
  VN: 'vi-VN',
  ID: 'id-ID',
  MY: 'ms-MY',
  PH: 'en-PH',
};
export function localeForCountry(country: string | null | undefined): string | null {
  return country ? (COUNTRY_LOCALE[country.trim().toUpperCase()] ?? null) : null;
}

/**
 * The time zone and language a browser starts with. In `proxy` mode they follow where the proxy's last connection
 * test said its exit IP is; with no test yet (or an unknown country) the stored value is used.
 */
export function resolveZoneAndLocale(
  fp: { tz?: string; tzMode?: string; locale?: string; localeMode?: string },
  test: { timeZone?: string; country?: string; ok?: boolean } | null | undefined,
): { tz: string | undefined; locale: string | undefined } {
  const usable = test && test.ok !== false ? test : null;
  const tz =
    fp.tzMode === 'proxy' && usable?.timeZone && isTimeZone(usable.timeZone) ? usable.timeZone : fp.tz;
  const locale = (fp.localeMode === 'proxy' && localeForCountry(usable?.country)) || fp.locale;
  return { tz, locale };
}
