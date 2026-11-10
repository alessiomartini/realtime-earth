import { BaseModule } from '../core/base-module.js';
import { register } from './registry.js';
import { WorldMap } from '../ui/world-map.js';
import { el, formatAge } from '../ui/dom.js';

/**
 * Ships, as they report themselves. The second Lane C feed.
 *
 * Every large vessel broadcasts its position over AIS, and volunteer and
 * commercial receivers along the coasts relay those messages to aisstream.io.
 * Each dot is the last position a ship reported, nothing more.
 *
 * LANE C. AIS Stream forbids connecting from a browser and allows three
 * connections per account, so our Worker holds ONE upstream connection in a
 * Durable Object and fans it out. The relay keeps a bounded, TTL-limited set of
 * latest positions and sends it to a new viewer at once.
 *
 * WHAT IS DRAWN, AND WHAT IS REFUSED. A dot per vessel at its last reported
 * position, with a short tick along its true heading (or course when heading is
 * not reported). No dead reckoning: a ship is shown where it last said it was,
 * and the dot fades with the age of that report. Coverage is only where
 * receivers are, so empty open ocean is "no receiver", not "no ships"; the
 * summary says so.
 *
 * KEY-GATED. Without the AIS API key (a Worker secret) the relay reports
 * `disabled` and this module says that, instead of looking like an empty sea.
 */

const RELAY_URL = '/ws/ais-vessels';
const CAPACITY = 3000;
/** Mirrors the relay's TTL: older reports are not drawn. */
const FADE_MS = 15 * 60_000;
const REPAINT_MS = 1000;

interface Vessel {
  mmsi: number;
  lat: number;
  lon: number;
  cogDeg: number | null;
  headingDeg: number | null;
  /** Relay's time of the last report, ms. */
  seenAt: number;
}

interface RelayFrame {
  type?: unknown;
  vessels?: unknown;
  upstream?: unknown;
  reason?: unknown;
}

function asVessel(value: unknown): Vessel | null {
  if (value === null || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.mmsi !== 'number' || typeof v.lat !== 'number' || typeof v.lon !== 'number') return null;
  if (typeof v.seenAt !== 'number') return null;
  return {
    mmsi: v.mmsi,
    lat: v.lat,
    lon: v.lon,
    cogDeg: typeof v.cogDeg === 'number' ? v.cogDeg : null,
    headingDeg: typeof v.headingDeg === 'number' ? v.headingDeg : null,
    seenAt: v.seenAt,
  };
}

class AisVessels extends BaseModule {
  #vessels = new Map<number, Vessel>();
  #socket: WebSocket | null = null;
  #map: WorldMap | null = null;
  #summary: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #repaintTimer: ReturnType<typeof setInterval> | null = null;
  #upstreamState = 'connecting';
  #upstreamReason: string | null = null;

  constructor() {
    super({
      id: 'ais-vessels',
      section: 'earth',
      title: 'Ships, as they report themselves',
      oneLiner: 'The last position each vessel broadcast over AIS, as relayed by aisstream.io.',
      why: 'Ships announce who and where they are so that they do not collide. Receivers along the coasts pick those broadcasts up, and together they draw the sea lanes: the shipping lanes of the world, one dot per vessel, built from a safety system.',
      transport: 'relay',
      lane: 'C',
      latencyClass: 'live',
      cadence: 'continuous',
      staleAfterMs: 5 * 60_000,
      historyNote:
        'No history: the relay keeps only the latest position of each vessel for fifteen minutes. Open ocean is empty because no receiver hears it, not because it has no ships.',
      source: {
        name: 'AIS Stream (aisstream.io)',
        url: 'https://aisstream.io/',
        license: 'Not stated by the provider (to verify)',
        attribution: 'AIS data: aisstream.io',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    const mapBox = el('div', { class: 'mapbox' });
    this.#status = el('p', { class: 'module__latency' }, 'connecting to the relay…');
    this.#summary = el('p', { class: 'module__summary' }, '');
    const attribution = el('p', { class: 'module__summary' }, 'AIS data: aisstream.io');
    el_.append(mapBox, this.#status, this.#summary, attribution);
    this.#map = new WorldMap(mapBox);
    this.#map.onRedraw(() => this.#draw());
    this.#draw();
  }

  protected openStream(): void {
    const scheme = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    try {
      this.#socket = new WebSocket(`${scheme}//${window.location.host}${RELAY_URL}`);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'could not open the relay connection');
      return;
    }
    this.#socket.addEventListener('open', () => this.markOpen());
    this.#socket.addEventListener('message', (event) => this.#onMessage(event));
    this.#socket.addEventListener('close', () => this.fail('the connection to our relay closed'));
    this.#socket.addEventListener('error', () => this.fail('the connection to our relay failed'));
    this.#repaintTimer = setInterval(() => this.#draw(), REPAINT_MS);
  }

  protected closeStream(): void {
    if (this.#repaintTimer !== null) clearInterval(this.#repaintTimer);
    this.#repaintTimer = null;
    this.#socket?.close();
    this.#socket = null;
  }

  unmount(): void {
    this.#map?.destroy();
    this.#map = null;
  }

  #store(list: unknown): void {
    if (!Array.isArray(list)) return;
    let newest: number | null = null;
    for (const item of list) {
      const vessel = asVessel(item);
      if (vessel === null) continue;
      this.#vessels.delete(vessel.mmsi);
      this.#vessels.set(vessel.mmsi, vessel);
      if (newest === null || vessel.seenAt > newest) newest = vessel.seenAt;
    }
    while (this.#vessels.size > CAPACITY) {
      const oldest = this.#vessels.keys().next();
      if (oldest.done === true) break;
      this.#vessels.delete(oldest.value);
    }
    if (newest !== null) this.markReceived(newest);
  }

  #onMessage(event: MessageEvent): void {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(event.data as string) as RelayFrame;
    } catch {
      return;
    }
    if (frame.type === 'status') {
      this.#upstreamState = typeof frame.upstream === 'string' ? frame.upstream : 'unknown';
      this.#upstreamReason = typeof frame.reason === 'string' ? frame.reason : null;
      if (this.#upstreamState === 'disabled') {
        // Not a failure to retry: the deployment has no key.
        this.fail(this.#upstreamReason ?? 'the AIS relay is not enabled on this deployment', { retry: false });
      } else if (this.#upstreamState === 'error') {
        this.fail(this.#upstreamReason ?? 'the relay cannot reach AIS Stream', { retry: false });
      }
      this.#draw();
      return;
    }
    if (frame.type === 'snapshot' || frame.type === 'update') this.#store(frame.vessels);
  }

  #draw(): void {
    const map = this.#map;
    if (map === null) return;
    map.clear();
    map.drawGraticule();
    map.drawLand();

    const ctx = map.ctx;
    const now = Date.now();
    let visible = 0;

    for (const vessel of this.#vessels.values()) {
      const age = now - vessel.seenAt;
      if (age > FADE_MS) continue;
      visible += 1;
      const { x, y } = map.project(vessel);
      const alpha = Math.max(0.15, 1 - age / FADE_MS);
      const bearing = vessel.headingDeg ?? vessel.cogDeg;
      if (bearing !== null) {
        const rad = (bearing * Math.PI) / 180;
        ctx.beginPath();
        ctx.moveTo(x, y);
        ctx.lineTo(x + Math.sin(rad) * 6, y - Math.cos(rad) * 6);
        ctx.strokeStyle = `rgba(120, 200, 255, ${alpha * 0.7})`;
        ctx.lineWidth = 1;
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.arc(x, y, 1.8, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(120, 200, 255, ${alpha})`;
      ctx.fill();
    }

    if (this.#status !== null) {
      const upstream =
        this.#upstreamState === 'open'
          ? 'relay connected to AIS Stream'
          : this.#upstreamState === 'connecting'
            ? 'relay connecting to AIS Stream…'
            : this.#upstreamState === 'idle'
              ? 'relay idle'
              : this.#upstreamState === 'disabled'
                ? 'AIS relay disabled: no API key configured on this deployment'
                : `relay cannot reach AIS Stream${this.#upstreamReason === null ? '' : `: ${this.#upstreamReason}`}`;
      this.#status.textContent = `${upstream} · one upstream connection shared by every viewer`;
    }

    if (this.#summary !== null) {
      const parts = [
        `${visible} vessels on the map (reported in the last 15 min)`,
        'drawn only where a receiver hears them',
      ];
      const newest = this.lastSourceTimestamp;
      if (newest !== null) parts.push(`newest report ${formatAge(now - newest)} ago`);
      this.#summary.textContent = parts.join(' · ');
    }
  }
}

register(new AisVessels());
