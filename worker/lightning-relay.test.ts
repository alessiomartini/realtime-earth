import { describe, expect, it } from 'vitest';
import { lzwDecode, parseStrike, strikeTimeMs } from './lightning-relay.js';

/**
 * The lightning relay's parsing, tested where it is most dangerous.
 *
 * The units bug is the one to be afraid of. Blitzortung reports nanoseconds; a
 * reading that treats them as milliseconds puts every strike in 1970 and still
 * looks like working software — dots appear on the map, the counter climbs, the
 * rate is plausible. Only the age readout is absurd, and by then the map has
 * been believed. So the conversion is range-checked and the range check is
 * tested from both sides.
 */

const NOW = Date.UTC(2026, 8, 2, 12, 0, 0);
const NS_PER_MS = 1e6;

describe('strikeTimeMs', () => {
  it('converts nanoseconds to milliseconds', () => {
    expect(strikeTimeMs(NOW * NS_PER_MS, NOW)).toBe(NOW);
  });

  it('rejects a value that is really milliseconds, instead of dating it to 1970', () => {
    // This is the actual bug: passing ms where ns is expected divides by a
    // million and lands in January 1970. It must come back unknown.
    expect(strikeTimeMs(NOW, NOW)).toBeNull();
  });

  it('rejects seconds and microseconds for the same reason', () => {
    expect(strikeTimeMs(NOW / 1000, NOW)).toBeNull();
    expect(strikeTimeMs(NOW * 1000, NOW)).toBeNull();
  });

  it('accepts a strike from a few minutes ago', () => {
    const fiveMinutesAgo = NOW - 5 * 60_000;
    expect(strikeTimeMs(fiveMinutesAgo * NS_PER_MS, NOW)).toBe(fiveMinutesAgo);
  });

  it('rejects a time more than a day away in either direction', () => {
    expect(strikeTimeMs((NOW - 2 * 86_400_000) * NS_PER_MS, NOW)).toBeNull();
    expect(strikeTimeMs((NOW + 2 * 86_400_000) * NS_PER_MS, NOW)).toBeNull();
  });

  it('returns null for anything that is not a finite number', () => {
    for (const bad of [null, undefined, 'now', {}, Number.NaN, Infinity]) {
      expect(strikeTimeMs(bad, NOW)).toBeNull();
    }
  });
});

describe('parseStrike', () => {
  const good = JSON.stringify({
    time: NOW * NS_PER_MS,
    lat: 45.5,
    lon: 9.2,
    alt: 0,
    pol: -1,
    sig: [{ sta: 1 }, { sta: 2 }, { sta: 3 }],
  });

  it('reads a strike, counting the stations that contributed to the fix', () => {
    const strike = parseStrike(good, NOW);
    expect(strike).toMatchObject({ type: 'strike', lat: 45.5, lon: 9.2, timeMs: NOW, stations: 3, polarity: -1 });
  });

  it('keeps a strike whose timestamp could not be read, with the time as unknown', () => {
    // The position is real and was detected. Only the time is unreadable, and
    // dropping the strike entirely would lose a genuine observation.
    const strike = parseStrike(JSON.stringify({ time: 'nonsense', lat: 1, lon: 2 }), NOW);
    expect(strike).not.toBeNull();
    expect(strike?.timeMs).toBeNull();
  });

  it('drops a message with no usable position rather than placing it at 0,0', () => {
    // Null Island is where every unguarded coordinate bug ends up, and it looks
    // exactly like a real strike in the Gulf of Guinea.
    expect(parseStrike(JSON.stringify({ time: NOW * NS_PER_MS }), NOW)).toBeNull();
    expect(parseStrike(JSON.stringify({ lat: 'x', lon: 2 }), NOW)).toBeNull();
  });

  it('drops coordinates outside the possible range', () => {
    expect(parseStrike(JSON.stringify({ lat: 120, lon: 9 }), NOW)).toBeNull();
    expect(parseStrike(JSON.stringify({ lat: 45, lon: 400 }), NOW)).toBeNull();
  });

  it('returns null for text that is not JSON at all', () => {
    expect(parseStrike('not json', NOW)).toBeNull();
    expect(parseStrike('', NOW)).toBeNull();
  });

  it('reports stations as unknown when the payload carries no station list', () => {
    const strike = parseStrike(JSON.stringify({ time: NOW * NS_PER_MS, lat: 1, lon: 2 }), NOW);
    expect(strike?.stations).toBeNull();
  });
});

describe('a real frame, captured from production', () => {
  /**
   * The decoded top-level fields of an actual Blitzortung message, taken
   * verbatim from the diagnostic on 2026-09-02. This is the fixture that makes
   * the parser answerable to reality rather than to what the protocol was
   * assumed to be — including the one number that matters most, the nanosecond
   * timestamp, whose magnitude is the whole reason for the range check.
   */
  const REAL_FRAME = JSON.stringify({
    time: 1788366104013598000,
    lat: 37.455328,
    lon: 138.336557,
    alt: 0,
    pol: 0,
    mds: 5817,
    mcg: 116,
    status: 0,
    region: 7,
    sig: [
      { sta: 2531, time: 287922, lat: 37.450733, lon: 137.358917, alt: 30, status: 12 },
      { sta: 1635, time: 362302, lat: 36.812336, lon: 137.393845, alt: 11, status: 2 },
      { sta: 1874, time: 365994, lat: 36.812332, lon: 137.393845, alt: 14, status: 12 },
    ],
  });
  /** The instant that frame was produced: 2026-09-02T16:21:44.013Z. */
  const FRAME_TIME = 1788366104013.598;

  it('parses the real payload and dates it to the second it was sent', () => {
    const strike = parseStrike(REAL_FRAME, FRAME_TIME);
    expect(strike).not.toBeNull();
    expect(strike?.lat).toBe(37.455328);
    expect(strike?.lon).toBe(138.336557);
    expect(strike?.stations).toBe(3);
    expect(new Date(strike!.timeMs!).toISOString()).toBe('2026-09-02T16:21:44.013Z');
  });

  it('would have reported an unreadable time had the units been read as ms', () => {
    // The counterfactual, kept as a test because it is the failure that looks
    // most like success: treating this number as milliseconds yields a date
    // roughly fifty-six million years from now.
    expect(strikeTimeMs(1788366104013598000, 1788366104013598000)).toBeNull();
  });
});

describe('lzwDecode', () => {
  // The decoder is only trusted because its output is checked against real
  // frames in production. These cover the shape of the algorithm itself.
  it('returns plain text unchanged when no back-references are used', () => {
    expect(lzwDecode('hello')).toBe('hello');
  });

  it('returns an empty string for empty input rather than throwing', () => {
    expect(lzwDecode('')).toBe('');
  });

  it('expands a back-reference into the phrase it stands for', () => {
    // Encoder side: "aa" builds dictionary entry 256 = "aa"; a following
    // char code 256 must expand back to "aa".
    const encoded = 'aa' + String.fromCharCode(256);
    expect(lzwDecode(encoded)).toBe('aaaa');
  });
});
