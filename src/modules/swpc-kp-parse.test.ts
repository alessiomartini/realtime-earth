import { describe, expect, it } from 'vitest';
import { kpBand, parseKpFeed, parseSwpcTime } from './swpc-kp-parse.js';

describe('parseSwpcTime', () => {
  it('reads SWPC’s zone-less stamp as UTC', () => {
    expect(parseSwpcTime('2026-10-31T18:00:00')).toBe(Date.UTC(2026, 9, 31, 18));
  });
  it('returns null for anything else rather than guessing', () => {
    expect(parseSwpcTime('yesterday')).toBeNull();
    expect(parseSwpcTime(undefined)).toBeNull();
    expect(parseSwpcTime(1761933600000)).toBeNull();
  });
});

describe('parseKpFeed', () => {
  it('returns readings oldest first', () => {
    const rows = [
      { time_tag: '2026-10-31T03:00:00', Kp: 3.33, a_running: 18, station_count: 8 },
      { time_tag: '2026-10-31T00:00:00', Kp: 2, a_running: 7, station_count: 8 },
    ];
    expect(parseKpFeed(rows)).toEqual([
      { time: Date.UTC(2026, 9, 31, 0), kp: 2 },
      { time: Date.UTC(2026, 9, 31, 3), kp: 3.33 },
    ]);
  });
  it('drops malformed rows instead of turning them into zeros', () => {
    const rows = [
      { time_tag: 'bad', Kp: 2 },
      { time_tag: '2026-10-31T00:00:00', Kp: null },
      { time_tag: '2026-10-31T03:00:00' },
      { time_tag: '2026-10-31T06:00:00', Kp: 12 },
      null,
      { time_tag: '2026-10-31T09:00:00', Kp: '4.33' },
    ];
    expect(parseKpFeed(rows)).toEqual([{ time: Date.UTC(2026, 9, 31, 9), kp: 4.33 }]);
  });
  it('treats a non-array body as empty', () => {
    expect(parseKpFeed({ error: 'x' })).toEqual([]);
    expect(parseKpFeed(null)).toEqual([]);
  });
});

describe('kpBand', () => {
  it('uses NOAA’s Kp 5 storm threshold', () => {
    expect(kpBand(3.67)).toBe('quiet');
    expect(kpBand(4)).toBe('active');
    expect(kpBand(4.67)).toBe('active');
    expect(kpBand(5)).toBe('storm');
    expect(kpBand(8.33)).toBe('storm');
  });
});
