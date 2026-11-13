import { describe, expect, it } from 'vitest';
import {
  FingerprintSettings,
  type FingerprintSettingsInput,
  isTimeZone,
  localeForCountry,
  resolveZoneAndLocale,
} from './fingerprint';

const base: FingerprintSettingsInput = {
  screen: '1920x1080',
  tzMode: 'custom',
  tz: 'America/New_York',
  localeMode: 'custom',
  locale: 'en-US',
  cpu: null,
  memoryGb: null,
  webrtc: 'disable_udp',
  noise: true,
};

describe('FingerprintSettings', () => {
  it('accepts the form values and refuses what the container would reject', () => {
    expect(FingerprintSettings.parse({ ...base, cpu: 8, memoryGb: 4, webrtc: 'replace' })).toMatchObject({
      cpu: 8,
      memoryGb: 4,
    });
    for (const bad of [
      { screen: '1920×1080' },
      { screen: '99999x1' },
      { tz: 'Mars/Olympus' },
      { locale: 'english' },
      { cpu: 3 },
      { memoryGb: 16 },
      { webrtc: 'open' },
    ])
      expect(FingerprintSettings.safeParse({ ...base, ...bad }).success).toBe(false);
  });
});

describe('resolveZoneAndLocale', () => {
  const test = { timeZone: 'Europe/Lisbon', country: 'PT', ok: true };

  it('custom mode keeps the stored values whatever the proxy says', () => {
    expect(resolveZoneAndLocale({ tz: 'America/New_York', locale: 'en-US' }, test)).toEqual({
      tz: 'America/New_York',
      locale: 'en-US',
    });
  });

  it('proxy mode follows the last connection test', () => {
    const fp = { tz: 'America/New_York', tzMode: 'proxy', locale: 'en-US', localeMode: 'proxy' };
    expect(resolveZoneAndLocale(fp, test)).toEqual({ tz: 'Europe/Lisbon', locale: 'pt-PT' });
  });

  it('falls back to the stored values with no test, a failed test or an unknown place', () => {
    const fp = { tz: 'America/New_York', tzMode: 'proxy', locale: 'en-US', localeMode: 'proxy' };
    const stored = { tz: 'America/New_York', locale: 'en-US' };
    expect(resolveZoneAndLocale(fp, null)).toEqual(stored);
    expect(resolveZoneAndLocale(fp, { ...test, ok: false })).toEqual(stored);
    expect(resolveZoneAndLocale(fp, { timeZone: 'Not/AZone', country: 'ZZ' })).toEqual(stored);
  });
});

describe('helpers', () => {
  it('knows time zones and country languages', () => {
    expect(isTimeZone('Asia/Tokyo')).toBe(true);
    expect(isTimeZone('Tokyo time')).toBe(false);
    expect(localeForCountry('de')).toBe('de-DE');
    expect(localeForCountry(' us ')).toBe('en-US');
    expect(localeForCountry('ZZ')).toBeNull();
    expect(localeForCountry(undefined)).toBeNull();
  });
});

describe('location setting (phase 8)', () => {
  it('defaults to ask, and a custom location needs both coordinates', () => {
    expect(FingerprintSettings.parse(base)).toMatchObject({ geoMode: 'ask', geoLat: null, geoLon: null });
    expect(FingerprintSettings.safeParse({ ...base, geoMode: 'custom', geoLat: 42.36 }).success).toBe(false);
    expect(
      FingerprintSettings.safeParse({ ...base, geoMode: 'custom', geoLat: 42.36, geoLon: -71.06 }).success,
    ).toBe(true);
    expect(FingerprintSettings.safeParse({ ...base, geoMode: 'custom', geoLat: 95, geoLon: 0 }).success).toBe(
      false,
    );
    expect(FingerprintSettings.safeParse({ ...base, geoMode: 'everywhere' }).success).toBe(false);
  });
});
