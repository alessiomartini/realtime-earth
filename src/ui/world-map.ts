import { feature } from 'topojson-client';
import landTopology from 'world-atlas/land-110m.json';
import type { Topology } from 'topojson-specification';

/**
 * A world map on a canvas, in equirectangular projection.
 *
 * Deliberately not a tile map. Tiles would mean an external provider on every
 * pan, a usage policy to honour, and a basemap whose visual weight competes
 * with the data. This draws a coastline from Natural Earth, bundled at build
 * time, and hands the canvas to the caller to draw on.
 *
 * Equirectangular is chosen because longitude and latitude map linearly to x
 * and y, which makes the inverse exact and cheap — the map has to answer "what
 * are the coordinates under the cursor?" on every mouse move.
 *
 * Nothing here animates. Redraw happens when data arrives, not on a frame loop.
 */

const land = feature(
  landTopology as unknown as Topology,
  (landTopology as unknown as Topology).objects['land']!,
) as unknown as GeoJSON.FeatureCollection<GeoJSON.MultiPolygon | GeoJSON.Polygon>;

export interface MapPoint {
  lon: number;
  lat: number;
}

/** The geographic extent currently drawn. */
export interface MapView {
  west: number;
  east: number;
  south: number;
  north: number;
}

export const WORLD_VIEW: Readonly<MapView> = { west: -180, east: 180, south: -90, north: 90 };

/**
 * How far in the map will go, and why it stops there.
 *
 * Not an arbitrary limit. The bundled coastlines are 1:110m and 1:50m. Below
 * roughly a quarter-degree span the outline is visibly wrong, and a wrong
 * coastline drawn confidently is its own small dishonesty. Data sampling can go
 * finer than this; the basemap cannot, so below a threshold it is dropped and
 * said to be dropped, rather than stretched and presented as a coastline.
 */
const MIN_SPAN_LAT = 0.25;
const MAX_SPAN_LAT = 180;

/** Below this span the 1:110m outline is too crude, so the finer one is loaded. */
const DETAIL_COASTLINE_BELOW_SPAN = 90;
/** Below this span no bundled coastline is accurate enough to draw at all. */
const NO_COASTLINE_BELOW_SPAN = 1.5;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

type LandCollection = GeoJSON.FeatureCollection<GeoJSON.MultiPolygon | GeoJSON.Polygon>;

/**
 * The finer coastline is fetched on demand rather than bundled: it is ten times
 * the size of the coarse one, and a visitor who never zooms in should not pay
 * for it on first load.
 */
let detailLand: LandCollection | null = null;
let detailLandPending: Promise<void> | null = null;

function loadDetailCoastline(onReady: () => void): void {
  if (detailLand !== null || detailLandPending !== null) return;
  detailLandPending = import('world-atlas/land-50m.json')
    .then((module) => {
      const topology = (module.default ?? module) as unknown as Topology;
      detailLand = feature(topology, topology.objects['land']!) as unknown as LandCollection;
      onReady();
    })
    .catch(() => {
      // Nothing to recover: the coarse coastline stays, which is honest about
      // what it is. A failed enhancement must not take the map down with it.
    })
    .finally(() => {
      detailLandPending = null;
    });
}

export class WorldMap {
  readonly canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #width = 0;
  #height = 0;
  #dpr = 1;
  #resizeObserver: ResizeObserver | null = null;
  #onRedraw: (() => void) | null = null;

  #view: MapView = { ...WORLD_VIEW };
  #navEnabled = false;
  #onViewChange: (() => void) | null = null;
  #dragging: { x: number; y: number; moved: boolean } | null = null;
  #onWheel: ((event: WheelEvent) => void) | null = null;
  #onPointerDown: ((event: PointerEvent) => void) | null = null;
  #onPointerMove: ((event: PointerEvent) => void) | null = null;
  #onPointerUp: ((event: PointerEvent) => void) | null = null;

  constructor(container: HTMLElement) {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'worldmap';
    container.append(this.canvas);

    const ctx = this.canvas.getContext('2d');
    if (ctx === null) throw new Error('2D canvas context unavailable');
    this.#ctx = ctx;

    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.resize());
      this.#resizeObserver.observe(container);
    }
    this.resize();
  }

  get width(): number {
    return this.#width;
  }

  get height(): number {
    return this.#height;
  }

  /** Called after every resize so the owner can repaint its overlay. */
  onRedraw(handler: () => void): void {
    this.#onRedraw = handler;
  }

  resize(): void {
    const rect = this.canvas.parentElement?.getBoundingClientRect();
    if (!rect || rect.width === 0) return;
    // Lock to a 2:1 box, the natural aspect of an equirectangular world.
    const width = Math.floor(rect.width);
    const height = Math.floor(width / 2);
    this.#dpr = Math.min(window.devicePixelRatio || 1, 2);
    this.#width = width;
    this.#height = height;
    this.canvas.width = Math.floor(width * this.#dpr);
    this.canvas.height = Math.floor(height * this.#dpr);
    this.canvas.style.width = `${width}px`;
    this.canvas.style.height = `${height}px`;
    this.#ctx.setTransform(this.#dpr, 0, 0, this.#dpr, 0, 0);
    // Re-apply the view so it keeps matching the canvas aspect. Without this a
    // resize would stretch the projection and every distance read off the map
    // would quietly become wrong.
    this.setView(this.#view);
    this.#onRedraw?.();
  }

  get view(): Readonly<MapView> {
    return this.#view;
  }

  /** Degrees of latitude currently visible. The map's "zoom", in real units. */
  get spanLat(): number {
    return this.#view.north - this.#view.south;
  }

  get spanLon(): number {
    return this.#view.east - this.#view.west;
  }

  /**
   * Metres per screen pixel at the view's centre latitude — what a caller needs
   * to decide how finely it is worth sampling. Sampling below one pixel would
   * produce detail nobody can see; sampling below the model's own cell size
   * would produce detail that does not exist.
   */
  get metresPerPixel(): number {
    if (this.#height === 0) return Infinity;
    return (this.spanLat * 111_320) / this.#height;
  }

  /**
   * Replace the visible extent. The view is forced to the canvas's aspect ratio
   * so that a degree of latitude and a degree of longitude keep the same
   * on-screen scale — without that, an equirectangular map silently stretches
   * and every distance read off it is wrong.
   */
  setView(next: MapView): void {
    const aspect = this.#height === 0 ? 2 : this.#width / this.#height;
    let spanLat = clamp(next.north - next.south, MIN_SPAN_LAT, MAX_SPAN_LAT);
    let spanLon = spanLat * aspect;
    if (spanLon > 360) {
      spanLon = 360;
      spanLat = spanLon / aspect;
    }

    const centreLat = clamp((next.north + next.south) / 2, -90 + spanLat / 2, 90 - spanLat / 2);
    let centreLon = (next.east + next.west) / 2;
    // Longitude wraps; latitude does not. Keeping the centre in range rather
    // than clamping the edges is what stops a pan at the date line from
    // collapsing the view.
    if (centreLon > 180) centreLon -= 360;
    if (centreLon < -180) centreLon += 360;

    this.#view = {
      west: centreLon - spanLon / 2,
      east: centreLon + spanLon / 2,
      south: centreLat - spanLat / 2,
      north: centreLat + spanLat / 2,
    };

    if (this.spanLat < DETAIL_COASTLINE_BELOW_SPAN) {
      loadDetailCoastline(() => this.#onRedraw?.());
    }
  }

  resetView(): void {
    this.setView({ ...WORLD_VIEW });
  }

  get isWorldView(): boolean {
    return this.spanLat >= MAX_SPAN_LAT - 0.001;
  }

  project({ lon, lat }: MapPoint): { x: number; y: number } {
    const view = this.#view;
    // Unwrap longitude into the view's own frame, so a view spanning the date
    // line still places points on the correct side rather than off-canvas.
    let lon_ = lon;
    while (lon_ < view.west - 180) lon_ += 360;
    while (lon_ > view.west + 180) lon_ -= 360;
    return {
      x: ((lon_ - view.west) / (view.east - view.west)) * this.#width,
      y: ((view.north - lat) / (view.north - view.south)) * this.#height,
    };
  }

  /** Exact inverse of `project` — no search, no approximation. */
  unproject(x: number, y: number): MapPoint {
    const view = this.#view;
    let lon = view.west + (x / this.#width) * (view.east - view.west);
    if (lon > 180) lon -= 360;
    if (lon < -180) lon += 360;
    return { lon, lat: view.north - (y / this.#height) * (view.north - view.south) };
  }

  /** Zoom by `factor` about a screen point, keeping the coordinate under it fixed. */
  zoomAt(x: number, y: number, factor: number): void {
    const anchor = this.unproject(x, y);
    const spanLat = clamp(this.spanLat / factor, MIN_SPAN_LAT, MAX_SPAN_LAT);
    const aspect = this.#height === 0 ? 2 : this.#width / this.#height;
    const spanLon = Math.min(360, spanLat * aspect);

    // Fraction of the canvas the anchor sits at, preserved across the zoom.
    const fx = this.#width === 0 ? 0.5 : x / this.#width;
    const fy = this.#height === 0 ? 0.5 : y / this.#height;

    this.setView({
      west: anchor.lon - spanLon * fx,
      east: anchor.lon + spanLon * (1 - fx),
      north: anchor.lat + spanLat * fy,
      south: anchor.lat - spanLat * (1 - fy),
    });
  }

  /** Pan by a screen-pixel delta. */
  panByPixels(dx: number, dy: number): void {
    const view = this.#view;
    const dLon = (dx / (this.#width || 1)) * this.spanLon;
    const dLat = (dy / (this.#height || 1)) * this.spanLat;
    this.setView({
      west: view.west - dLon,
      east: view.east - dLon,
      north: view.north + dLat,
      south: view.south + dLat,
    });
  }

  /**
   * Turn on wheel-zoom and drag-pan. Off by default: feeds that show the whole
   * world and nothing else (seismicity, lightning at world scale) should not
   * acquire a gesture nobody asked for, and their canvases stay exactly as they
   * were.
   */
  enableNavigation(onViewChange: () => void): void {
    if (this.#navEnabled) return;
    this.#navEnabled = true;
    this.#onViewChange = onViewChange;
    this.canvas.classList.add('worldmap--navigable');

    this.#onWheel = (event: WheelEvent): void => {
      event.preventDefault();
      const rect = this.canvas.getBoundingClientRect();
      // A fixed step per notch rather than one proportional to deltaY: trackpads
      // and mice report wildly different magnitudes for "one scroll".
      const factor = event.deltaY < 0 ? 1.3 : 1 / 1.3;
      this.zoomAt(event.clientX - rect.left, event.clientY - rect.top, factor);
      this.#onRedraw?.();
      this.#onViewChange?.();
    };

    this.#onPointerDown = (event: PointerEvent): void => {
      if (event.button !== 0) return;
      this.#dragging = { x: event.clientX, y: event.clientY, moved: false };
      this.canvas.setPointerCapture(event.pointerId);
    };

    this.#onPointerMove = (event: PointerEvent): void => {
      const drag = this.#dragging;
      if (drag === null) return;
      const dx = event.clientX - drag.x;
      const dy = event.clientY - drag.y;
      if (dx === 0 && dy === 0) return;
      drag.moved = true;
      drag.x = event.clientX;
      drag.y = event.clientY;
      this.panByPixels(dx, dy);
      this.#onRedraw?.();
    };

    this.#onPointerUp = (event: PointerEvent): void => {
      const drag = this.#dragging;
      this.#dragging = null;
      if (this.canvas.hasPointerCapture(event.pointerId)) {
        this.canvas.releasePointerCapture(event.pointerId);
      }
      // Only refetch when the view actually changed. A click that did not drag
      // must not spend a request.
      if (drag?.moved === true) this.#onViewChange?.();
    };

    this.canvas.addEventListener('wheel', this.#onWheel, { passive: false });
    this.canvas.addEventListener('pointerdown', this.#onPointerDown);
    this.canvas.addEventListener('pointermove', this.#onPointerMove);
    this.canvas.addEventListener('pointerup', this.#onPointerUp);
    this.canvas.addEventListener('pointercancel', this.#onPointerUp);
  }

  /** True while a drag is in progress, so hover readouts can stand down. */
  get isDragging(): boolean {
    return this.#dragging !== null;
  }

  /** Cursor position in map coordinates, or null if outside the canvas. */
  pointerToCoords(event: PointerEvent | MouseEvent): MapPoint | null {
    const rect = this.canvas.getBoundingClientRect();
    const x = event.clientX - rect.left;
    const y = event.clientY - rect.top;
    if (x < 0 || y < 0 || x > rect.width || y > rect.height) return null;
    return this.unproject(x, y);
  }

  clear(background = '#0d1116'): void {
    this.#ctx.fillStyle = background;
    this.#ctx.fillRect(0, 0, this.#width, this.#height);
  }

  /**
   * Whether a coastline is being drawn at the current zoom, and if not, why.
   * The caller shows this: an empty map with no explanation reads as broken
   * data rather than as a deliberately withheld basemap.
   */
  get coastlineNote(): string | null {
    if (this.spanLat >= NO_COASTLINE_BELOW_SPAN) return null;
    return 'Coastline hidden below this zoom: the bundled outline is 1:50 million and would be wrong at this scale.';
  }

  /** Draw the coastline. Call after `clear` and before any overlay. */
  drawLand({ fill = '#161c23', stroke = '#28313b' } = {}): void {
    // Past a certain zoom the bundled outline is simply not accurate enough to
    // put on screen. Drawing it anyway would invent a shoreline.
    if (this.spanLat < NO_COASTLINE_BELOW_SPAN) return;

    const source = this.spanLat < DETAIL_COASTLINE_BELOW_SPAN && detailLand !== null ? detailLand : land;
    const ctx = this.#ctx;
    ctx.save();
    // Clip to the canvas: at high zoom most of the world's geometry lies far
    // outside it, and unclipped fills of enormous off-screen polygons are what
    // makes a canvas map stutter.
    ctx.beginPath();
    ctx.rect(0, 0, this.#width, this.#height);
    ctx.clip();
    ctx.beginPath();
    for (const f of source.features) {
      const geometry = f.geometry;
      const polygons: GeoJSON.Position[][][] =
        geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.coordinates;
      for (const polygon of polygons) {
        for (const ring of polygon) {
          ring.forEach((position, index) => {
            const lon = position[0];
            const lat = position[1];
            if (lon === undefined || lat === undefined) return;
            const { x, y } = this.project({ lon, lat });
            if (index === 0) ctx.moveTo(x, y);
            else ctx.lineTo(x, y);
          });
          ctx.closePath();
        }
      }
    }
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = 0.5;
    ctx.stroke();
    ctx.restore();
  }

  /**
   * Graticule at a spacing that suits the current zoom — an instrument grid
   * rather than decoration, so it has to stay readable at every scale. A fixed
   * 30° spacing is invisible when the view is two degrees across.
   */
  drawGraticule(color = '#1b222a'): void {
    const step = graticuleStep(this.spanLat);
    const view = this.#view;
    const ctx = this.#ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.beginPath();

    const firstLon = Math.ceil(view.west / step) * step;
    for (let lon = firstLon; lon <= view.east; lon += step) {
      const { x } = this.project({ lon, lat: 0 });
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.#height);
    }
    const firstLat = Math.ceil(view.south / step) * step;
    for (let lat = firstLat; lat <= view.north; lat += step) {
      const { y } = this.project({ lon: view.west, lat });
      ctx.moveTo(0, y);
      ctx.lineTo(this.#width, y);
    }
    ctx.stroke();
  }

  get ctx(): CanvasRenderingContext2D {
    return this.#ctx;
  }

  destroy(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#onRedraw = null;
    this.#onViewChange = null;
    if (this.#onWheel) this.canvas.removeEventListener('wheel', this.#onWheel);
    if (this.#onPointerDown) this.canvas.removeEventListener('pointerdown', this.#onPointerDown);
    if (this.#onPointerMove) this.canvas.removeEventListener('pointermove', this.#onPointerMove);
    if (this.#onPointerUp) {
      this.canvas.removeEventListener('pointerup', this.#onPointerUp);
      this.canvas.removeEventListener('pointercancel', this.#onPointerUp);
    }
    this.#onWheel = null;
    this.#onPointerDown = null;
    this.#onPointerMove = null;
    this.#onPointerUp = null;
    this.canvas.remove();
  }
}

/** Roughly ten gridlines down the view, snapped to a value people read easily. */
function graticuleStep(spanLat: number): number {
  const target = spanLat / 6;
  const candidates = [0.05, 0.1, 0.25, 0.5, 1, 2, 5, 10, 15, 30, 45];
  for (const candidate of candidates) {
    if (candidate >= target) return candidate;
  }
  return 30;
}
