import { BaseModule } from '../core/base-module.js';
import { register } from './registry.js';
import { TimeChart } from '../ui/chart.js';
import { el } from '../ui/dom.js';
import {
  parseGenerationMix,
  parseIntensityFeed,
  type GenerationMix,
  type IntensityPoint,
} from './carbon-intensity-parse.js';

/**
 * Great Britain grid carbon intensity and generation mix — National Grid ESO
 * Carbon Intensity API. Lane A: keyless, CORS `*`, verified. CC BY 4.0 with
 * the provider's API terms (README licence audit): attribution is shown on the
 * card, and the data is not resold or presented as the operator's own service.
 *
 * Opens with today's half-hours (UTC day) from `/intensity/date`, then re-reads
 * every 5 minutes; new half-hour periods appear every 30 minutes.
 */

const INTENSITY_FEED = 'https://api.carbonintensity.org.uk/intensity/date';
const MIX_FEED = 'https://api.carbonintensity.org.uk/generation';
const POLL_MS = 300_000;

class CarbonIntensity extends BaseModule {
  #points: IntensityPoint[] = [];
  #mix: GenerationMix | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #abort: AbortController | null = null;
  #chart: TimeChart | null = null;
  #stats: HTMLElement | null = null;
  #mixList: HTMLElement | null = null;
  #backfilled = false;

  constructor() {
    super({
      id: 'carbon-intensity-gb',
      section: 'infrastructure',
      title: 'Great Britain grid carbon intensity',
      oneLiner: 'Grams of CO₂ emitted per kWh of electricity on the GB grid, and what generates it.',
      why: 'How clean a unit of electricity is depends on the hour: windy or sunny periods push the figure down, gas and imports push it up. The grid operator publishes a forecast and, once the half-hour has been estimated, an actual value.',
      transport: 'poll',
      lane: 'A',
      latencyClass: 'near-real-time',
      cadence: 'every 5 min',
      staleAfterMs: null,
      historyNote: 'Opens with the half-hours of the current UTC day from the same API.',
      source: {
        name: 'National Grid ESO Carbon Intensity API',
        url: 'https://carbonintensity.org.uk/',
        license: 'CC BY 4.0, plus the API terms of use',
        attribution: 'Carbon Intensity API, National Grid ESO and partners (carbonintensity.org.uk)',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    const box = el('div', { class: 'chartbox' });
    this.#stats = el('p', { class: 'module__summary' }, 'loading…');
    this.#mixList = el('ol', { class: 'eventlist' });
    el_.append(box, this.#stats, this.#mixList);
    this.#chart = new TimeChart(box, [
      { label: 'actual (gCO₂/kWh)', stroke: '#54d6a0', precision: 0 },
      { label: 'forecast (gCO₂/kWh)', stroke: '#8aa4c8', precision: 0 },
    ]);
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
    this.#mixList = null;
  }

  async #fetchJson(url: string): Promise<unknown> {
    const response = await fetch(url, { signal: this.#abort?.signal ?? null });
    if (!response.ok) throw new Error(`Carbon Intensity API returned HTTP ${response.status}`);
    return response.json();
  }

  async #load(): Promise<void> {
    try {
      const [intensity, mix] = await Promise.all([this.#fetchJson(INTENSITY_FEED), this.#fetchJson(MIX_FEED)]);
      this.#points = parseIntensityFeed(intensity);
      this.#mix = parseGenerationMix(mix);
      if (this.#points.length === 0) {
        this.fail('Carbon Intensity API returned no usable rows');
        return;
      }
      const newest = this.#points[this.#points.length - 1]!;
      if (!this.#backfilled) {
        this.markBackfilled(this.#points.length);
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
    // A missing actual is a gap, never the forecast in disguise.
    this.#chart?.setData([
      Float64Array.from(this.#points, (p) => p.time / 1000),
      this.#points.map((p) => p.actual),
      this.#points.map((p) => p.forecast),
    ]);
    const hhmm = (t: number): string => new Date(t).toISOString().slice(11, 16);
    const latest = [...this.#points].reverse().find((p) => p.actual !== null) ?? this.#points[this.#points.length - 1]!;
    if (this.#stats !== null) {
      this.#stats.textContent =
        latest.actual !== null
          ? `${latest.actual.toFixed(0)} gCO₂/kWh${latest.index !== null ? ` (${latest.index})` : ''} for the half-hour from ${hhmm(latest.time)} UTC` +
            (latest.forecast !== null ? `; forecast was ${latest.forecast.toFixed(0)}.` : '.')
          : `No actual value yet; forecast ${latest.forecast?.toFixed(0) ?? '?'} gCO₂/kWh for the half-hour from ${hhmm(latest.time)} UTC.`;
    }
    if (this.#mixList !== null && this.#mix !== null) {
      const mixTime = this.#mix.time;
      this.#mixList.replaceChildren(
        ...this.#mix.mix
          .filter((s) => s.perc > 0)
          .map((s) =>
            el(
              'li',
              { class: 'eventlist__item' },
              el('span', { class: 'eventlist__mag' }, `${s.perc.toFixed(1)}%`),
              el('span', { class: 'eventlist__place' }, s.fuel),
              el('span', { class: 'eventlist__time', title: new Date(mixTime).toISOString() }, `${hhmm(mixTime)} UTC`),
            ),
          ),
      );
    }
  }
}

register(new CarbonIntensity());
