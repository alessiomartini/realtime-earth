import { BaseModule } from '../core/base-module.js';
import { register } from './registry.js';
import { TimeChart } from '../ui/chart.js';
import { el } from '../ui/dom.js';
import { flareClass, parseXrayFeed, type XrayReading } from './swpc-xray-parse.js';

/**
 * Solar X-rays — NOAA SWPC, GOES primary satellite, 0.1-0.8 nm. Lane A:
 * keyless, CORS `*`, verified.
 *
 * Opens with the past 24 hours of 1-minute values from the same file, then
 * re-reads it every minute. Plotted as log10 of the flux because flares span
 * several orders of magnitude; minutes with no valid measurement stay gaps.
 */

const FEED = 'https://services.swpc.noaa.gov/json/goes/primary/xrays-1-day.json';
const POLL_MS = 60_000;

class SwpcXray extends BaseModule {
  #readings: XrayReading[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #abort: AbortController | null = null;
  #chart: TimeChart | null = null;
  #stats: HTMLElement | null = null;
  #backfilled = false;

  constructor() {
    super({
      id: 'swpc-xray',
      section: 'earth',
      title: 'Solar X-ray flux',
      oneLiner: 'How brightly the Sun is shining in X-rays right now.',
      why: 'Solar flares show up first as a jump in X-ray flux measured by the GOES satellites. The letter class (A, B, C, M, X) is a tenfold step each, so the chart is logarithmic: an M-class flare is a hundred times an ordinary B-class day.',
      transport: 'poll',
      lane: 'A',
      latencyClass: 'near-real-time',
      cadence: 'every 60s',
      staleAfterMs: null,
      historyNote: 'Opens with the past 24 hours of 1-minute values from the same SWPC file.',
      source: {
        name: 'NOAA Space Weather Prediction Center (GOES)',
        url: 'https://www.swpc.noaa.gov/products/goes-x-ray-flux',
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
    this.#chart = new TimeChart(box, [{ label: 'log10 flux (W/m²)', stroke: '#e0b341', precision: 2 }]);
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

  async #load(): Promise<void> {
    try {
      const response = await fetch(FEED, { signal: this.#abort?.signal ?? null });
      if (!response.ok) {
        this.fail(`SWPC returned HTTP ${response.status}`);
        return;
      }
      const readings = parseXrayFeed(await response.json());
      const valid = readings.filter((r) => r.flux !== null);
      if (valid.length === 0) {
        this.fail('SWPC returned no valid X-ray measurements');
        return;
      }
      this.#readings = readings;
      if (!this.#backfilled) {
        this.markBackfilled(valid.length);
        this.#backfilled = true;
        this.markOpen();
      }
      // The newest VALID minute is the freshest datum we really have.
      this.markReceived(valid[valid.length - 1]!.time);
      this.#draw(valid[valid.length - 1]!);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.fail(error instanceof Error ? error.message : 'request failed');
    }
  }

  #draw(latest: XrayReading): void {
    const times = new Float64Array(this.#readings.length);
    const values: Array<number | null> = [];
    this.#readings.forEach((r, i) => {
      times[i] = r.time / 1000;
      values.push(r.flux === null ? null : Math.log10(r.flux));
    });
    this.#chart?.setData([times, values]);
    if (this.#stats !== null && latest.flux !== null) {
      const peak = Math.max(...this.#readings.map((r) => r.flux ?? 0));
      this.#stats.textContent =
        `Latest valid minute ${new Date(latest.time).toISOString().slice(11, 16)} UTC: ` +
        `${flareClass(latest.flux)} (${latest.flux.toExponential(2)} W/m²). ` +
        `Peak in the window: ${flareClass(peak)}.`;
    }
  }
}

register(new SwpcXray());
