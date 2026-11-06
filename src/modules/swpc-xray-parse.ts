/**
 * Parsing for NOAA SWPC's GOES X-ray flux feed
 * (`/json/goes/primary/xrays-1-day.json`): one row per minute per channel.
 * Only the long channel (0.1-0.8 nm) is used; it defines the flare class.
 *
 * `time_tag` is a full ISO UTC stamp and is the only time reported. A flux that
 * is zero, negative or not finite is the feed's way of saying "no valid
 * measurement" (a physical flux is never exactly 0), so it becomes `null`, a
 * gap, and is never plotted as a very quiet Sun.
 */

export interface XrayReading {
  /** Minute stamp, ms since epoch (UTC). */
  time: number;
  /** Long-channel flux in W/m², or null when the minute has no valid value. */
  flux: number | null;
}

export const LONG_CHANNEL = '0.1-0.8nm';

export function parseXrayFeed(body: unknown): XrayReading[] {
  if (!Array.isArray(body)) return [];
  const out: XrayReading[] = [];
  for (const row of body as Array<Record<string, unknown> | null>) {
    if (row === null || typeof row !== 'object' || row.energy !== LONG_CHANNEL) continue;
    if (typeof row.time_tag !== 'string') continue;
    const time = Date.parse(row.time_tag);
    if (!Number.isFinite(time)) continue;
    const flux = typeof row.flux === 'number' && Number.isFinite(row.flux) && row.flux > 0 ? row.flux : null;
    out.push({ time, flux });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Standard flare classification from peak-style flux: A, B, C, M, X plus a 1-decimal multiplier. */
export function flareClass(flux: number): string {
  const bands: Array<[string, number]> = [
    ['X', 1e-4],
    ['M', 1e-5],
    ['C', 1e-6],
    ['B', 1e-7],
    ['A', 1e-8],
  ];
  for (const [letter, base] of bands) {
    if (flux >= base) return `${letter}${(flux / base).toFixed(1)}`;
  }
  // Below A1.0 the letter scale has no name; say so rather than invent one.
  return `<A1.0`;
}
