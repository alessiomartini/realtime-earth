import { BaseModule } from '../core/base-module.js';
import { register } from './registry.js';
import { TimeChart } from '../ui/chart.js';
import { el } from '../ui/dom.js';
import { parseMagFeed, parseWindFeed, type MagPoint, type WindPoint } from './swpc-wind-parse.js';

/**
 * Solar wind at L1 — NOAA SWPC real-time solar wind (RTSW). Lane A: keyless,
 * CORS `*`, verified. (The older `/products/solar-wind/` directory no longer
 * exists; see the README's verified source status.)
 *
 * Opens with about a day of 1-minute values from the same files, then re-reads
 * them every minute. The spacecraft is roughly 1.5 million km sunward of Earth,
 * so what is shown reaches Earth tens of minutes later.
 */

const WIND_FEED = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_wind_1m.json';
const MAG_FEED = 'https://services.swpc.noaa.gov/json/rtsw/rtsw_mag_1m.json';
const POLL_MS = 60_000;

class SwpcWind extends BaseModule {
  #wind: WindPoint[] = [];
  #mag: MagPoint[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #abort: AbortController | null = null;
  #chart: TimeChart | null = null;
  #stats: HTMLElement | null = null;
  #backfilled = false;

  constructor() {
    super({
      id: 'swpc-solar-wind',
      section: 'earth',
      title: 'Solar wind',
      oneLiner: 'Speed and magnetic field of the solar wind, measured upstream of Earth.',
      why: 'A spacecraft at the L1 point watches the solar wind about 30 to 60 minutes before it reaches Earth. Fast wind and a southward (negative Bz) magnetic field are the combination that drives geomagnetic storms.',
      transport: 'poll',
      lane: 'A',
      latencyClass: 'near-real-time',
      cadence: 'every 60s',
      staleAfterMs: null,
      historyNote: 'Opens with about a day of 1-minute values from the same SWPC files.',
      source: {
        name: 'NOAA Space Weather Prediction Center (RTSW)',
        url: 'https://www.swpc.noaa.gov/products/real-time-solar-wind',
        license: 'Public domain (U.S. Government work)',
        attribution: 'NOAA / NWS Space Weather Prediction Center',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    const box = el('div', { class: 'chartbox' });
    this.#stats = el('p', { class: 'module__summary' }, 'loading…');
    el_.append(box, this.#stats);
    this.#chart = new TimeChart(box, [{ label: 'speed (km/s)', stroke: '#54d6a0', precision: 0 }]);
  }

  protected openStream(): void {
    this.#abort = new AbortController();
    void this.#load();
    this.#timer = setInterval(() => void this.#load(), POLL_MS);
  }

  protected closeStream(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  unmount(): void {
    this.#chart?.destroy();
    this.#chart = null;
    this.#stats = null;
  }

  async #fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, { signal: this.#abort?.signal ?? null });
    if (!response.ok) throw new Error(`SWPC returned HTTP ${response.status}`);
    return response.json();
  }

  async #load(): Promise<void> {
    try {
      const [wind, mag] = await Promise.all([this.#fetchJson(WIND_FEED), this.#fetchJson(MAG_FEED)]);
      this.#wind = parseWindFeed(wind);
      this.#mag = parseMagFeed(mag);
      const lastWind = [...this.#wind].reverse().find((p) => p.speed !== null);
      const lastMag = [...this.#mag].reverse().find((p) => p.bz !== null);
      if (lastWind === undefined && lastMag === undefined) {
        this.fail('SWPC returned no usable solar wind rows');
        return;
      }
      if (!this.#backfilled) {
        this.markBackfilled(this.#wind.length + this.#mag.length);
        this.#backfilled = true;
        this.markOpen();
      }
      this.markReceived(Math.max(lastWind?.time ?? 0, lastMag?.time ?? 0));
      this.#draw(lastWind, lastMag);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.fail(error instanceof Error ? error.message : 'request failed');
    }
  }

  #draw(lastWind: WindPoint | undefined, lastMag: MagPoint | undefined): void {
    // Only speed is plotted: Bz (a few nT) on the same axis as speed (hundreds
    // of km/s) would be a flat line. Bz is given in the readout instead, and a
    // minute with no speed is a gap, not an interpolated value.
    this.#chart?.setData([
      Float64Array.from(this.#wind, (p) => p.time / 1000),
      this.#wind.map((p) => p.speed),
    ]);
    if (this.#stats !== null) {
      const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);
      const parts: string[] = [];
      if (lastWind?.speed != null) {
        parts.push(`speed ${lastWind.speed.toFixed(0)} km/s` + (lastWind.density != null ? `, density ${lastWind.density.toFixed(1)} cm⁻³` : '') + ` (${hhmm(lastWind.time)} UTC)`);
      }
      if (lastMag?.bz != null) {
        parts.push(`Bz ${lastMag.bz.toFixed(1)} nT` + (lastMag.bt != null ? `, Bt ${lastMag.bt.toFixed(1)} nT` : '') + ` (${hhmm(lastMag.time)} UTC)`);
      }
      this.#stats.textContent = `Latest valid: ${parts.join('; ')}.`;
    }
  }
}

register(new SwpcWind());
