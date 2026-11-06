/**
 * Parsing for NOAA SWPC's real-time solar wind feeds
 * (`/json/rtsw/rtsw_wind_1m.json` for plasma, `/json/rtsw/rtsw_mag_1m.json`
 * for the magnetic field). Both hold about a day of 1-minute rows, newest
 * first, from several spacecraft; only rows flagged `active: true` are the
 * ones SWPC currently treats as the operational source, so only those are used.
 *
 * `time_tag` is UTC without a zone suffix. Missing or non-finite values stay
 * null: a gap is never filled with zero.
 */

export interface WindPoint {
  time: number;
  /** Proton bulk speed, km/s. */
  speed: number | null;
  /** Proton density, cm^-3. */
  density: number | null;
}

export interface MagPoint {
  time: number;
  /** Total field strength, nT. */
  bt: number | null;
  /** North-south field component, GSM, nT. Negative (southward) couples to Earth. */
  bz: number | null;
}

function parseTime(value: unknown): number | null {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z?$/.test(value)) return null;
  const ms = Date.parse(value.endsWith('Z') ? value : `${value}Z`);
  return Number.isFinite(ms) ? ms : null;
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

function activeRows(body: unknown): Array<{ time: number; row: Record<string, unknown> }> {
  if (!Array.isArray(body)) return [];
  const seen = new Set<number>();
  const out: Array<{ time: number; row: Record<string, unknown> }> = [];
  for (const row of body as Array<Record<string, unknown> | null>) {
    if (row === null || typeof row !== 'object' || row.active !== true) continue;
    const time = parseTime(row.time_tag);
    // One point per minute: if two active rows share a minute, the first wins.
    if (time === null || seen.has(time)) continue;
    seen.add(time);
    out.push({ time, row });
  }
  return out.sort((a, b) => a.time - b.time);
}

export function parseWindFeed(body: unknown): WindPoint[] {
  return activeRows(body).map(({ time, row }) => ({
    time,
    speed: num(row.proton_speed),
    density: num(row.proton_density),
  }));
}

export function parseMagFeed(body: unknown): MagPoint[] {
  return activeRows(body).map(({ time, row }) => ({ time, bt: num(row.bt), bz: num(row.bz_gsm) }));
}
