import { ProxyModule, type ProxyEnvelope } from '../core/proxy-module.js';
import { register } from './registry.js';
import { WorldMap } from '../ui/world-map.js';
import { el, formatAge } from '../ui/dom.js';

/**
 * Aircraft over central Europe, as volunteer ADS-B receivers hear them. The
 * second Lane B feed.
 *
 * Lane B for two verified reasons: `api.adsb.lol` sends no CORS header, and its
 * anonymous quota is 500 requests a day per IP, which a public page polling
 * directly would exhaust. The Worker fetches one bounded query (a 250 nm circle
 * around 50°N 8°E, the largest radius the API takes) every 15 minutes and
 * everyone reads that copy.
 *
 * WHAT IS DRAWN, AND WHAT IS REFUSED. One dot per aircraft at the last position
 * the source reported, with a short tick along its track. No dead reckoning:
 * between refreshes the dots do not move, and they are not nudged forward to
 * look live. The snapshot is up to a quarter hour old plus its own position age
 * and the summary says so. Coverage is the circle, and inside it only where
 * receivers hear aircraft; an empty patch is "no receiver", not "no planes".
 * Aircraft with no position are not drawn.
 *
 * Data: adsb.lol, licensed ODbL 1.0 (attribution shown on the card).
 */

/** The query's own area, so the view matches what the Worker actually asks for. */
const VIEW = { west: -8, east: 24, south: 43, north: 57 };
const POLL_MS = 60_000;

interface Aircraft {
  hex: string;
  callsign: string | null;
  lat: number;
  lon: number;
  altFt: number | null;
  onGround: boolean;
  trackDeg: number | null;
  posAgeS: number | null;
}

interface AdsbPayload {
  aircraft: Aircraft[];
  totalInReply?: number;
}

/** Colour by altitude band; ground traffic and unknown altitude are distinct. */
export function altitudeColour(aircraft: Pick<Aircraft, 'altFt' | 'onGround'>): string {
  if (aircraft.onGround) return '120, 130, 140';
  const alt = aircraft.altFt;
  if (alt === null) return '170, 170, 170';
  if (alt < 10_000) return '255, 190, 90';
  if (alt < 25_000) return '120, 220, 160';
  return '120, 200, 255';
}

function asAircraft(value: unknown): Aircraft | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.hex !== 'string' || typeof v.lat !== 'number' || typeof v.lon !== 'number') return null;
  return {
    hex: v.hex,
    callsign: typeof v.callsign === 'string' ? v.callsign : null,
    lat: v.lat,
    lon: v.lon,
    altFt: typeof v.altFt === 'number' ? v.altFt : null,
    onGround: v.onGround === true,
    trackDeg: typeof v.trackDeg === 'number' ? v.trackDeg : null,
    posAgeS: typeof v.posAgeS === 'number' ? v.posAgeS : null,
  };
}

class AdsbLolAircraft extends ProxyModule<AdsbPayload> {
  #aircraft: Aircraft[] = [];
  #map: WorldMap | null = null;
  #summary: HTMLElement | null = null;
  #cacheLine: HTMLElement | null = null;

  constructor() {
    super({
      id: 'adsb-lol-aircraft',
      section: 'earth',
      title: 'Aircraft over central Europe',
      oneLiner: 'Every aircraft adsb.lol’s volunteer receivers heard within 250 nautical miles of 50°N 8°E, at its last reported position.',
      why: 'Aircraft broadcast their identity, position and speed in the open (ADS-B), and hobbyists with a small radio receiver pass it on. Together they draw the air corridors of the busiest sky on Earth, from a signal nobody designed for the public.',
      transport: 'proxy-poll',
      lane: 'B',
      // Not "live": a Worker fetch every quarter hour, plus each aircraft's
      // own position age. Calling that live would be the lie this lane invites.
      latencyClass: 'delayed',
      cadence: 'every 15 min',
      staleAfterMs: 45 * 60_000,
      historyNote:
        'No history: each refresh replaces the snapshot. One circle of 250 nautical miles around 50°N 8°E, not the whole world; aircraft with no reported position are not drawn.',
      pollMs: POLL_MS,
      source: {
        name: 'adsb.lol — open ADS-B API',
        url: 'https://www.adsb.lol/docs/open-data/api',
        license: 'ODbL 1.0',
        attribution: 'Aircraft data: adsb.lol, ODbL 1.0',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    const mapBox = el('div', { class: 'mapbox' });
    this.#cacheLine = el('p', { class: 'module__latency' }, '');
    this.#summary = el('p', { class: 'module__summary' }, 'connecting…');
    const attribution = el(
      'p',
      { class: 'module__summary' },
      'Aircraft data: ',
      el('a', { href: 'https://www.adsb.lol/', rel: 'noopener noreferrer', target: '_blank' }, 'adsb.lol'),
      ', ',
      el('a', { href: 'https://opendatacommons.org/licenses/odbl/1-0/', rel: 'noopener noreferrer', target: '_blank' }, 'ODbL 1.0'),
      ' · colour: amber below 10,000 ft, green to 25,000 ft, blue above, grey on the ground',
    );
    el_.append(mapBox, this.#cacheLine, this.#summary, attribution);
    this.#map = new WorldMap(mapBox);
    this.#map.onRedraw(() => this.#draw());
    this.#map.setView(VIEW);
    this.#draw();
  }

  unmount(): void {
    this.#map?.destroy();
    this.#map = null;
  }

  protected onPayload(data: AdsbPayload, _envelope: ProxyEnvelope<AdsbPayload>): void {
    const list = Array.isArray(data.aircraft) ? data.aircraft : [];
    this.#aircraft = list.map(asAircraft).filter((a): a is Aircraft => a !== null);
    this.#draw();
  }

  protected onPolled(): void {
    // Repaint so the cache age keeps climbing even when nothing new arrived.
    this.#draw();
  }

  #draw(): void {
    const map = this.#map;
    if (map === null) return;
    map.clear();
    map.drawGraticule();
    map.drawLand();

    const ctx = map.ctx;
    for (const a of this.#aircraft) {
      const { x, y } = map.project(a);
      if (x < -10 || y < -10 || x > map.width + 10 || y > map.height + 10) continue;
      const colour = altitudeColour(a);
      if (a.trackDeg !== null && !a.onGround) {
        const rad = (a.trackDeg * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.sin(rad) * 7, y - Math.cos(rad) * 7);
        ctx.strokeStyle = `rgba(${colour}, 0.7)`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(${colour}, 0.95)`;
      ctx.fill();
    }

    if (this.#cacheLine !== null) {
      const now = Date.now();
      const sourceAge =
        this.lastSourceTimestamp === null
          ? 'adsb.lol reported no snapshot time'
          : `snapshot taken by adsb.lol ${formatAge(now - this.lastSourceTimestamp)} ago`;
      this.#cacheLine.textContent = `${sourceAge} · ${this.cacheLabel()}`;
    }

    if (this.#summary !== null) {
      const airborne = this.#aircraft.filter((a) => !a.onGround).length;
      this.#summary.textContent =
        `${this.#aircraft.length} aircraft with a position (${airborne} airborne) · ` +
        'positions are not moved between refreshes · drawn only where a receiver hears them';
    }
  }
}

register(new AdsbLolAircraft());
