import { describe, expect, it } from 'vitest';
import { parseGeo, parseIp } from './test-proxy';

describe('parseGeo', () => {
  it('reads the ipinfo shape', () => {
    const body = JSON.stringify({
      ip: '203.0.113.9',
      city: 'Boston',
      country: 'US',
      loc: '42.3584,-71.0598',
      timezone: 'America/New_York',
    });
    expect(parseGeo(body)).toEqual({
      city: 'Boston',
      country: 'US',
      timeZone: 'America/New_York',
      lat: 42.3584,
      lon: -71.0598,
    });
  });

  it('reads latitude / longitude / timezone.id and prefers the country code', () => {
    const body = JSON.stringify({
      city: 'Lisbon',
      country: 'Portugal',
      country_code: 'PT',
      latitude: 38.72,
      longitude: -9.14,
      timezone: { id: 'Europe/Lisbon' },
    });
    expect(parseGeo(body)).toEqual({
      city: 'Lisbon',
      country: 'PT',
      timeZone: 'Europe/Lisbon',
      lat: 38.72,
      lon: -9.14,
    });
  });

  it('drops out-of-range coordinates and unreadable bodies', () => {
    expect(parseGeo(JSON.stringify({ city: 'X', loc: '912,10' }))).toEqual({ city: 'X' });
    expect(parseGeo('<html>blocked</html>')).toBeNull();
    expect(parseGeo('{}')).toBeNull();
  });
});

describe('parseIp', () => {
  it('reads JSON and plain text echoes', () => {
    expect(parseIp('{"ip":"203.0.113.9"}')).toBe('203.0.113.9');
    expect(parseIp('203.0.113.9\n')).toBe('203.0.113.9');
    expect(parseIp('nope')).toBeNull();
  });
});
