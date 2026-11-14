import { describe, expect, it } from 'vitest';
import { parseCarbonTime, parseGenerationMix, parseIntensityFeed } from './carbon-intensity-parse.js';

describe('parseCarbonTime', () => {
  it('reads the API stamp as UTC', () => {
    expect(parseCarbonTime('2026-11-14T11:30Z')).toBe(Date.UTC(2026, 10, 14, 11, 30));
  });
  it('returns null for anything else', () => {
    expect(parseCarbonTime('2026-11-14T11:30:00')).toBeNull();
    expect(parseCarbonTime(undefined)).toBeNull();
    expect(parseCarbonTime(5)).toBeNull();
  });
});

describe('parseIntensityFeed', () => {
  it('returns points oldest first and keeps a missing actual as null', () => {
    const body = {
      data: [
        { from: '2026-11-14T11:00Z', to: '2026-11-14T11:30Z', intensity: { forecast: 93, actual: null, index: 'moderate' } },
        { from: '2026-11-14T10:30Z', to: '2026-11-14T11:00Z', intensity: { forecast: 90, actual: 88, index: 'low' } },
      ],
    };
    expect(parseIntensityFeed(body)).toEqual([
      { time: Date.UTC(2026, 10, 14, 10, 30), forecast: 90, actual: 88, index: 'low' },
      { time: Date.UTC(2026, 10, 14, 11, 0), forecast: 93, actual: null, index: 'moderate' },
    ]);
  });
  it('drops malformed rows instead of turning them into zeros', () => {
    const body = {
      data: [
        { from: 'bad', intensity: { forecast: 1, actual: 1 } },
        { from: '2026-11-14T11:00Z', intensity: { forecast: null, actual: null } },
        { from: '2026-11-14T11:30Z' },
        { from: '2026-11-14T12:00Z', intensity: { forecast: -4, actual: 'x' } },
        null,
      ],
    };
    expect(parseIntensityFeed(body)).toEqual([]);
  });
  it('treats an unexpected body as empty', () => {
    expect(parseIntensityFeed(null)).toEqual([]);
    expect(parseIntensityFeed({ data: 'x' })).toEqual([]);
  });
});

describe('parseGenerationMix', () => {
  it('sorts shares largest first', () => {
    const body = {
      data: {
        from: '2026-11-14T11:00Z',
        to: '2026-11-14T11:30Z',
        generationmix: [
          { fuel: 'gas', perc: 14.9 },
          { fuel: 'wind', perc: 32.9 },
          { fuel: 'coal', perc: 0 },
          { fuel: 'bad', perc: 'x' },
        ],
      },
    };
    expect(parseGenerationMix(body)).toEqual({
      time: Date.UTC(2026, 10, 14, 11, 0),
      mix: [
        { fuel: 'wind', perc: 32.9 },
        { fuel: 'gas', perc: 14.9 },
        { fuel: 'coal', perc: 0 },
      ],
    });
  });
  it('returns null when unusable', () => {
    expect(parseGenerationMix({ data: { from: 'x', generationmix: [] } })).toBeNull();
    expect(parseGenerationMix({ data: { from: '2026-11-14T11:00Z', generationmix: [] } })).toBeNull();
    expect(parseGenerationMix(null)).toBeNull();
  });
});
