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

export class WorldMap {
  readonly canvas: HTMLCanvasElement;
  #ctx: CanvasRenderingContext2D;
  #width = 0;
  #height = 0;
  #dpr = 1;
  #resizeObserver: ResizeObserver | null = null;
  #onRedraw: (() => void) | null = null;

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
    this.#onRedraw?.();
  }

  project({ lon, lat }: MapPoint): { x: number; y: number } {
    return {
      x: ((lon + 180) / 360) * this.#width,
      y: ((90 - lat) / 180) * this.#height,
    };
  }

  /** Exact inverse of `project` — no search, no approximation. */
  unproject(x: number, y: number): MapPoint {
    return {
      lon: (x / this.#width) * 360 - 180,
      lat: 90 - (y / this.#height) * 180,
    };
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

  /** Draw the coastline. Call after `clear` and before any overlay. */
  drawLand({ fill = '#161c23', stroke = '#28313b' } = {}): void {
    const ctx = this.#ctx;
    ctx.beginPath();
    for (const f of land.features) {
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
  }

  /** Graticule every 30°, as an instrument grid rather than decoration. */
  drawGraticule(color = '#1b222a'): void {
    const ctx = this.#ctx;
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.5;
    ctx.beginPath();
    for (let lon = -180; lon <= 180; lon += 30) {
      const { x } = this.project({ lon, lat: 0 });
      ctx.moveTo(x, 0);
      ctx.lineTo(x, this.#height);
    }
    for (let lat = -60; lat <= 60; lat += 30) {
      const { y } = this.project({ lon: 0, lat });
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
    this.canvas.remove();
  }
}
