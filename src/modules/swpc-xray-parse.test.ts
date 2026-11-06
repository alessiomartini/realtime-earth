import { describe, expect, it } from 'vitest';
import { flareClass, parseXrayFeed } from './swpc-xray-parse.js';

const row = (t: string, flux: unknown, energy = '0.1-0.8nm') => ({ time_tag: t, flux, energy, satellite: 18 });

describe('parseXrayFeed', () => {
  it('keeps only the long channel, oldest first', () => {
    const out = parseXrayFeed([
      row('2026-10-30T22:58:00Z', 2e-7),
      row('2026-10-30T22:57:00Z', 1e-9, '0.05-0.4nm'),
      row('2026-10-30T22:57:00Z', 3e-7),
    ]);
    expect(out).toEqual([
      { time: Date.UTC(2026, 9, 30, 22, 57), flux: 3e-7 },
      { time: Date.UTC(2026, 9, 30, 22, 58), flux: 2e-7 },
    ]);
  });
  it('turns a zero or invalid flux into a gap, not a quiet reading', () => {
    const out = parseXrayFeed([row('2026-10-31T00:00:00Z', 0), row('2026-10-31T00:01:00Z', null), row('2026-10-31T00:02:00Z', -1)]);
    expect(out.map((r) => r.flux)).toEqual([null, null, null]);
  });
  it('drops rows without a valid time and non-array bodies', () => {
    expect(parseXrayFeed([row('nope', 1e-6), null])).toEqual([]);
    expect(parseXrayFeed({})).toEqual([]);
  });
});

describe('flareClass', () => {
  it('maps flux to the letter scale', () => {
    expect(flareClass(2.7e-7)).toBe('B2.7');
    expect(flareClass(1e-6)).toBe('C1.0');
    expect(flareClass(5.5e-5)).toBe('M5.5');
    expect(flareClass(2.3e-4)).toBe('X2.3');
    expect(flareClass(4e-9)).toBe('<A1.0');
  });
});
