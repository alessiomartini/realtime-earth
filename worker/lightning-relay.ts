/**
 * Lane C — the Durable Object relay, and the lightning feed that needs it.
 *
 * WHY A RELAY AT ALL. Blitzortung is a network of volunteers running detectors
 * in their homes; the data is given away and the project asks that third-party
 * applications serve their own users from their own servers rather than
 * pointing every visitor's browser at theirs. That is a request worth honouring
 * on its own terms, and it happens to be exactly what Lane C is for: ONE
 * upstream connection for the whole site, however many people are watching.
 *
 * A Durable Object rather than a plain Worker because there has to be exactly
 * one of it. A Worker is instantiated per request, so a hundred visitors would
 * be a hundred upstream connections — precisely what the relay exists to
 * prevent. A Durable Object is a single addressable instance, so all clients
 * meet at one place and share one socket.
 *
 * WHAT VERIFICATION SETTLED, and it changed the design twice. Every probe of
 * Blitzortung from a GitHub runner failed, including plain HTTPS — which is
 * exactly what GDELT did immediately before proving to work perfectly from
 * Cloudflare, so it was not treated as evidence the source was dead. Asked from
 * Cloudflare instead: port 3000 is unreachable, and port 443 answers
 * `HTTP/1.1 101 Switching Protocols`. Since a Worker's `fetch` can reach 443
 * but not 3000, the relay uses the ordinary WebSocket upgrade rather than
 * hand-rolled framing over a raw socket.
 *
 * NOBODY WATCHING, NOBODY CONNECTED. The upstream socket is opened when the
 * first client arrives and closed when the last one leaves. Holding a stream
 * open against a volunteer-run network to show nobody anything would be rude in
 * a way this project should not need explaining.
 */

const UPSTREAM = 'https://ws1.blitzortung.org/';
/** The stream is silent until subscribed to. Verified: a handshake alone gets nothing. */
const SUBSCRIBE = '{"time":0}';

const RETRY_MIN_MS = 1_000;
const RETRY_MAX_MS = 30_000;

/**
 * A strike more than a day from now is not a strike, it is a misread timestamp.
 *
 * Blitzortung reports time in NANOSECONDS since the epoch. Treating that as
 * milliseconds places every strike in 1970 and — far worse — it would look like
 * working code: markers would appear, the count would rise, and only the age
 * readout would be absurd. So the conversion is range-checked, and a value that
 * lands outside the plausible window is reported as unknown rather than drawn
 * at a time nobody recorded.
 */
const PLAUSIBLE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface RelayEnv {
  LIGHTNING_RELAY: DurableObjectNamespace;
}

interface Strike {
  type: 'strike';
  lat: number;
  lon: number;
  /** The detection time reported by the network, in ms. Null when unreadable. */
  timeMs: number | null;
  /** How many stations contributed to this fix — the network showing its work. */
  stations: number | null;
  altM: number | null;
  polarity: number | null;
}

interface RawStrike {
  time?: unknown;
  lat?: unknown;
  lon?: unknown;
  alt?: unknown;
  pol?: unknown;
  sig?: unknown;
}

/** Nanoseconds since the epoch → ms, or null if the result is not plausible. */
export function strikeTimeMs(raw: unknown, now = Date.now()): number | null {
  if (typeof raw !== 'number' || !Number.isFinite(raw)) return null;
  const ms = raw / 1e6;
  if (!Number.isFinite(ms)) return null;
  // The guard that stops a units mistake from looking like working code.
  if (Math.abs(ms - now) > PLAUSIBLE_WINDOW_MS) return null;
  return ms;
}

export function parseStrike(text: string, now = Date.now()): Strike | null {
  let raw: RawStrike;
  try {
    raw = JSON.parse(text) as RawStrike;
  } catch {
    return null;
  }
  const lat = raw.lat;
  const lon = raw.lon;
  // Without coordinates there is nothing to place, so the message is dropped
  // rather than drawn at a default position.
  if (typeof lat !== 'number' || typeof lon !== 'number') return null;
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return null;

  return {
    type: 'strike',
    lat,
    lon,
    timeMs: strikeTimeMs(raw.time, now),
    stations: Array.isArray(raw.sig) ? raw.sig.length : null,
    altM: typeof raw.alt === 'number' ? raw.alt : null,
    polarity: typeof raw.pol === 'number' ? raw.pol : null,
  };
}

type UpstreamState = 'idle' | 'connecting' | 'open' | 'error';

export class LightningRelay {
  #clients = new Set<WebSocket>();
  #upstream: WebSocket | null = null;
  #state: UpstreamState = 'idle';
  #reason: string | null = null;
  #retryMs = RETRY_MIN_MS;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  #relayed = 0;

  constructor(_state: DurableObjectState, _env: unknown) {
    /* no persisted state: this relays a live stream and stores nothing */
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'expected_websocket',
          message: 'This endpoint is a WebSocket relay. Connect with an Upgrade: websocket request.',
        }),
        { status: 426, headers: { 'content-type': 'application/json; charset=utf-8' } },
      );
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    server.accept();
    this.#clients.add(server);

    server.addEventListener('close', () => this.#dropClient(server));
    server.addEventListener('error', () => this.#dropClient(server));

    // Tell the new client where things stand immediately. A socket that opens
    // and then stays silent is indistinguishable from a broken one, and on a
    // feed where quiet periods are normal that ambiguity is unacceptable.
    this.#send(server, this.#statusFrame());
    this.#ensureUpstream();

    return new Response(null, { status: 101, webSocket: client });
  }

  #statusFrame(): string {
    return JSON.stringify({
      type: 'status',
      upstream: this.#state,
      reason: this.#reason,
      relayed: this.#relayed,
      viewers: this.#clients.size,
      source: 'Blitzortung.org',
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
    // The last viewer leaving closes the upstream connection. See the header:
    // a volunteer network should not be streaming to an empty room.
    if (this.#clients.size === 0) this.#closeUpstream('no viewers');
  }

  #ensureUpstream(): void {
    if (this.#upstream !== null || this.#state === 'connecting') return;
    if (this.#clients.size === 0) return;
    this.#state = 'connecting';
    this.#reason = null;
    this.#broadcast(this.#statusFrame());
    void this.#connect();
  }

  async #connect(): Promise<void> {
    try {
      const response = await fetch(UPSTREAM, { headers: { Upgrade: 'websocket' } });
      const socket = response.webSocket;
      if (socket === null || socket === undefined) {
        this.#failUpstream(`Blitzortung did not accept the upgrade (HTTP ${response.status}).`);
        return;
      }
      // A client can arrive and leave while the handshake is in flight. Do not
      // leave an orphaned upstream socket running for nobody.
      if (this.#clients.size === 0) {
        socket.accept();
        try {
          socket.close();
        } catch {
          /* nothing to clean up */
        }
        this.#state = 'idle';
        return;
      }

      socket.accept();
      socket.send(SUBSCRIBE);
      this.#upstream = socket;
      this.#state = 'open';
      this.#reason = null;
      this.#retryMs = RETRY_MIN_MS;
      this.#broadcast(this.#statusFrame());

      socket.addEventListener('message', (event) => {
        if (typeof event.data !== 'string') return;
        const strike = parseStrike(event.data);
        // A message we cannot read is dropped, not guessed at. Nothing
        // half-parsed reaches a client.
        if (strike === null) return;
        this.#relayed += 1;
        this.#broadcast(JSON.stringify(strike));
      });

      socket.addEventListener('close', () => this.#failUpstream('The upstream stream closed.'));
      socket.addEventListener('error', () => this.#failUpstream('The upstream stream reported an error.'));
    } catch (error) {
      this.#failUpstream(
        error instanceof Error ? `Could not reach Blitzortung: ${error.message}` : 'Could not reach Blitzortung.',
      );
    }
  }

  #failUpstream(reason: string): void {
    this.#upstream = null;
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
    const socket = this.#upstream;
    this.#upstream = null;
    this.#state = 'idle';
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
    // Exponential, capped. A source that is down should be asked less often,
    // not hammered until it comes back.
    this.#retryMs = Math.min(RETRY_MAX_MS, this.#retryMs * 2);
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      this.#state = 'idle';
      this.#ensureUpstream();
    }, delay);
  }
}

/** Route `/ws/lightning-strikes` to the one relay instance. */
export function handleLightningSocket(request: Request, env: RelayEnv): Promise<Response> {
  // A fixed name, so every visitor reaches the same object and therefore the
  // same single upstream connection. That is the whole point of the lane.
  const id = env.LIGHTNING_RELAY.idFromName('blitzortung');
  return env.LIGHTNING_RELAY.get(id).fetch(request);
}
