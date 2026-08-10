import { BaseModule } from '../core/base-module.js';
import { register } from './registry.js';
import { WorldMap, type MapPoint } from '../ui/world-map.js';
import { el } from '../ui/dom.js';

/**
 * Surface temperature — hover the map to read the temperature.
 *
 * THE HONESTY PROBLEM, AND HOW IT IS SOLVED.
 *
 * The obvious way to build this is a smooth temperature raster: sample a coarse
 * grid, interpolate between the samples, and paint a continuous field. It looks
 * beautiful and it is forbidden here. Every pixel between two samples would be
 * a value invented by us — precisely what the first principle rules out.
 *
 * So the map paints DISCRETE CELLS at the resolution actually fetched, with
 * hard edges. The blockiness is not a limitation to apologise for; it is the
 * resolution of the data, made visible.
 *
 * Hovering then reports two clearly separated readings:
 *
 *   - GRID CELL: the value of the nearest fetched point, labelled with that
 *     point's own coordinates and how far away it is. Not "the temperature
 *     here" — the temperature at a named place that may be hundreds of km off.
 *   - EXACT POINT: when the pointer rests, the precise coordinate is fetched
 *     from the source. That one really is the temperature there.
 *
 * A second caveat is stated in the UI: Open-Meteo serves numerical weather
 * model output, not a thermometer reading at that spot. It is the best
 * available estimate for a location, not a measurement of it.
 */

const API = 'https://api.open-meteo.com/v1/forecast';
const LON_STEP = 20;
const LAT_STEP = 15;
const REFRESH_MS = 15 * 60 * 1000; // The source's own `current` interval is 900s.
const HOVER_SETTLE_MS = 450;

interface Cell {
  lon: number;
  lat: number;
  celsius: number;
  /** The model timestamp the source reported for this value. */
  time: number;
}

interface OpenMeteoPoint {
  latitude?: unknown;
  longitude?: unknown;
  current?: { time?: unknown; temperature_2m?: unknown };
}

function gridPoints(): MapPoint[] {
  const points: MapPoint[] = [];
  for (let lat = 75; lat >= -60; lat -= LAT_STEP) {
    for (let lon = -180; lon < 180; lon += LON_STEP) {
      points.push({ lon, lat });
    }
  }
  return points;
}

/** Blue → green → amber → red. Discrete lookup, no gradient between cells. */
function temperatureColour(celsius: number): string {
  if (celsius <= -20) return '#4a6fa5';
  if (celsius <= -10) return '#5d8bbf';
  if (celsius <= 0) return '#79a8cf';
  if (celsius <= 8) return '#84b8a6';
  if (celsius <= 16) return '#9fc57a';
  if (celsius <= 22) return '#d8c165';
  if (celsius <= 28) return '#e0a049';
  if (celsius <= 34) return '#dc7a4a';
  return '#cf5346';
}

function parsePoints(payload: unknown): Cell[] {
  const items = Array.isArray(payload) ? payload : [payload];
  const cells: Cell[] = [];
  for (const item of items as OpenMeteoPoint[]) {
    const lat = item?.latitude;
    const lon = item?.longitude;
    const celsius = item?.current?.temperature_2m;
    const time = item?.current?.time;
    if (typeof lat !== 'number' || typeof lon !== 'number') continue;
    if (typeof celsius !== 'number') continue;
    // The model timestamp has no zone suffix but is UTC per the request.
    const parsed = typeof time === 'string' ? Date.parse(`${time}:00Z`) : Number.NaN;
    cells.push({ lon, lat, celsius, time: Number.isNaN(parsed) ? 0 : parsed });
  }
  return cells;
}

class SurfaceTemperature extends BaseModule {
  #cells: Cell[] = [];
  #map: WorldMap | null = null;
  #readout: HTMLElement | null = null;
  #exactReadout: HTMLElement | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #hoverTimer: ReturnType<typeof setTimeout> | null = null;
  #abort: AbortController | null = null;
  #exactCache = new Map<string, { celsius: number; time: number }>();
  #onPointerMove: ((event: PointerEvent) => void) | null = null;
  #onPointerLeave: (() => void) | null = null;
  #hoverCell: Cell | null = null;

  constructor() {
    super({
      id: 'surface-temperature',
      section: 'earth',
      title: 'Surface temperature',
      oneLiner: 'Move the pointer over the map to read the air temperature there.',
      why: 'A planet-wide temperature field is available to anyone, for free, refreshed every quarter of an hour. The map is deliberately blocky: each cell is one fetched value, and nothing is drawn between them — the coarseness you see is the resolution of what was actually received.',
      transport: 'poll',
      lane: 'A',
      latencyClass: 'near-real-time',
      cadence: 'every 15 min',
      staleAfterMs: 45 * 60 * 1000,
      historyNote:
        'No backfill: this shows the current field only. Each refresh replaces it wholesale rather than accumulating a series.',
      source: {
        name: 'Open-Meteo',
        url: 'https://open-meteo.com/',
        license: 'CC BY 4.0',
        attribution: 'Weather data by Open-Meteo.com (numerical model output, not station observations)',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    const mapBox = el('div', { class: 'mapbox mapbox--interactive' });
    this.#readout = el('div', { class: 'readout-line' }, 'Move the pointer over the map.');
    this.#exactReadout = el('div', { class: 'readout-line readout-line--muted' }, '');

    el_.append(
      mapBox,
      this.#readout,
      this.#exactReadout,
      el(
        'p',
        { class: 'module__caveat' },
        'Each cell is one value fetched at its centre. Nothing is drawn between cells, so the map is blocky by design — smoothing it would mean inventing temperatures nobody reported. Open-Meteo serves numerical weather model output: the best available estimate for a location, not a thermometer reading at that spot.',
      ),
    );

    this.#map = new WorldMap(mapBox);
    this.#map.onRedraw(() => this.#draw());

    this.#onPointerMove = (event: PointerEvent) => this.#handleHover(event);
    this.#onPointerLeave = () => {
      this.#hoverCell = null;
      if (this.#hoverTimer !== null) clearTimeout(this.#hoverTimer);
      if (this.#readout !== null) this.#readout.textContent = 'Move the pointer over the map.';
      if (this.#exactReadout !== null) this.#exactReadout.textContent = '';
      this.#draw();
    };
    this.#map.canvas.addEventListener('pointermove', this.#onPointerMove);
    this.#map.canvas.addEventListener('pointerleave', this.#onPointerLeave);

    this.#draw();
  }

  protected openStream(): void {
    this.#abort = new AbortController();
    void this.#refresh();
    this.#timer = setInterval(() => void this.#refresh(), REFRESH_MS);
  }

  protected closeStream(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#hoverTimer !== null) clearTimeout(this.#hoverTimer);
    this.#hoverTimer = null;
    this.#abort?.abort();
    this.#abort = null;
    // The pointer listeners are deliberately NOT removed here. `closeStream`
    // runs on every reconnect, and tearing down the hover handlers on a failed
    // poll would silently kill the map's whole interaction after the first
    // retry. They belong to the mounted view and are released in `unmount`.
  }

  unmount(): void {
    if (this.#map !== null) {
      if (this.#onPointerMove !== null) this.#map.canvas.removeEventListener('pointermove', this.#onPointerMove);
      if (this.#onPointerLeave !== null) this.#map.canvas.removeEventListener('pointerleave', this.#onPointerLeave);
      this.#map.destroy();
      this.#map = null;
    }
    this.#exactCache.clear();
  }

  async #refresh(): Promise<void> {
    const points = gridPoints();
    const latitude = points.map((p) => p.lat).join(',');
    const longitude = points.map((p) => p.lon).join(',');
    try {
      const response = await fetch(
        `${API}?latitude=${latitude}&longitude=${longitude}&current=temperature_2m`,
        { signal: this.#abort?.signal ?? null },
      );
      if (!response.ok) {
        this.fail(`Open-Meteo returned HTTP ${response.status}`);
        return;
      }
      const cells = parsePoints(await response.json());
      if (cells.length === 0) {
        this.fail('Open-Meteo returned no usable values');
        return;
      }
      this.#cells = cells;
      // The source's own model timestamp, not our fetch time.
      const newest = cells.reduce((max, c) => (c.time > max ? c.time : max), 0);
      this.markReceived(newest > 0 ? newest : null);
      this.#draw();
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.fail(error instanceof Error ? error.message : 'request failed');
    }
  }

  #nearestCell(point: MapPoint): Cell | null {
    let best: Cell | null = null;
    let bestDistance = Infinity;
    for (const cell of this.#cells) {
      const dLon = Math.abs(cell.lon - point.lon);
      const dLat = Math.abs(cell.lat - point.lat);
      const distance = dLon * dLon + dLat * dLat;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = cell;
      }
    }
    return best;
  }

  /** Great-circle distance in km, for stating how far the grid point really is. */
  #distanceKm(a: MapPoint, b: MapPoint): number {
    const toRad = Math.PI / 180;
    const dLat = (b.lat - a.lat) * toRad;
    const dLon = (b.lon - a.lon) * toRad;
    const lat1 = a.lat * toRad;
    const lat2 = b.lat * toRad;
    const h =
      Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
    return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
  }

  #handleHover(event: PointerEvent): void {
    const map = this.#map;
    if (map === null || this.#readout === null) return;
    const point = map.pointerToCoords(event);
    if (point === null) return;

    const cell = this.#nearestCell(point);
    this.#hoverCell = cell;

    const where = `${point.lat.toFixed(1)}°, ${point.lon.toFixed(1)}°`;
    if (cell === null) {
      this.#readout.textContent = `${where} — no grid value loaded yet`;
    } else {
      const km = Math.round(this.#distanceKm(point, cell));
      this.#readout.replaceChildren(
        el('span', { class: 'readout-line__where' }, where),
        el('span', { class: 'readout-line__value' }, `${cell.celsius.toFixed(1)} °C`),
        el(
          'span',
          { class: 'readout-line__note' },
          `nearest grid point ${cell.lat}°, ${cell.lon}° — ${km} km away`,
        ),
      );
    }
    this.#draw();

    // When the pointer settles, ask the source for this exact coordinate. Only
    // then can the page claim a temperature *here* rather than *near here*.
    if (this.#hoverTimer !== null) clearTimeout(this.#hoverTimer);
    this.#hoverTimer = setTimeout(() => void this.#fetchExact(point), HOVER_SETTLE_MS);
  }

  async #fetchExact(point: MapPoint): Promise<void> {
    if (this.#exactReadout === null) return;
    const lat = Number(point.lat.toFixed(2));
    const lon = Number(point.lon.toFixed(2));
    const key = `${lat},${lon}`;

    const cached = this.#exactCache.get(key);
    if (cached !== undefined) {
      this.#showExact(lat, lon, cached.celsius, cached.time);
      return;
    }

    this.#exactReadout.textContent = `fetching the exact point ${lat}°, ${lon}°…`;
    try {
      const response = await fetch(`${API}?latitude=${lat}&longitude=${lon}&current=temperature_2m`, {
        signal: this.#abort?.signal ?? null,
      });
      if (!response.ok) {
        this.#exactReadout.textContent = `exact point unavailable — HTTP ${response.status}`;
        return;
      }
      const [cell] = parsePoints(await response.json());
      if (cell === undefined) {
        this.#exactReadout.textContent = 'exact point unavailable — no value returned';
        return;
      }
      // Bounded cache: a long hover session must not grow the heap.
      if (this.#exactCache.size > 300) this.#exactCache.clear();
      this.#exactCache.set(key, { celsius: cell.celsius, time: cell.time });
      this.#showExact(lat, lon, cell.celsius, cell.time);
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.#exactReadout.textContent = 'exact point unavailable — request failed';
    }
  }

  #showExact(lat: number, lon: number, celsius: number, time: number): void {
    if (this.#exactReadout === null) return;
    const stamp = time > 0 ? new Date(time).toISOString().slice(0, 16).replace('T', ' ') : 'time not given';
    this.#exactReadout.replaceChildren(
      el('span', { class: 'readout-line__where' }, `exact point ${lat}°, ${lon}°`),
      el('span', { class: 'readout-line__value' }, `${celsius.toFixed(1)} °C`),
      el('span', { class: 'readout-line__note' }, `model time ${stamp} UTC`),
    );
  }

  #draw(): void {
    const map = this.#map;
    if (map === null) return;
    map.clear();

    const ctx = map.ctx;
    const cellW = (LON_STEP / 360) * map.width;
    const cellH = (LAT_STEP / 180) * map.height;

    for (const cell of this.#cells) {
      const { x, y } = map.project(cell);
      ctx.fillStyle = temperatureColour(cell.celsius);
      // Hard-edged rectangles. No gradient, no blur, no interpolation between
      // neighbours — the cell is exactly as wide as the spacing that was
      // actually sampled.
      ctx.fillRect(x - cellW / 2, y - cellH / 2, cellW, cellH);
    }

    map.drawLand({ fill: 'rgba(0,0,0,0)', stroke: 'rgba(215, 222, 230, 0.45)' });
    map.drawGraticule('rgba(255,255,255,0.05)');

    if (this.#hoverCell !== null) {
      const { x, y } = map.project(this.#hoverCell);
      ctx.strokeStyle = '#ffffff';
      ctx.lineWidth = 1.5;
      ctx.strokeRect(x - cellW / 2, y - cellH / 2, cellW, cellH);
    }

    if (this.#cells.length === 0) {
      ctx.fillStyle = '#8b98a6';
      ctx.font = '13px ui-monospace, monospace';
      ctx.fillText('no values received yet', 16, 28);
    }
  }
}

register(new SurfaceTemperature());
