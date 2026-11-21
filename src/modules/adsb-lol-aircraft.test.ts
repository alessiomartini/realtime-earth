import { describe, expect, it } from 'vitest';
import { altitudeColour } from './adsb-lol-aircraft.js';

describe('altitudeColour', () => {
  it('separates ground, unknown and the three altitude bands', () => {
    const colours = new Set([
      altitudeColour({ altFt: null, onGround: true }),
      altitudeColour({ altFt: null, onGround: false }),
      altitudeColour({ altFt: 3000, onGround: false }),
      altitudeColour({ altFt: 18000, onGround: false }),
      altitudeColour({ altFt: 36000, onGround: false }),
    ]);
    expect(colours.size).toBe(5);
  });

  it('treats the band edges consistently', () => {
    expect(altitudeColour({ altFt: 10_000, onGround: false })).toBe(altitudeColour({ altFt: 24_999, onGround: false }));
    expect(altitudeColour({ altFt: 25_000, onGround: false })).toBe(altitudeColour({ altFt: 40_000, onGround: false }));
  });
});
