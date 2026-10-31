import { describe, expect, it } from 'vitest';
import { parseMagFeed, parseWindFeed } from './swpc-wind-parse.js';

describe('parseWindFeed', () => {
  it('uses only active rows, oldest first, one per minute', () => {
    const out = parseWindFeed([
      { time_tag: '2026-10-31T22:53:00', active: true, proton_speed: 580, proton_density: 4 },
      { time_tag: '2026-10-31T22:53:00', active: true, proton_speed: 999, proton_density: 9 },
      { time_tag: '2026-10-31T22:52:00', active: false, proton_speed: 1, proton_density: 1 },
      { time_tag: '2026-10-31T22:51:00', active: true, proton_speed: 570, proton_density: 3.5 },
    ]);
    expect(out).toEqual([
      { time: Date.UTC(2026, 9, 31, 22, 51), speed: 570, density: 3.5 },
      { time: Date.UTC(2026, 9, 31, 22, 53), speed: 580, density: 4 },
    ]);
  });
  it('keeps missing values as null, not zero', () => {
    const [p] = parseWindFeed([{ time_tag: '2026-10-31T22:53:00', active: true, proton_speed: null }]);
    expect(p).toEqual({ time: Date.UTC(2026, 9, 31, 22, 53), speed: null, density: null });
  });
  it('rejects bad times and non-array bodies', () => {
    expect(parseWindFeed([{ time_tag: 'x', active: true, proton_speed: 1 }, null])).toEqual([]);
    expect(parseWindFeed('nope')).toEqual([]);
  });
});

describe('parseMagFeed', () => {
  it('reads bt and GSM bz from active rows', () => {
    const out = parseMagFeed([
      { time_tag: '2026-10-31T22:53:00', active: false, bt: 8.43, bz_gsm: -8.33 },
      { time_tag: '2026-10-31T22:53:00', active: true, bt: 7.81, bz_gsm: -5.1 },
    ]);
    expect(out).toEqual([{ time: Date.UTC(2026, 9, 31, 22, 53), bt: 7.81, bz: -5.1 }]);
  });
});
