/**
 * Parsing for NOAA SWPC's planetary K-index feed
 * (`/products/noaa-planetary-k-index.json`). Kept apart from the module so it
 * can be tested without a DOM.
 *
 * Each row is one 3-hour bin. `time_tag` is the bin's START in UTC, written
 * without a zone suffix; that is the only timestamp the source gives, so it is
 * what is reported as the source time. The newest bin may still be in progress.
 */

export interface KpReading {
  /** Start of the 3-hour bin, ms since epoch (UTC). */
  time: number;
  kp: number;
}

export type KpBand = 'quiet' | 'active' | 'storm';

/** Parse SWPC's zone-less UTC stamp (`2026-10-31T18:00:00`). Null if it is not one. */
export function parseSwpcTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.test(value)) return null;
  const ms = Date.parse(`${value}Z`);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Reduce the payload to readings, oldest first. Rows without a valid time or a
 * finite Kp in 0..9 are dropped, never filled in: a gap is more honest than a
 * zero, which would read as "perfectly quiet".
 */
export function parseKpFeed(body: unknown): KpReading[] {
  if (!Array.isArray(body)) return [];
  const out: KpReading[] = [];
  for (const row of body as Array<Record<string, unknown> | null>) {
    if (row === null || typeof row !== 'object') continue;
    const time = parseSwpcTime(row.time_tag);
    const kp = typeof row.Kp === 'number' ? row.Kp : typeof row.Kp === 'string' ? Number(row.Kp) : NaN;
    if (time === null || !Number.isFinite(kp) || kp < 0 || kp > 9) continue;
    out.push({ time, kp });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** NOAA treats Kp >= 5 as the threshold of a geomagnetic storm; 4 to <5 is active. */
export function kpBand(kp: number): KpBand {
  if (kp >= 5) return 'storm';
  if (kp >= 4) return 'active';
  return 'quiet';
}
