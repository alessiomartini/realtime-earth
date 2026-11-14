/**
 * Parsing for the UK National Grid ESO Carbon Intensity API
 * (`/intensity/date` and `/generation`). Kept apart from the module so it can
 * be tested without a DOM.
 *
 * Periods are half-hours; `from` is written like `2026-11-14T11:00Z`. The
 * `actual` value is null while the period is still being estimated: it is kept
 * as null (a gap), never replaced by the forecast.
 */

export interface IntensityPoint {
  /** Start of the half-hour, ms since epoch (UTC). */
  time: number;
  forecast: number | null;
  actual: number | null;
  index: string | null;
}

export interface FuelShare {
  fuel: string;
  perc: number;
}

export interface GenerationMix {
  time: number;
  mix: FuelShare[];
}

/** Parse the API's `YYYY-MM-DDTHH:mmZ` stamp. Null if it is not one. */
export function parseCarbonTime(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}Z$/.test(value)) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function finiteOrNull(v: unknown): number | null {
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

/** Reduce the intensity payload to points, oldest first; rows with no valid time are dropped. */
export function parseIntensityFeed(body: unknown): IntensityPoint[] {
  const data = (body as { data?: unknown } | null)?.data;
  if (!Array.isArray(data)) return [];
  const out: IntensityPoint[] = [];
  for (const row of data as Array<Record<string, unknown> | null>) {
    if (row === null || typeof row !== 'object') continue;
    const time = parseCarbonTime(row.from);
    const intensity = row.intensity as Record<string, unknown> | null | undefined;
    if (time === null || intensity === null || typeof intensity !== 'object' || intensity === undefined) continue;
    const forecast = finiteOrNull(intensity.forecast);
    const actual = finiteOrNull(intensity.actual);
    if (forecast === null && actual === null) continue;
    out.push({ time, forecast, actual, index: typeof intensity.index === 'string' ? intensity.index : null });
  }
  return out.sort((a, b) => a.time - b.time);
}

/** Parse the generation-mix payload; shares are sorted largest first. Null if unusable. */
export function parseGenerationMix(body: unknown): GenerationMix | null {
  const data = (body as { data?: Record<string, unknown> } | null)?.data;
  if (data === null || data === undefined || typeof data !== 'object') return null;
  const time = parseCarbonTime(data.from);
  if (time === null || !Array.isArray(data.generationmix)) return null;
  const mix: FuelShare[] = [];
  for (const row of data.generationmix as Array<Record<string, unknown> | null>) {
    if (row === null || typeof row !== 'object') continue;
    const perc = finiteOrNull(row.perc);
    if (typeof row.fuel !== 'string' || perc === null) continue;
    mix.push({ fuel: row.fuel, perc });
  }
  if (mix.length === 0) return null;
  return { time, mix: mix.sort((a, b) => b.perc - a.perc) };
}
