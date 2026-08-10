import { BaseModule } from '../core/base-module.js';
import { RingBuffer } from '../core/ring-buffer.js';
import { register } from './registry.js';
import { WorldMap } from '../ui/world-map.js';
import { el, formatAge } from '../ui/dom.js';

/**
 * Seismicity — USGS real-time feeds. Lane A: keyless, CORS `*`, verified.
 *
 * Opens populated: the past 24 hours come from USGS's own `all_day` feed, then
 * `all_hour` is polled every 60s for what arrives next. Both are real received
 * events; the backfill is history the source published, not reconstruction.
 *
 * Every event carries USGS's own `time` field, which is when the quake was
 * determined to have occurred — never our fetch time. Markers appear when an
 * event arrives and do not move afterwards, because an earthquake does not
 * move: its location is a single fixed determination.
 */

interface Quake {
  id: string;
  lon: number;
  lat: number;
  depthKm: number | null;
  magnitude: number | null;
  place: string;
  /** USGS's own event time, in ms. */
  time: number;
  /** True when it arrived live rather than in the opening backfill. */
  live: boolean;
}

const HOUR_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson';
const DAY_FEED = 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson';
const POLL_MS = 60_000;

interface UsgsFeature {
  id?: unknown;
  properties?: { mag?: unknown; place?: unknown; time?: unknown };
  geometry?: { coordinates?: unknown };
}

function parseFeature(feature: UsgsFeature, live: boolean): Quake | null {
  const coordinates = feature.geometry?.coordinates;
  if (!Array.isArray(coordinates)) return null;
  const [lon, lat, depth] = coordinates as Array<number | undefined>;
  const time = feature.properties?.time;
  if (typeof lon !== 'number' || typeof lat !== 'number' || typeof time !== 'number') return null;
  const magnitude = feature.properties?.mag;
  return {
    id: String(feature.id ?? `${lon},${lat},${time}`),
    lon,
    lat,
    // A missing depth or magnitude stays null rather than becoming 0, which
    // would read as a real measurement of zero.
    depthKm: typeof depth === 'number' ? depth : null,
    magnitude: typeof magnitude === 'number' ? magnitude : null,
    place: typeof feature.properties?.place === 'string' ? feature.properties.place : 'location not given',
    time,
    live,
  };
}

class UsgsEarthquakes extends BaseModule {
  #events = new RingBuffer<Quake>(2000);
  #seen = new Set<string>();
  #timer: ReturnType<typeof setInterval> | null = null;
  #abort: AbortController | null = null;
  #map: WorldMap | null = null;
  #list: HTMLElement | null = null;
  #summary: HTMLElement | null = null;
  #backfilled = false;

  constructor() {
    super({
      id: 'usgs-earthquakes',
      section: 'earth',
      title: 'Global seismicity',
      oneLiner: 'Every earthquake USGS has located, as it is published.',
      why: 'The planet is measurably restless: on a normal day USGS locates dozens of quakes most people never feel. Each marker is one determination by a seismic network — it appears when the event is published and never moves, because a location is not a trajectory.',
      transport: 'poll',
      lane: 'A',
      latencyClass: 'near-real-time',
      cadence: 'every 60s',
      staleAfterMs: null,
      historyNote: 'Opens with the past 24 hours from USGS’s own all_day feed, then polls all_hour.',
      source: {
        name: 'USGS Earthquake Hazards Program',
        url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/',
        license: 'Public domain (U.S. Government work)',
        attribution: 'U.S. Geological Survey',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    const mapBox = el('div', { class: 'mapbox' });
    this.#summary = el('p', { class: 'module__summary' }, 'loading…');
    this.#list = el('ol', { class: 'eventlist' });
    el_.append(mapBox, this.#summary, this.#list);
    this.#map = new WorldMap(mapBox);
    this.#map.onRedraw(() => this.#draw());
    this.#draw();
  }

  protected openStream(): void {
    this.#abort = new AbortController();
    void this.#load(this.#backfilled ? HOUR_FEED : DAY_FEED, !this.#backfilled ? false : true);
    this.#timer = setInterval(() => void this.#load(HOUR_FEED, true), POLL_MS);
  }

  protected closeStream(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  unmount(): void {
    this.#map?.destroy();
    this.#map = null;
  }

  async #load(url: string, live: boolean): Promise<void> {
    try {
      const response = await fetch(url, { signal: this.#abort?.signal ?? null });
      if (!response.ok) {
        this.fail(`USGS returned HTTP ${response.status}`);
        return;
      }
      const body = (await response.json()) as { features?: UsgsFeature[] };
      const features = Array.isArray(body.features) ? body.features : [];

      let added = 0;
      let newestTime: number | null = null;
      for (const feature of features) {
        const quake = parseFeature(feature, live);
        if (quake === null || this.#seen.has(quake.id)) continue;
        this.#seen.add(quake.id);
        this.#events.push(quake);
        added += 1;
        if (newestTime === null || quake.time > newestTime) newestTime = quake.time;
      }

      if (!live) {
        // Opening backfill: real events, but not events that happened while you
        // were watching, so they are counted apart from the live total.
        this.markBackfilled(added);
        this.#backfilled = true;
        this.markOpen();
        // The newest historical event still sets the "age of last datum": it is
        // genuinely the most recent thing this source has published.
        if (newestTime !== null) this.markReceived(newestTime);
      } else if (added > 0 && newestTime !== null) {
        this.markReceived(newestTime);
      } else {
        // A poll that returned no new events is a successful poll. The feed is
        // healthy; the Earth was simply quiet. Health stays as it was.
        this.markOpen();
      }

      // The `seen` set is what prevents re-counting an event on every poll, and
      // it must not grow without bound over a long session.
      if (this.#seen.size > 6000) {
        this.#seen = new Set([...this.#events].map((q) => q.id));
      }

      this.#draw();
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.fail(error instanceof Error ? error.message : 'request failed');
    }
  }

  #draw(): void {
    const map = this.#map;
    if (map === null) return;
    map.clear();
    map.drawGraticule();
    map.drawLand();

    const ctx = map.ctx;
    const now = Date.now();
    for (const quake of this.#events) {
      const { x, y } = map.project(quake);
      // Radius encodes magnitude. An event with no reported magnitude is drawn
      // at a minimum size in a neutral colour rather than being hidden or
      // assigned a number nobody measured.
      const magnitude = quake.magnitude;
      const radius = magnitude === null ? 1.5 : Math.max(1.5, (magnitude - 1) * 1.6);
      const ageHours = (now - quake.time) / 3_600_000;
      // Older events fade. This is staleness made visible, not decoration.
      const alpha = Math.max(0.18, 1 - ageHours / 24);
      ctx.beginPath();
      ctx.arc(x, y, radius, 0, Math.PI * 2);
      if (magnitude === null) ctx.fillStyle = `rgba(139, 152, 166, ${alpha})`;
      else if (magnitude >= 5) ctx.fillStyle = `rgba(224, 102, 92, ${alpha})`;
      else if (magnitude >= 3) ctx.fillStyle = `rgba(224, 179, 65, ${alpha})`;
      else ctx.fillStyle = `rgba(84, 214, 160, ${alpha})`;
      ctx.fill();
    }

    const all = [...this.#events].sort((a, b) => b.time - a.time);
    const liveCount = all.filter((q) => q.live).length;
    if (this.#summary !== null) {
      this.#summary.textContent =
        `${all.length} located events on the map — ${this.#backfillLabel()}` +
        (liveCount > 0 ? `, ${liveCount} arrived since this page opened` : '');
    }

    if (this.#list !== null) {
      this.#list.replaceChildren(
        ...all.slice(0, 40).map((quake) =>
          el(
            'li',
            { class: quake.live ? 'eventlist__item eventlist__item--live' : 'eventlist__item' },
            el('span', { class: 'eventlist__mag' }, quake.magnitude === null ? '—' : quake.magnitude.toFixed(1)),
            el('span', { class: 'eventlist__place' }, quake.place),
            el(
              'span',
              { class: 'eventlist__time', title: new Date(quake.time).toISOString() },
              `${formatAge(now - quake.time)} ago`,
            ),
          ),
        ),
      );
    }
  }

  #backfillLabel(): string {
    return this.backfillCount > 0
      ? `${this.backfillCount} from the past 24h published by USGS`
      : 'history not loaded';
  }
}

register(new UsgsEarthquakes());
