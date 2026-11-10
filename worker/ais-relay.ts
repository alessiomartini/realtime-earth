/**
 * Lane C — the AIS Durable Object relay.
 *
 * WHY A RELAY. AIS Stream's documentation forbids connecting from a browser
 * (the API key would be exposed) and allows only 3 connections per account.
 * Both rules point at the same design as the lightning relay: ONE Durable
 * Object holds ONE upstream WebSocket, and every visitor talks to it instead.
 *
 * WHAT IT KEEPS. The latest position of each vessel, keyed by MMSI, in memory
 * only. The set is bounded two ways: a TTL (a vessel not heard from for a while
 * is dropped rather than drawn where it no longer is) and a cap (the oldest
 * entries go first when the set is full). Nothing is persisted.
 *
 * NO KEY, NO BREAK. The key is the Worker secret `AISSTREAM_API_KEY`. When it
 * is missing the relay opens no upstream connection and says so, in a status
 * frame over the WebSocket and in the JSON snapshot (`enabled: false`).
 *
 * NOBODY WATCHING, NOBODY CONNECTED. As with lightning, the upstream socket is
 * opened by the first viewer and closed when the last leaves. The vessel set
 * survives (it expires by TTL), so a returning viewer sees recent positions.
 */

const UPSTREAM = 'https://stream.aisstream.io/v0/stream';

/** Latest positions kept. Oldest-heard vessels are evicted first. */
export const VESSEL_CAP = 3000;
/** A vessel not heard from for this long is no longer shown. */
export const VESSEL_TTL_MS = 15 * 60_000;
/** Updates are batched and sent to viewers this often. */
const FLUSH_MS = 3_000;
const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 60_000;

export interface AisEnv {
  AIS_RELAY: DurableObjectNamespace;
  /** Worker secret. Optional: without it the relay is disabled, not broken. */
  AISSTREAM_API_KEY?: string;
}

export interface Vessel {
  mmsi: number;
  lat: number;
  lon: number;
  /** Speed over ground in knots, null when not available. */
  sogKn: number | null;
  /** Course over ground in degrees, null when not available. */
  cogDeg: number | null;
  /** True heading in degrees, null when not available. */
  headingDeg: number | null;
  name: string | null;
  /** When this relay last heard the vessel (ms). */
  seenAt: number;
}

interface RawPositionReport {
  MessageType?: unknown;
  MetaData?: { ShipName?: unknown; MMSI?: unknown };
  Message?: {
    PositionReport?: {
      UserID?: unknown;
      Latitude?: unknown;
      Longitude?: unknown;
      Sog?: unknown;
      Cog?: unknown;
      TrueHeading?: unknown;
    };
  };
}

function finite(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * Parse one upstream message. Returns null for anything that is not a usable
 * PositionReport, so nothing half-read reaches a viewer.
 *
 * AIS encodes "not available" with in-band sentinels: latitude 91, longitude
 * 181, speed 102.3 kn, course 360, heading 511. A vessel at lat 91 would be
 * drawn off the map at best, so those positions are dropped, and the other
 * sentinels become null rather than a fake speed or heading.
 */
export function parsePositionReport(text: string, now = Date.now()): Vessel | null {
  let raw: RawPositionReport;
  try {
    raw = JSON.parse(text) as RawPositionReport;
  } catch {
    return null;
  }
  if (raw === null || typeof raw !== 'object') return null;
  if (raw.MessageType !== 'PositionReport') return null;
  const report = raw.Message?.PositionReport;
  if (report === undefined || report === null) return null;

  const mmsi = finite(report.UserID) ?? finite(raw.MetaData?.MMSI);
  const lat = finite(report.Latitude);
  const lon = finite(report.Longitude);
  if (mmsi === null || !Number.isInteger(mmsi) || mmsi <= 0) return null;
  if (lat === null || lon === null) return null;
  // Out of range also covers the "not available" sentinels 91 and 181.
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  const sog = finite(report.Sog);
  const cog = finite(report.Cog);
  const heading = finite(report.TrueHeading);
  const rawName = raw.MetaData?.ShipName;
  const name = typeof rawName === 'string' && rawName.trim() !== '' ? rawName.trim() : null;

  return {
    mmsi,
    lat,
    lon,
    sogKn: sog !== null && sog >= 0 && sog < 102.3 ? sog : null,
    cogDeg: cog !== null && cog >= 0 && cog < 360 ? cog : null,
    headingDeg: heading !== null && heading >= 0 && heading < 360 ? heading : null,
    name,
    seenAt: now,
  };
}

/** The bounded set of latest positions. Pure, so it can be tested directly. */
export class VesselStore {
  #vessels = new Map<number, Vessel>();
  readonly #cap: number;
  readonly #ttlMs: number;

  constructor(cap = VESSEL_CAP, ttlMs = VESSEL_TTL_MS) {
    this.#cap = cap;
    this.#ttlMs = ttlMs;
  }

  get size(): number {
    return this.#vessels.size;
  }

  upsert(vessel: Vessel): void {
    const previous = this.#vessels.get(vessel.mmsi);
    // A message without a name keeps the name an earlier one carried.
    const merged = previous !== undefined && vessel.name === null ? { ...vessel, name: previous.name } : vessel;
    // Delete before set so Map order is least-recently-heard first, which is
    // what cap eviction relies on.
    this.#vessels.delete(vessel.mmsi);
    this.#vessels.set(vessel.mmsi, merged);
    while (this.#vessels.size > this.#cap) {
      const oldest = this.#vessels.keys().next();
      if (oldest.done === true) break;
      this.#vessels.delete(oldest.value);
    }
  }

  /** Drop vessels not heard from within the TTL. Returns how many went. */
  prune(now = Date.now()): number {
    let dropped = 0;
    for (const [mmsi, vessel] of this.#vessels) {
      // Map order is by last heard, so the first fresh entry ends the scan.
      if (now - vessel.seenAt <= this.#ttlMs) break;
      this.#vessels.delete(mmsi);
      dropped += 1;
    }
    return dropped;
  }

  snapshot(now = Date.now()): Vessel[] {
    this.prune(now);
    return [...this.#vessels.values()];
  }
}

/** The subscription message. The key is read from the secret, never a literal. */
export function subscriptionMessage(apiKey: string): string {
  return JSON.stringify({
    APIKey: apiKey,
    BoundingBoxes: [
      [
        [-90, -180],
        [90, 180],
      ],
    ],
    FilterMessageTypes: ['PositionReport'],
  });
}

type UpstreamState = 'idle' | 'connecting' | 'open' | 'error' | 'disabled';

const SOURCE = 'aisstream.io';

export class AisRelay {
  #clients = new Set<WebSocket>();
  #upstream: WebSocket | null = null;
  #state: UpstreamState = 'idle';
  #reason: string | null = null;
  #retryMs = RETRY_MIN_MS;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  #store = new VesselStore();
  #pending = new Map<number, Vessel>();
  #relayed = 0;
  #apiKey: string | undefined;

  constructor(_state: DurableObjectState, env: { AISSTREAM_API_KEY?: string }) {
    const key = env.AISSTREAM_API_KEY;
    this.#apiKey = typeof key === 'string' && key.trim() !== '' ? key.trim() : undefined;
    if (this.#apiKey === undefined) {
      this.#state = 'disabled';
      this.#reason = 'AISSTREAM_API_KEY is not configured on this deployment.';
    }
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      // A plain GET gets the current snapshot. Never an error when disabled:
      // an empty, clearly labelled answer is the honest one.
      return new Response(
        JSON.stringify({
          ok: true,
          enabled: this.#apiKey !== undefined,
          upstream: this.#state,
          reason: this.#reason,
          source: SOURCE,
          vessels: this.#store.snapshot(),
        }),
        { headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.#clients.add(server);
    server.addEventListener('close', () => this.#dropClient(server));
    server.addEventListener('error', () => this.#dropClient(server));

    this.#send(server, this.#statusFrame());
    this.#send(server, JSON.stringify({ type: 'snapshot', vessels: this.#store.snapshot() }));
    this.#ensureUpstream();

    return new Response(null, { status: 101, webSocket: client });
  }

  #statusFrame(): string {
    return JSON.stringify({
      type: 'status',
      upstream: this.#state,
      reason: this.#reason,
      relayed: this.#relayed,
      tracked: this.#store.size,
      viewers: this.#clients.size,
      source: SOURCE,
    });
  }

  #send(socket: WebSocket, data: string): void {
    try {
      socket.send(data);
    } catch {
      this.#dropClient(socket);
    }
  }

  #broadcast(data: string): void {
    for (const socket of [...this.#clients]) this.#send(socket, data);
  }

  #dropClient(socket: WebSocket): void {
    if (!this.#clients.delete(socket)) return;
    try {
      socket.close();
    } catch {
      /* already gone */
    }
    if (this.#clients.size === 0) this.#closeUpstream('no viewers');
  }

  #flush(): void {
    this.#store.prune();
    if (this.#pending.size > 0) {
      const vessels = [...this.#pending.values()];
      this.#pending.clear();
      this.#broadcast(JSON.stringify({ type: 'update', vessels }));
    }
    this.#broadcast(this.#statusFrame());
  }

  #ensureUpstream(): void {
    if (this.#apiKey === undefined) return;
    if (this.#upstream !== null || this.#state === 'connecting') return;
    if (this.#clients.size === 0) return;
    this.#state = 'connecting';
    this.#reason = null;
    this.#broadcast(this.#statusFrame());
    void this.#connect(this.#apiKey);
  }

  async #connect(apiKey: string): Promise<void> {
    try {
      const response = await fetch(UPSTREAM, { headers: { Upgrade: 'websocket' } });
      const socket = response.webSocket;
      if (socket === null || socket === undefined) {
        this.#failUpstream(`AIS Stream did not accept the upgrade (HTTP ${response.status}).`);
        return;
      }
      socket.accept();
      if (this.#clients.size === 0) {
        try {
          socket.close();
        } catch {
          /* nothing to clean up */
        }
        this.#state = 'idle';
        return;
      }
      socket.send(subscriptionMessage(apiKey));
      this.#upstream = socket;
      this.#state = 'open';
      this.#reason = null;
      this.#retryMs = RETRY_MIN_MS;
      this.#broadcast(this.#statusFrame());
      if (this.#flushTimer === null) this.#flushTimer = setInterval(() => this.#flush(), FLUSH_MS);

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const vessel = parsePositionReport(event.data);
        if (vessel === null) {
          // AIS Stream reports a bad key as an {"error": ...} frame.
          if (event.data.includes('"error"')) this.#failUpstream('AIS Stream rejected the subscription.');
          return;
        }
        this.#relayed += 1;
        this.#store.upsert(vessel);
        this.#pending.set(vessel.mmsi, vessel);
      });
      socket.addEventListener('close', () => this.#failUpstream('The upstream stream closed.'));
      socket.addEventListener('error', () => this.#failUpstream('The upstream stream reported an error.'));
    } catch (error) {
      this.#failUpstream(
        error instanceof Error ? `Could not reach AIS Stream: ${error.message}` : 'Could not reach AIS Stream.',
      );
    }
  }

  #failUpstream(reason: string): void {
    const socket = this.#upstream;
    this.#upstream = null;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
    this.#state = 'error';
    this.#reason = reason;
    this.#broadcast(this.#statusFrame());
    this.#scheduleRetry();
  }

  #closeUpstream(reason: string): void {
    if (this.#retryTimer !== null) {
      clearTimeout(this.#retryTimer);
      this.#retryTimer = null;
    }
    if (this.#flushTimer !== null) {
      clearInterval(this.#flushTimer);
      this.#flushTimer = null;
    }
    this.#pending.clear();
    const socket = this.#upstream;
    this.#upstream = null;
    if (this.#apiKey !== undefined) this.#state = 'idle';
    this.#reason = reason;
    if (socket !== null) {
      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  }

  #scheduleRetry(): void {
    if (this.#retryTimer !== null) return;
    if (this.#clients.size === 0) return;
    const delay = this.#retryMs;
    this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#state = 'idle';
      this.#ensureUpstream();
    }, delay);
  }
}

/** Route `/ws/ais-vessels` to the one relay instance. */
export function handleAisSocket(request: Request, env: AisEnv): Promise<Response> {
  // A fixed name: every visitor reaches the same object, hence one upstream
  // connection (the account allows three, and the docs forbid browsers).
  const id = env.AIS_RELAY.idFromName('aisstream');
  return env.AIS_RELAY.get(id).fetch(request);
}
