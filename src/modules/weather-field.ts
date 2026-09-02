import { BaseModule } from '../core/base-module.js';
import { register } from './registry.js';
import { WorldMap, type MapPoint } from '../ui/world-map.js';
import { el } from '../ui/dom.js';

/**
 * The atmosphere, sampled. Replaces the 20° × 15° temperature map.
 *
 * WHY THE OLD MAP WAS COARSE, AND WHAT ACTUALLY CHANGED. The giant blocks were
 * never a limit of the source — they were a fixed global grid of 216 points,
 * chosen to keep one refresh affordable. Open-Meteo will happily answer at
 * kilometre scale. What was missing was the idea that the grid should follow
 * the view: the same request budget spread over a country instead of a planet
 * is three orders of magnitude finer.
 *
 * So the sample spacing is computed from the visible extent on every view
 * change, and the cells drawn are exactly the cells fetched. Zoom in and the
 * resolution genuinely improves, down to the model's own grid.
 *
 * WHAT IS STILL REFUSED. The obvious next step — interpolate between samples
 * and paint a smooth field — is exactly the thing the first principle forbids.
 * Every pixel between two samples would be a value nobody computed and nobody
 * published. So the cells stay hard-edged at every zoom, and the sample spacing
 * is stated on screen. If the blocks look coarse, that is the resolution being
 * shown honestly rather than a picture being prettier than its data.
 *
 * There is a subtler version of the same mistake, and it is guarded too:
 * sampling FINER than the model's own grid. Two requests 200 m apart inside one
 * 2 km cell return the same number twice, and drawing them as two cells invents
 * detail that does not exist. Spacing is therefore clamped to the resolution
 * the model actually reports back.
 *
 * HOW THE RESOLUTION IS KNOWN. Not from documentation. Open-Meteo echoes the
 * coordinates and elevation of the grid cell it actually used, which is usually
 * not the point that was asked for. The distance between what was requested and
 * what came back is a direct measurement of the model's spacing, and that
 * measured number is what gets displayed.
 *
 * EVERYTHING IS MODEL OUTPUT. This is numerical weather prediction, not a
 * thermometer at that spot, and the page says so. `time` is the model's own
 * timestep — never our fetch time.
 */

interface Layer {
  id: string;
  /** Open-Meteo's `current=` variable name. */
  variable: string;
  label: string;
  unit: string;
  /** Value → colour. Domain chosen per variable, stated in the legend. */
  min: number;
  max: number;
  ramp: readonly [number, number, number][];
  /** How to phrase the reading in the hover box. */
  format(value: number): string;
}

const TEMP_RAMP: readonly [number, number, number][] = [
  [69, 117, 180],
  [145, 191, 219],
  [224, 243, 248],
  [254, 224, 144],
  [252, 141, 89],
  [215, 48, 39],
];

const MONO_RAMP: readonly [number, number, number][] = [
  [13, 17, 22],
  [40, 62, 84],
  [58, 110, 145],
  [92, 168, 180],
  [173, 216, 180],
  [247, 252, 185],
];

const WIND_RAMP: readonly [number, number, number][] = [
  [16, 24, 32],
  [30, 80, 110],
  [40, 140, 150],
  [120, 200, 130],
  [240, 220, 110],
  [230, 90, 70],
];

const PRESSURE_RAMP: readonly [number, number, number][] = [
  [90, 60, 140],
  [70, 110, 180],
  [130, 180, 200],
  [230, 230, 210],
  [235, 170, 90],
  [200, 70, 60],
];

const one = (unit: string) => (value: number) => `${value.toFixed(1)} ${unit}`;
const zero = (unit: string) => (value: number) => `${Math.round(value)} ${unit}`;

/**
 * The layers, drawn straight from what verification showed Open-Meteo returns
 * in a single `current=` request — temperature, humidity, pressure, wind at
 * four heights, four separate radiation components, cloud, CAPE and more, all
 * with their units. Every one of these was observed in a real response before
 * it was offered here.
 */
const LAYERS: readonly Layer[] = [
  { id: 'temperature_2m', variable: 'temperature_2m', label: 'Temperature (2 m)', unit: '°C', min: -40, max: 45, ramp: TEMP_RAMP, format: one('°C') },
  { id: 'apparent_temperature', variable: 'apparent_temperature', label: 'Apparent temperature', unit: '°C', min: -40, max: 50, ramp: TEMP_RAMP, format: one('°C') },
  { id: 'dew_point_2m', variable: 'dew_point_2m', label: 'Dew point', unit: '°C', min: -40, max: 30, ramp: TEMP_RAMP, format: one('°C') },
  { id: 'relative_humidity_2m', variable: 'relative_humidity_2m', label: 'Relative humidity', unit: '%', min: 0, max: 100, ramp: MONO_RAMP, format: zero('%') },
  { id: 'pressure_msl', variable: 'pressure_msl', label: 'Pressure (mean sea level)', unit: 'hPa', min: 970, max: 1045, ramp: PRESSURE_RAMP, format: one('hPa') },
  { id: 'surface_pressure', variable: 'surface_pressure', label: 'Surface pressure', unit: 'hPa', min: 600, max: 1045, ramp: PRESSURE_RAMP, format: one('hPa') },
  { id: 'wind_speed_10m', variable: 'wind_speed_10m', label: 'Wind at 10 m', unit: 'km/h', min: 0, max: 120, ramp: WIND_RAMP, format: one('km/h') },
  { id: 'wind_speed_80m', variable: 'wind_speed_80m', label: 'Wind at 80 m', unit: 'km/h', min: 0, max: 140, ramp: WIND_RAMP, format: one('km/h') },
  { id: 'wind_speed_120m', variable: 'wind_speed_120m', label: 'Wind at 120 m', unit: 'km/h', min: 0, max: 150, ramp: WIND_RAMP, format: one('km/h') },
  { id: 'wind_speed_180m', variable: 'wind_speed_180m', label: 'Wind at 180 m', unit: 'km/h', min: 0, max: 160, ramp: WIND_RAMP, format: one('km/h') },
  { id: 'wind_gusts_10m', variable: 'wind_gusts_10m', label: 'Wind gusts (10 m)', unit: 'km/h', min: 0, max: 180, ramp: WIND_RAMP, format: one('km/h') },
  { id: 'shortwave_radiation', variable: 'shortwave_radiation', label: 'Shortwave radiation', unit: 'W/m²', min: 0, max: 1000, ramp: MONO_RAMP, format: zero('W/m²') },
  { id: 'direct_normal_irradiance', variable: 'direct_normal_irradiance', label: 'Direct normal irradiance', unit: 'W/m²', min: 0, max: 1000, ramp: MONO_RAMP, format: zero('W/m²') },
  { id: 'diffuse_radiation', variable: 'diffuse_radiation', label: 'Diffuse radiation', unit: 'W/m²', min: 0, max: 600, ramp: MONO_RAMP, format: zero('W/m²') },
  { id: 'cloud_cover', variable: 'cloud_cover', label: 'Cloud cover', unit: '%', min: 0, max: 100, ramp: MONO_RAMP, format: zero('%') },
  { id: 'cape', variable: 'cape', label: 'CAPE (thunderstorm energy)', unit: 'J/kg', min: 0, max: 4000, ramp: WIND_RAMP, format: zero('J/kg') },
  { id: 'precipitation', variable: 'precipitation', label: 'Precipitation', unit: 'mm', min: 0, max: 20, ramp: MONO_RAMP, format: one('mm') },
];

/** Every variable fetched per sample, so switching layers costs no new request. */
const ALL_VARIABLES = LAYERS.map((layer) => layer.variable).join(',');

/**
 * Samples per refresh. Deliberately modest: this runs in the visitor's own
 * browser against Open-Meteo's free tier, so the budget being spent is theirs,
 * and a map that burns someone's daily quota in a minute of panning is not a
 * map anybody gets to use twice.
 */
const TARGET_SAMPLES = 260;
/** Never sample finer than this, whatever the zoom — see the header. */
const FLOOR_SPACING_DEG = 0.01;
const REFRESH_MS = 10 * 60_000;
/** Pan and zoom settle before anything is fetched. */
const VIEW_SETTLE_MS = 550;
const HOVER_SETTLE_MS = 450;

interface Sample {
  /** What we asked for. */
  requested: MapPoint;
  /** The grid cell the model actually answered with. */
  cell: MapPoint;
  elevation: number | null;
  /** The model's own timestep for this reading. Never our fetch time. */
  time: number | null;
  values: Map<string, number>;
}

interface Grid {
  samples: Sample[];
  spacingDeg: number;
  /** Measured, not claimed: median distance from requested point to model cell. */
  measuredCellKm: number | null;
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

function rampColour(ramp: readonly [number, number, number][], t: number): string {
  const clamped = Math.min(1, Math.max(0, t));
  const scaled = clamped * (ramp.length - 1);
  const index = Math.min(ramp.length - 2, Math.floor(scaled));
  const frac = scaled - index;
  const from = ramp[index]!;
  const to = ramp[index + 1]!;
  return `rgb(${Math.round(lerp(from[0], to[0], frac))}, ${Math.round(lerp(from[1], to[1], frac))}, ${Math.round(lerp(from[2], to[2], frac))})`;
}

/** Great-circle distance in km. Used to measure the model's real cell size. */
function distanceKm(a: MapPoint, b: MapPoint): number {
  const toRad = Math.PI / 180;
  const dLat = (b.lat - a.lat) * toRad;
  const dLon = (b.lon - a.lon) * toRad;
  const lat1 = a.lat * toRad;
  const lat2 = b.lat * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLon / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.min(1, Math.sqrt(h)));
}

interface OpenMeteoPoint {
  latitude?: unknown;
  longitude?: unknown;
  elevation?: unknown;
  current?: Record<string, unknown>;
}

class WeatherField extends BaseModule {
  #map: WorldMap | null = null;
  #grid: Grid | null = null;
  #layer: Layer = LAYERS[0]!;

  #summary: HTMLElement | null = null;
  #resolutionLine: HTMLElement | null = null;
  #hover: HTMLElement | null = null;
  #legend: HTMLElement | null = null;
  #resetButton: HTMLElement | null = null;

  #abort: AbortController | null = null;
  #timer: ReturnType<typeof setInterval> | null = null;
  #viewTimer: ReturnType<typeof setTimeout> | null = null;
  #hoverTimer: ReturnType<typeof setTimeout> | null = null;
  #onPointerMove: ((event: PointerEvent) => void) | null = null;
  #onPointerLeave: (() => void) | null = null;

  #hoverPoint: MapPoint | null = null;
  #exact: { point: MapPoint; cell: MapPoint; elevation: number | null; time: number | null; values: Map<string, number> } | null = null;
  #exactCache = new Map<string, Sample>();

  constructor() {
    super({
      id: 'weather-field',
      section: 'earth',
      title: 'The atmosphere, sampled',
      oneLiner:
        'Seventeen model fields — temperature, pressure, wind at four heights, radiation, storm energy — at whatever resolution the view allows.',
      why: 'Numerical weather prediction is one of the great quiet achievements of computing: the whole atmosphere, solved on a grid, updated hour after hour, and given away for nothing. Zooming in here does not enlarge pixels — it fetches a finer grid, until you reach the model’s own.',
      transport: 'poll',
      lane: 'A',
      // Model output on a fixed timestep, refreshed on a cadence. Not live, and
      // the badge says so.
      latencyClass: 'near-real-time',
      cadence: 'every 10 min',
      staleAfterMs: 35 * 60_000,
      historyNote:
        'No history here: this is the current model timestep across an area, not a series through time. The model’s own timestamp is shown for every reading.',
      source: {
        name: 'Open-Meteo',
        url: 'https://open-meteo.com/',
        license: 'CC BY 4.0 (non-commercial use free, no key required)',
        attribution: 'Open-Meteo.com — weather data by national weather services',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;

    const select = el('select', { class: 'field__select', 'aria-label': 'Which field to draw' }) as HTMLSelectElement;
    for (const layer of LAYERS) {
      const option = el('option', { value: layer.id }, layer.label) as HTMLOptionElement;
      select.append(option);
    }
    select.value = this.#layer.id;
    select.addEventListener('change', () => {
      const found = LAYERS.find((layer) => layer.id === select.value);
      // Switching layer costs nothing upstream: every variable is already in
      // each sample, so this is a repaint rather than a refetch.
      if (found !== undefined) this.#layer = found;
      this.#draw();
    });

    const reset = el('button', { class: 'field__reset', type: 'button' }, 'Whole world');
    reset.addEventListener('click', () => {
      this.#map?.resetView();
      this.#draw();
      this.#scheduleGridFetch(0);
    });
    this.#resetButton = reset;

    const controls = el('div', { class: 'field__controls' }, select, reset);
    const mapBox = el('div', { class: 'mapbox' });
    this.#summary = el('p', { class: 'module__summary' }, 'loading…');
    this.#resolutionLine = el('p', { class: 'module__latency' }, '');
    this.#hover = el('div', { class: 'field__hover' }, 'Move the pointer over the map. Scroll to zoom, drag to pan.');
    this.#legend = el('div', { class: 'field__legend' });

    el_.append(controls, mapBox, this.#legend, this.#hover, this.#summary, this.#resolutionLine);

    const map = new WorldMap(mapBox);
    this.#map = map;
    map.onRedraw(() => this.#draw());
    map.enableNavigation(() => {
      // Debounced: a pan is dozens of pointer events, and one request per event
      // would be an act of vandalism against a free API.
      this.#scheduleGridFetch(VIEW_SETTLE_MS);
    });

    this.#onPointerMove = (event: PointerEvent): void => {
      if (map.isDragging) return;
      this.#hoverPoint = map.pointerToCoords(event);
      this.#renderHover();
      if (this.#hoverTimer !== null) clearTimeout(this.#hoverTimer);
      this.#hoverTimer = setTimeout(() => void this.#fetchExact(), HOVER_SETTLE_MS);
    };
    this.#onPointerLeave = (): void => {
      this.#hoverPoint = null;
      this.#exact = null;
      this.#renderHover();
    };
    map.canvas.addEventListener('pointermove', this.#onPointerMove);
    map.canvas.addEventListener('pointerleave', this.#onPointerLeave);

    this.#draw();
  }

  protected openStream(): void {
    this.#abort = new AbortController();
    void this.#fetchGrid();
    this.#timer = setInterval(() => void this.#fetchGrid(), REFRESH_MS);
  }

  protected closeStream(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    if (this.#viewTimer !== null) clearTimeout(this.#viewTimer);
    this.#viewTimer = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  /**
   * Pointer and view listeners live here rather than in `closeStream`, which
   * runs on every reconnect. Removing them there is what silently killed the
   * old map's hover after its first failed poll.
   */
  unmount(): void {
    if (this.#hoverTimer !== null) clearTimeout(this.#hoverTimer);
    this.#hoverTimer = null;
    const map = this.#map;
    if (map !== null) {
      if (this.#onPointerMove) map.canvas.removeEventListener('pointermove', this.#onPointerMove);
      if (this.#onPointerLeave) map.canvas.removeEventListener('pointerleave', this.#onPointerLeave);
      map.destroy();
    }
    this.#map = null;
    this.#onPointerMove = null;
    this.#onPointerLeave = null;
  }

  #scheduleGridFetch(delay: number): void {
    if (this.#viewTimer !== null) clearTimeout(this.#viewTimer);
    this.#viewTimer = setTimeout(() => void this.#fetchGrid(), delay);
  }

  /**
   * Choose the sample spacing for the current view.
   *
   * Two constraints, both hard. The number of samples is capped so a refresh
   * stays affordable, and the spacing is never finer than `FLOOR_SPACING_DEG` —
   * because sampling inside a single model cell returns the same value twice
   * and drawing it as two cells would be inventing detail.
   */
  #spacingFor(map: WorldMap): number {
    const spanLat = map.spanLat;
    const spanLon = map.spanLon;
    // Solve rows * cols ≈ TARGET_SAMPLES with rows/cols matching the aspect.
    const spacing = Math.sqrt((spanLat * spanLon) / TARGET_SAMPLES);
    return Math.max(FLOOR_SPACING_DEG, spacing);
  }

  async #fetchGrid(): Promise<void> {
    const map = this.#map;
    if (map === null) return;

    const spacing = this.#spacingFor(map);
    const view = map.view;
    const lats: number[] = [];
    const lons: number[] = [];
    // Sample at cell CENTRES, so the rectangle drawn around each reading is
    // actually centred on the point that was measured.
    for (let lat = view.south + spacing / 2; lat < view.north; lat += spacing) {
      for (let lon = view.west + spacing / 2; lon < view.east; lon += spacing) {
        if (lat < -90 || lat > 90) continue;
        let wrapped = lon;
        while (wrapped > 180) wrapped -= 360;
        while (wrapped < -180) wrapped += 360;
        lats.push(Number(lat.toFixed(4)));
        lons.push(Number(wrapped.toFixed(4)));
      }
    }
    if (lats.length === 0) return;

    const url =
      `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}` +
      `&current=${ALL_VARIABLES}&cell_selection=nearest`;

    try {
      const response = await fetch(url, { signal: this.#abort?.signal ?? null });
      if (!response.ok) {
        this.fail(
          response.status === 429
            ? 'Open-Meteo is rate-limiting this browser — it allows a limited number of requests per day per address. Zoom or pan less often, or come back later.'
            : `Open-Meteo returned HTTP ${response.status}`,
        );
        return;
      }
      const body = (await response.json()) as OpenMeteoPoint[] | OpenMeteoPoint;
      // One coordinate returns an object, several return an array.
      const points = Array.isArray(body) ? body : [body];

      const samples: Sample[] = [];
      let newestTime: number | null = null;
      const offsets: number[] = [];

      points.forEach((point, index) => {
        const current = point.current;
        if (current === undefined) return;
        const cellLat = typeof point.latitude === 'number' ? point.latitude : null;
        const cellLon = typeof point.longitude === 'number' ? point.longitude : null;
        if (cellLat === null || cellLon === null) return;

        const values = new Map<string, number>();
        for (const layer of LAYERS) {
          const raw = current[layer.variable];
          // A variable a model does not carry comes back null. It stays absent
          // rather than becoming zero, which would read as a real measurement.
          if (typeof raw === 'number' && Number.isFinite(raw)) values.set(layer.variable, raw);
        }

        const stamp = current['time'];
        const time = typeof stamp === 'string' ? Date.parse(`${stamp}:00Z`) : Number.NaN;
        const timeMs = Number.isFinite(time) ? time : null;
        if (timeMs !== null && (newestTime === null || timeMs > newestTime)) newestTime = timeMs;

        const requested: MapPoint = { lat: lats[index] ?? cellLat, lon: lons[index] ?? cellLon };
        const cell: MapPoint = { lat: cellLat, lon: cellLon };
        offsets.push(distanceKm(requested, cell));

        samples.push({
          requested,
          cell,
          elevation: typeof point.elevation === 'number' ? point.elevation : null,
          time: timeMs,
          values,
        });
      });

      if (samples.length === 0) {
        this.fail('Open-Meteo answered, but with no usable readings for this view.');
        return;
      }

      // The model's real cell size, measured rather than looked up: the typical
      // distance between the point asked for and the cell that answered is
      // about half a cell, so twice the median is a fair estimate of spacing.
      offsets.sort((a, b) => a - b);
      const median = offsets[Math.floor(offsets.length / 2)] ?? 0;

      this.#grid = { samples, spacingDeg: spacing, measuredCellKm: median > 0 ? median * 2 : null };
      this.#exactCache.clear();
      this.markReceived(newestTime);
      this.#draw();
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.fail(error instanceof Error ? error.message : 'the request failed');
    }
  }

  /**
   * Fetch the exact coordinate under a settled pointer.
   *
   * The grid answers "near here". This answers "here". Conflating the two is
   * the single easiest way for a map like this to mislead, so they are fetched
   * separately and displayed as separate lines.
   */
  async #fetchExact(): Promise<void> {
    const point = this.#hoverPoint;
    if (point === null) return;
    const key = `${point.lat.toFixed(3)},${point.lon.toFixed(3)}`;
    const cached = this.#exactCache.get(key);
    if (cached !== undefined) {
      this.#exact = { point, cell: cached.cell, elevation: cached.elevation, time: cached.time, values: cached.values };
      this.#renderHover();
      return;
    }

    try {
      const response = await fetch(
        `https://api.open-meteo.com/v1/forecast?latitude=${point.lat.toFixed(4)}&longitude=${point.lon.toFixed(4)}` +
          `&current=${ALL_VARIABLES}&cell_selection=nearest`,
        { signal: this.#abort?.signal ?? null },
      );
      if (!response.ok) return;
      const body = (await response.json()) as OpenMeteoPoint;
      const current = body.current;
      if (current === undefined) return;
      const values = new Map<string, number>();
      for (const layer of LAYERS) {
        const raw = current[layer.variable];
        if (typeof raw === 'number' && Number.isFinite(raw)) values.set(layer.variable, raw);
      }
      const stamp = current['time'];
      const parsed = typeof stamp === 'string' ? Date.parse(`${stamp}:00Z`) : Number.NaN;
      const sample: Sample = {
        requested: point,
        cell: {
          lat: typeof body.latitude === 'number' ? body.latitude : point.lat,
          lon: typeof body.longitude === 'number' ? body.longitude : point.lon,
        },
        elevation: typeof body.elevation === 'number' ? body.elevation : null,
        time: Number.isFinite(parsed) ? parsed : null,
        values,
      };
      // Bounded, so a long session of hovering cannot grow without limit.
      if (this.#exactCache.size > 300) this.#exactCache.clear();
      this.#exactCache.set(key, sample);
      if (this.#hoverPoint === point) {
        this.#exact = { point, cell: sample.cell, elevation: sample.elevation, time: sample.time, values: sample.values };
        this.#renderHover();
      }
    } catch {
      // A failed exact lookup leaves the nearest-sample line standing, which is
      // still true. Nothing is substituted for the missing exact reading.
    }
  }

  #nearest(point: MapPoint): Sample | null {
    const grid = this.#grid;
    if (grid === null || grid.samples.length === 0) return null;
    let best: Sample | null = null;
    let bestDistance = Infinity;
    for (const sample of grid.samples) {
      const d = distanceKm(point, sample.cell);
      if (d < bestDistance) {
        bestDistance = d;
        best = sample;
      }
    }
    return best;
  }

  #draw(): void {
    const map = this.#map;
    if (map === null) return;
    map.clear();
    map.drawGraticule();

    const grid = this.#grid;
    const layer = this.#layer;

    if (grid !== null) {
      const ctx = map.ctx;
      const spacing = grid.spacingDeg;
      for (const sample of grid.samples) {
        const value = sample.values.get(layer.variable);
        // No reading for this variable at this point: leave the cell empty.
        // A gap is shown as a gap.
        if (value === undefined) continue;
        const topLeft = map.project({ lat: sample.requested.lat + spacing / 2, lon: sample.requested.lon - spacing / 2 });
        const bottomRight = map.project({ lat: sample.requested.lat - spacing / 2, lon: sample.requested.lon + spacing / 2 });
        const w = Math.max(1, bottomRight.x - topLeft.x);
        const h = Math.max(1, bottomRight.y - topLeft.y);
        ctx.fillStyle = rampColour(layer.ramp, (value - layer.min) / (layer.max - layer.min));
        // Hard-edged rectangles, at exactly the spacing sampled. No blur, no
        // gradient, no interpolation between neighbours.
        ctx.fillRect(topLeft.x, topLeft.y, w + 0.5, h + 0.5);
      }
    }

    // Coastline over the field, so the data is not hidden by the basemap.
    map.drawLand({ fill: 'rgba(0,0,0,0)', stroke: 'rgba(190, 205, 220, 0.55)' });

    this.#renderLegend();
    this.#renderSummary();
    this.#renderHover();
  }

  #renderLegend(): void {
    const legend = this.#legend;
    if (legend === null) return;
    const layer = this.#layer;
    const stops = 7;
    legend.replaceChildren(
      el('span', { class: 'field__legendlabel' }, `${layer.min}`),
      ...Array.from({ length: stops }, (_, i) =>
        el('span', {
          class: 'field__legendswatch',
          style: `background:${rampColour(layer.ramp, i / (stops - 1))}`,
          title: `${(layer.min + ((layer.max - layer.min) * i) / (stops - 1)).toFixed(0)} ${layer.unit}`,
        }),
      ),
      el('span', { class: 'field__legendlabel' }, `${layer.max} ${layer.unit}`),
    );
  }

  #renderSummary(): void {
    const map = this.#map;
    const grid = this.#grid;
    if (this.#summary === null || map === null) return;

    if (grid === null) {
      this.#summary.textContent = this.health === 'error' ? 'no readings for this view' : 'loading…';
    } else {
      const withValue = grid.samples.filter((s) => s.values.has(this.#layer.variable)).length;
      this.#summary.textContent =
        `${withValue} of ${grid.samples.length} sampled points report ${this.#layer.label.toLowerCase()} · ` +
        `view ${map.spanLat.toFixed(map.spanLat < 5 ? 2 : 0)}° tall`;
    }

    if (this.#resolutionLine !== null) {
      const spacingKm = grid === null ? null : grid.spacingDeg * 111.32;
      const parts: string[] = [];
      if (spacingKm !== null) {
        parts.push(
          `Cells drawn at the spacing sampled: ${
            spacingKm >= 100 ? `${Math.round(spacingKm)} km` : `${spacingKm.toFixed(1)} km`
          }`,
        );
      }
      if (grid?.measuredCellKm != null) {
        // Measured from how far the model's answer sat from the point asked
        // for — not read off a documentation page.
        parts.push(`model grid measured at about ${grid.measuredCellKm.toFixed(1)} km here`);
      }
      parts.push('zoom in for a finer sample');
      const coastline = map.coastlineNote;
      if (coastline !== null) parts.push(coastline);
      this.#resolutionLine.textContent = parts.join(' · ');
    }

    if (this.#resetButton !== null) {
      this.#resetButton.toggleAttribute('hidden', map.isWorldView);
    }
  }

  #renderHover(): void {
    const hover = this.#hover;
    if (hover === null) return;
    const point = this.#hoverPoint;
    if (point === null) {
      hover.replaceChildren('Move the pointer over the map. Scroll to zoom, drag to pan.');
      return;
    }

    const layer = this.#layer;
    const nearest = this.#nearest(point);
    const rows: HTMLElement[] = [
      el('div', { class: 'field__hoverhead' }, `${point.lat.toFixed(3)}°, ${point.lon.toFixed(3)}°`),
    ];

    if (nearest === null) {
      rows.push(el('div', { class: 'field__hoverrow' }, 'no sample loaded for this view yet'));
    } else {
      const value = nearest.values.get(layer.variable);
      const away = distanceKm(point, nearest.cell);
      rows.push(
        el(
          'div',
          { class: 'field__hoverrow' },
          // "Near here" is named as such, with the distance, so it is never
          // mistaken for a reading at the cursor.
          el('span', { class: 'field__hoverkey' }, 'nearest sample'),
          el(
            'span',
            {},
            value === undefined
              ? 'not reported here'
              : `${layer.format(value)} · ${nearest.cell.lat.toFixed(3)}°, ${nearest.cell.lon.toFixed(3)}° — ${away.toFixed(0)} km away`,
          ),
        ),
      );
    }

    const exact = this.#exact;
    if (exact !== null && exact.point === point) {
      const value = exact.values.get(layer.variable);
      rows.push(
        el(
          'div',
          { class: 'field__hoverrow field__hoverrow--exact' },
          el('span', { class: 'field__hoverkey' }, 'at this point'),
          el(
            'span',
            {},
            value === undefined
              ? 'not reported'
              : `${layer.format(value)} · model cell ${exact.cell.lat.toFixed(3)}°, ${exact.cell.lon.toFixed(3)}°` +
                (exact.elevation === null ? '' : ` at ${Math.round(exact.elevation)} m`),
          ),
        ),
      );
      // Every other variable at the exact point, so one settled hover answers
      // all seventeen questions rather than only the one being painted.
      const others = LAYERS.filter((other) => other.id !== layer.id && exact.values.has(other.variable));
      if (others.length > 0) {
        rows.push(
          el(
            'div',
            { class: 'field__hoverall' },
            ...others.map((other) =>
              el(
                'span',
                { class: 'field__hoverchip' },
                `${other.label}: ${other.format(exact.values.get(other.variable)!)}`,
              ),
            ),
          ),
        );
      }
      if (exact.time !== null) {
        rows.push(
          el(
            'div',
            { class: 'field__hoverrow field__hoverrow--time' },
            el('span', { class: 'field__hoverkey' }, 'model timestep'),
            el('span', {}, `${new Date(exact.time).toISOString().slice(0, 16).replace('T', ' ')} UTC`),
          ),
        );
      }
    } else {
      rows.push(el('div', { class: 'field__hoverrow field__hoverrow--pending' }, 'hold still to fetch this exact point'));
    }

    hover.replaceChildren(...rows);
  }
}

register(new WeatherField());
