import { BaseModule } from '../core/base-module.js';
import { RingBuffer } from '../core/ring-buffer.js';
import { register } from './registry.js';
import { WorldMap } from '../ui/world-map.js';
import { el, formatAge } from '../ui/dom.js';

/**
 * Lightning, as it is detected. The first Lane C feed.
 *
 * Blitzortung is a network of volunteers running radio detectors in their
 * homes. When several stations hear the same discharge, the arrival-time
 * differences fix its position — the same principle as GPS, run backwards, by
 * hobbyists, for free. Watching it is watching a distributed instrument the
 * size of a planet doing its work.
 *
 * LANE C, AND WHY THE BROWSER DOES NOT CONNECT DIRECTLY. The project asks that
 * applications serve their own users from their own servers rather than
 * pointing every visitor at theirs, and that is worth honouring on its own
 * terms. Our Worker holds ONE upstream connection and fans it out, so a
 * thousand people watching costs the network exactly one stream.
 *
 * WHAT IS DRAWN, AND WHAT IS REFUSED. Each strike is one dot at the position
 * the network computed, and it never moves — a lightning strike is an event,
 * not a track. Dots fade with age, which is staleness made visible.
 *
 * The tempting thing here is a heat map: bin the strikes, smooth the bins, and
 * paint a beautiful glowing storm. That is interpolation, and every warm pixel
 * between two strikes would assert activity nobody detected. So the dots stay
 * dots. Where a storm is real, hundreds of them pile up and it is obvious
 * without any help.
 *
 * NO HISTORY. The stream carries what is happening now and has no backfill
 * endpoint, so this opens empty and says so. The first minute of a quiet night
 * genuinely looks like nothing, because it is nothing.
 */

const RELAY_URL = '/ws/lightning-strikes';
/** Strikes kept for the map. Bounded, and old ones drop out whole. */
const CAPACITY = 4000;
/** How long a strike stays on the map. */
const FADE_MS = 30 * 60_000;
/** Repaint at most this often; strikes can arrive faster than any screen. */
const REPAINT_MS = 400;

interface Strike {
  lat: number;
  lon: number;
  /** The network's own detection time, in ms. Null when it was unreadable. */
  timeMs: number | null;
  stations: number | null;
  /** Our arrival time — used only for fading, never displayed as the strike's time. */
  arrivedAt: number;
}

interface RelayFrame {
  type?: unknown;
  lat?: unknown;
  lon?: unknown;
  timeMs?: unknown;
  stations?: unknown;
  upstream?: unknown;
  reason?: unknown;
}

class LightningStrikes extends BaseModule {
  #strikes = new RingBuffer<Strike>(CAPACITY);
  #socket: WebSocket | null = null;
  #map: WorldMap | null = null;
  #summary: HTMLElement | null = null;
  #status: HTMLElement | null = null;
  #repaintTimer: ReturnType<typeof setInterval> | null = null;
  #dirty = false;

  /** Arrival times, so the rate shown is measured rather than assumed. */
  #arrivals = new RingBuffer<number>(600);
  #upstreamState = 'connecting';
  #upstreamReason: string | null = null;
  #unreadableTimes = 0;

  constructor() {
    super({
      id: 'lightning-strikes',
      section: 'earth',
      title: 'Lightning, as it is detected',
      oneLiner: 'Every discharge the Blitzortung volunteer network locates, the moment it is fixed.',
      why: 'Several thousand people run radio detectors in their homes, and the differences in when each one hears a discharge fix its position to within a few kilometres — GPS run backwards, by hobbyists, given away for free. On an active night the storms draw themselves.',
      transport: 'relay',
      lane: 'C',
      latencyClass: 'live',
      cadence: 'continuous, bursty',
      // Lightning genuinely stops. A quiet planet is a real observation, so the
      // window before this is called stale is generous — but not infinite,
      // because a dead socket must not be indistinguishable from a calm night.
      staleAfterMs: 10 * 60_000,
      historyNote:
        'No history: the network publishes no backfill, so this opens empty and fills from the moment you arrive. A quiet first minute is a quiet first minute.',
      source: {
        name: 'Blitzortung.org',
        url: 'https://www.blitzortung.org/',
        license: 'Free for non-commercial use, with attribution',
        attribution: 'Blitzortung.org and its volunteer station operators',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    const mapBox = el('div', { class: 'mapbox' });
    this.#status = el('p', { class: 'module__latency' }, 'connecting to the relay…');
    this.#summary = el('p', { class: 'module__summary' }, '');
    el_.append(mapBox, this.#status, this.#summary);
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
    this.#socket.addEventListener('close', () => {
      // Our own relay closing is a different thing from the source going quiet,
      // and the message says which.
      this.fail('the connection to our relay closed');
    });
    this.#socket.addEventListener('error', () => {
      this.fail('the connection to our relay failed');
    });

    this.#repaintTimer = setInterval(() => {
      // Repaint on a timer whether or not strikes arrived: the dots fade with
      // age, so the picture is wrong the moment it stops being redrawn.
      if (this.#dirty || this.#strikes.size > 0) {
        this.#dirty = false;
        this.#draw();
      }
    }, REPAINT_MS);
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

  #onMessage(event: MessageEvent): void {
    let frame: RelayFrame;
    try {
      frame = JSON.parse(event.data as string) as RelayFrame;
    } catch {
      return;
    }

    if (frame.type === 'status') {
      // The relay reports the state of the UPSTREAM connection, which our own
      // socket being open says nothing about. Without this, a healthy
      // connection to a relay that cannot reach Blitzortung would look like a
      // quiet night.
      this.#upstreamState = typeof frame.upstream === 'string' ? frame.upstream : 'unknown';
      this.#upstreamReason = typeof frame.reason === 'string' ? frame.reason : null;
      if (this.#upstreamState === 'error') {
        this.fail(this.#upstreamReason ?? 'the relay cannot reach Blitzortung', { retry: false });
      }
      this.#dirty = true;
      return;
    }

    if (frame.type !== 'strike') return;
    const lat = frame.lat;
    const lon = frame.lon;
    if (typeof lat !== 'number' || typeof lon !== 'number') return;

    const timeMs = typeof frame.timeMs === 'number' ? frame.timeMs : null;
    // The relay range-checks the nanosecond conversion and sends null when it
    // fails. Counting those is how a units problem would become visible here
    // rather than silently showing every strike as ancient.
    if (timeMs === null) this.#unreadableTimes += 1;

    this.#strikes.push({
      lat,
      lon,
      timeMs,
      stations: typeof frame.stations === 'number' ? frame.stations : null,
      arrivedAt: Date.now(),
    });
    this.#arrivals.push(Date.now());
    // The network's own detection time, never our arrival time.
    this.markReceived(timeMs);
    this.#dirty = true;
  }

  #ratePerMinute(): number {
    const arrivals = [...this.#arrivals];
    if (arrivals.length < 2) return 0;
    const first = arrivals[0];
    const last = arrivals.at(-1);
    if (first === undefined || last === undefined || last === first) return 0;
    return (arrivals.length / (last - first)) * 60_000;
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

    for (const strike of this.#strikes) {
      const age = now - strike.arrivedAt;
      if (age > FADE_MS) continue;
      visible += 1;
      const { x, y } = map.project(strike);
      // Fading is age made visible, not decoration. A strike from 25 minutes
      // ago should not look like one from 25 seconds ago.
      const alpha = Math.max(0.06, 1 - age / FADE_MS);
      // Recent strikes get a brief halo so a live arrival is noticeable on a
      // map that is otherwise still. It encodes recency, nothing else.
      if (age < 4000) {
        ctx.beginPath();
        ctx.arc(x, y, 5, 0, Math.PI * 2);
        ctx.fillStyle = `rgba(255, 244, 180, ${0.28 * (1 - age / 4000)})`;
        ctx.fill();
      }
      ctx.beginPath();
      ctx.arc(x, y, 1.6, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255, 236, 150, ${alpha})`;
      ctx.fill();
    }

    if (this.#status !== null) {
      const upstream =
        this.#upstreamState === 'open'
          ? 'relay connected to Blitzortung'
          : this.#upstreamState === 'connecting'
            ? 'relay connecting to Blitzortung…'
            : this.#upstreamState === 'idle'
              ? 'relay idle'
              : `relay cannot reach Blitzortung${this.#upstreamReason === null ? '' : `: ${this.#upstreamReason}`}`;
      // One shared upstream stream is the whole point of the lane, so it is
      // stated rather than left as an implementation detail.
      this.#status.textContent = `${upstream} · one upstream stream shared by every viewer`;
    }

    if (this.#summary !== null) {
      const rate = this.#ratePerMinute();
      const parts = [
        `${visible} strikes on the map (last 30 min)`,
        `${this.messageCount} received since you opened this page`,
        rate > 0 ? `${Math.round(rate)}/min observed` : 'measuring rate',
      ];
      const newest = this.lastSourceTimestamp;
      if (newest !== null) parts.push(`newest fixed ${formatAge(now - newest)} ago`);
      if (this.#unreadableTimes > 0) {
        // Surfaced rather than swallowed: if this number climbs, the timestamp
        // conversion is wrong and the page should say so before anyone trusts
        // the ages on it.
        parts.push(`${this.#unreadableTimes} with an unreadable timestamp`);
      }
      this.#summary.textContent = parts.join(' · ');
    }
  }
}

register(new LightningStrikes());
