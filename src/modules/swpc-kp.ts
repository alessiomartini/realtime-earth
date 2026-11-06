import { BaseModule } from '../core/base-module.js';
import { register } from './registry.js';
import { el, formatAge } from '../ui/dom.js';
import { kpBand, parseKpFeed, type KpReading } from './swpc-kp-parse.js';

/**
 * Geomagnetic activity — NOAA SWPC planetary K-index. Lane A: keyless,
 * CORS `*`, verified.
 *
 * The feed already holds about a week of 3-hour bins, so the card opens
 * populated with real published history. The reported source time is the start
 * of the newest bin, which may still be in progress — labelled as such.
 */

const FEED = 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json';
const POLL_MS = 300_000;
const SHOWN = 24;

class SwpcKp extends BaseModule {
  #readings: KpReading[] = [];
  #timer: ReturnType<typeof setInterval> | null = null;
  #abort: AbortController | null = null;
  #headline: HTMLElement | null = null;
  #bars: HTMLElement | null = null;
  #backfilled = false;

  constructor() {
    super({
      id: 'swpc-kp',
      section: 'earth',
      title: 'Geomagnetic activity',
      oneLiner: 'The planetary K-index: how disturbed Earth’s magnetic field is.',
      why: 'Solar wind buffets the magnetosphere, and the Kp index (0 to 9, in 3-hour bins) summarises the resulting disturbance from a network of magnetometers. Kp 5 and above is a geomagnetic storm: aurora at lower latitudes, and a nuisance for satellites and power grids.',
      transport: 'poll',
      lane: 'A',
      latencyClass: 'near-real-time',
      cadence: 'every 5 min',
      staleAfterMs: null,
      historyNote: 'Opens with the roughly week of 3-hour bins that SWPC publishes in the same file.',
      source: {
        name: 'NOAA Space Weather Prediction Center',
        url: 'https://www.swpc.noaa.gov/products/planetary-k-index',
        license: 'Public domain (U.S. Government work)',
        attribution: 'NOAA / NWS Space Weather Prediction Center',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    this.#headline = el('p', { class: 'module__summary' }, 'loading…');
    this.#bars = el('ol', { class: 'eventlist' });
    el_.append(this.#headline, this.#bars);
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
    this.#headline = null;
    this.#bars = null;
  }

  async #load(): Promise<void> {
    try {
      const response = await fetch(FEED, { signal: this.#abort?.signal ?? null });
      if (!response.ok) {
        this.fail(`SWPC returned HTTP ${response.status}`);
        return;
      }
      const readings = parseKpFeed(await response.json());
      if (readings.length === 0) {
        this.fail('SWPC returned no usable K-index rows');
        return;
      }
      this.#readings = readings;
      const newest = readings[readings.length - 1]!;
      if (!this.#backfilled) {
        this.markBackfilled(readings.length);
        this.#backfilled = true;
        this.markOpen();
      }
      this.markReceived(newest.time);
      this.#draw();
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.fail(error instanceof Error ? error.message : 'request failed');
    }
  }

  #draw(): void {
    const latest = this.#readings[this.#readings.length - 1];
    if (latest === undefined || this.#headline === null || this.#bars === null) return;
    const now = Date.now();
    this.#headline.textContent =
      `Kp ${latest.kp.toFixed(2)} (${kpBand(latest.kp)}) for the 3-hour bin starting ` +
      `${new Date(latest.time).toISOString().slice(0, 16).replace('T', ' ')} UTC` +
      (now - latest.time < 3 * 3_600_000 ? ' — bin still in progress, value may change' : '');
    this.#bars.replaceChildren(
      ...this.#readings
        .slice(-SHOWN)
        .reverse()
        .map((r) =>
          el(
            'li',
            { class: kpBand(r.kp) === 'storm' ? 'eventlist__item eventlist__item--live' : 'eventlist__item' },
            el('span', { class: 'eventlist__mag' }, r.kp.toFixed(1)),
            el('span', { class: 'eventlist__place' }, kpBand(r.kp)),
            el('span', { class: 'eventlist__time', title: new Date(r.time).toISOString() }, `${formatAge(now - r.time)} ago`),
          ),
        ),
    );
  }
}

register(new SwpcKp());
