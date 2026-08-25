/**
 * Lane B — the Worker proxy.
 *
 * Some sources cannot be read by a browser at all: they send no CORS header,
 * or they require a key that must never reach the client bundle, or they
 * publish a cadence limit that a few hundred simultaneous visitors would
 * obliterate. Those sources are fetched here instead, once, and served to every
 * visitor from `/api/<module-id>`.
 *
 * Proxying introduces the one thing this project is most careful about: a
 * second clock. A cached response is genuinely older than it looks, and the
 * temptation is to present it as though it had just arrived. So every response
 * from this file carries, explicitly:
 *
 *   - `fetchedAt`      — when THIS WORKER fetched it from upstream. Our clock,
 *                        named as ours.
 *   - `sourceTimestamp`— the source's own newest timestamp. Never substituted
 *                        with `fetchedAt`; null when the payload carries none.
 *   - `cached`         — whether this came out of KV rather than off the wire.
 *   - `fetchAgeSeconds`— how old `fetchedAt` is, so the client can say "via our
 *                        cache, fetched 6 minutes ago" rather than "live".
 *   - `refreshError`   — set when the last refresh attempt failed, alongside
 *                        the last good payload and its real (old) `fetchedAt`.
 *
 * That last one is the delicate case. Serving the last good copy when a refresh
 * fails is NOT a held value in the sense the second principle forbids, provided
 * two things hold, and both are enforced: the copy keeps its true `fetchedAt`
 * rather than being restamped, and the failure is reported in the same
 * response. The client then shows an ageing snapshot with an error on it, which
 * is what actually happened. What would be forbidden — and is not done anywhere
 * here — is restamping a stale payload as fresh, or hiding the failure because
 * there was something to show.
 *
 * Clients must also treat a repeated payload as a repeat: dedupe on
 * `sourceTimestamp`, never count a re-served cache entry as a new arrival.
 */

export interface ProxyEnv {
  /** Lane B storage. Written by the scheduled handler, read by the route. */
  FEED_CACHE?: KVNamespace;
  /** NASA FIRMS map key. Server-side only — it must never appear in a bundle. */
  FIRMS_MAP_KEY?: string;
}

/** What the scheduled handler stores, and what the route serves back. */
interface CacheEntry {
  /** ISO. When this Worker fetched it from upstream. Never rewritten on read. */
  fetchedAt: string;
  /** The source's own newest timestamp, in ms. Null when it publishes none. */
  sourceTimestamp: number | null;
  /** How many records the payload holds, for the status line. */
  count: number;
  data: unknown;
}

/** Recorded when a refresh fails, separately, so it can never clobber good data. */
interface FailureEntry {
  at: string;
  reason: string;
}

interface Shaped {
  data: unknown;
  sourceTimestamp: number | null;
  count: number;
}

interface ProxySource {
  id: string;
  /** Publisher, echoed in the response so a raw API payload stays attributable. */
  attribution: string;
  /** The upstream URL with no secrets in it — safe to show and to log. */
  publicUrl: string;
  /**
   * The cron expression that refreshes this source. Routed on, not just
   * documented: each source is refreshed on its own schedule rather than every
   * source being re-fetched whenever any timer fires.
   */
  cron: string;
  /** Stated refresh interval, so the client can label the cadence truthfully. */
  refreshEverySeconds: number;
  /**
   * Build the upstream request URL. Returns a reason instead when a required
   * secret is absent, so a missing key is reported as a missing key rather than
   * being fetched without one and reported as an upstream rejection.
   */
  buildUrl(env: ProxyEnv): { url: string } | { missing: string };
  /** Reduce the upstream body to the small shape the client consumes. */
  shape(body: string): Shaped;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // Never cached at the edge: the whole point of the envelope is that the
  // client is told exactly how old the payload is, and an intermediary cache
  // would silently add an age nobody accounted for.
  'cache-control': 'no-store',
};

const UPSTREAM_TIMEOUT_MS = 20_000;

/** Longer than GDELT's documented one-request-per-five-seconds, deliberately. */
const RETRY_AFTER_429_MS = 7_000;

/**
 * Identify ourselves upstream. A source deciding whether to keep serving this
 * project should be able to see who is asking and where to complain.
 */
const USER_AGENT = 'realtime-earth/1.0 (+https://realtime-earth.alemarti-2001.workers.dev)';

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

// --- the sources ---------------------------------------------------------

/**
 * GDELT's DOC 2.0 article list: what the world's news media published in the
 * last window, as GDELT indexed it.
 *
 * Lane B for two independent reasons, both observed rather than assumed:
 * the API sends no `access-control-allow-origin`, so a browser cannot read it;
 * and it documents a limit of one request every five seconds, which a public
 * site polling directly would breach with its third simultaneous visitor.
 *
 * `seendate` is GDELT's own "first seen" time for the article, in
 * `YYYYMMDDTHHMMSSZ`. That is the timestamp reported — not our fetch time, and
 * not the article's own publication date, which GDELT does not give here.
 */
const GDELT_QUERY = 'sourcelang:eng';
const GDELT_URL =
  'https://api.gdeltproject.org/api/v2/doc/doc' +
  `?query=${encodeURIComponent(GDELT_QUERY)}` +
  '&mode=artlist&format=json&sort=datedesc&maxrecords=75&timespan=60min';

interface GdeltArticle {
  url?: unknown;
  title?: unknown;
  seendate?: unknown;
  domain?: unknown;
  language?: unknown;
  sourcecountry?: unknown;
}

/** `20260825T101500Z` → ms. Returns null on anything else, never a guess. */
export function parseGdeltSeenDate(value: unknown): number | null {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/.exec(value.trim());
  if (match === null) return null;
  const [, y, mo, d, h, mi, s] = match;
  const ms = Date.UTC(Number(y), Number(mo) - 1, Number(d), Number(h), Number(mi), Number(s));
  return Number.isFinite(ms) ? ms : null;
}

export function shapeGdelt(body: string): Shaped {
  const parsed = JSON.parse(body) as { articles?: unknown };
  const articles = Array.isArray(parsed.articles) ? (parsed.articles as GdeltArticle[]) : [];

  const items = articles.map((article) => {
    const seenMs = parseGdeltSeenDate(article.seendate);
    return {
      url: typeof article.url === 'string' ? article.url : null,
      title: typeof article.title === 'string' ? article.title : null,
      domain: typeof article.domain === 'string' ? article.domain : null,
      language: typeof article.language === 'string' ? article.language : null,
      country: typeof article.sourcecountry === 'string' ? article.sourcecountry : null,
      // Null rather than a substituted clock reading. An article whose seendate
      // we cannot parse has an unknown time, and unknown is displayable.
      seenMs,
    };
  });

  let newest: number | null = null;
  for (const item of items) {
    if (item.seenMs !== null && (newest === null || item.seenMs > newest)) newest = item.seenMs;
  }

  return { data: { articles: items }, sourceTimestamp: newest, count: items.length };
}

/**
 * NASA FIRMS active fire detections.
 *
 * Registered but not yet exercised: FIRMS requires a MAP_KEY, and until
 * `FIRMS_MAP_KEY` is set as a Worker secret this route answers 503
 * `not_configured` and the scheduled handler does not call NASA at all. That
 * refusal is the honest state — a fire map with no data behind it must say the
 * key is missing, not draw an empty world and let it read as "no fires".
 *
 * The CSV is parsed from its own header row rather than against a column list
 * written from documentation, precisely because the real header has not been
 * observed here yet. Whatever columns NASA sends become the record's fields; no
 * column is invented, and a timestamp is only reported when the columns that
 * carry one are actually present.
 */
const FIRMS_DATASET = 'VIIRS_SNPP_NRT';

export function parseCsv(body: string): Array<Record<string, string>> {
  const lines = body.split('\n').filter((line) => line.trim() !== '');
  const headerLine = lines.shift();
  if (headerLine === undefined) return [];
  const headers = headerLine.split(',').map((h) => h.trim());
  return lines.map((line) => {
    const cells = line.split(',');
    const record: Record<string, string> = {};
    headers.forEach((header, index) => {
      record[header] = (cells[index] ?? '').trim();
    });
    return record;
  });
}

/** FIRMS reports `acq_date` (YYYY-MM-DD) and `acq_time` (HHMM) as separate columns. */
export function firmsRowTime(row: Record<string, string>): number | null {
  const date = row['acq_date'];
  const time = row['acq_time'];
  if (date === undefined || time === undefined) return null;
  const padded = time.padStart(4, '0');
  const ms = Date.parse(`${date}T${padded.slice(0, 2)}:${padded.slice(2, 4)}:00Z`);
  return Number.isFinite(ms) ? ms : null;
}

export function shapeFirms(body: string): Shaped {
  const rows = parseCsv(body);
  let newest: number | null = null;
  const detections = rows.map((row) => {
    const time = firmsRowTime(row);
    if (time !== null && (newest === null || time > newest)) newest = time;
    return { ...row, timeMs: time };
  });
  return { data: { detections }, sourceTimestamp: newest, count: detections.length };
}

const SOURCES: readonly ProxySource[] = [
  {
    id: 'gdelt-news',
    attribution: 'The GDELT Project',
    publicUrl: GDELT_URL,
    // A few minutes past each quarter hour: GDELT publishes on the quarter and
    // needs a moment to finish. Refreshing exactly on :00 would reliably fetch
    // the previous window and report it as the current one.
    cron: '4,19,34,49 * * * *',
    refreshEverySeconds: 900,
    buildUrl: () => ({ url: GDELT_URL }),
    shape: shapeGdelt,
  },
  {
    id: 'firms-fires',
    attribution: 'NASA FIRMS',
    publicUrl: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/<MAP_KEY>/${FIRMS_DATASET}/world/1`,
    cron: '27 * * * *',
    refreshEverySeconds: 3600,
    buildUrl: (env) => {
      const key = env.FIRMS_MAP_KEY;
      if (key === undefined || key === '') {
        return {
          missing:
            'FIRMS_MAP_KEY is not configured on this deployment. NASA FIRMS requires a free MAP_KEY; until one is set this feed has no data and says so rather than showing an empty map.',
        };
      }
      return { url: `https://firms.modaps.eosdis.nasa.gov/api/area/csv/${key}/${FIRMS_DATASET}/world/1` };
    },
    shape: shapeFirms,
  },
];

export function proxySourceById(id: string): ProxySource | undefined {
  return SOURCES.find((source) => source.id === id);
}

/** Every cron expression the sources need, for wrangler.jsonc to declare. */
export function proxyCronExpressions(): string[] {
  return [...new Set(SOURCES.map((source) => source.cron))];
}

// --- storage -------------------------------------------------------------

const dataKey = (id: string): string => `feed:${id}`;
const errorKey = (id: string): string => `feed:${id}:error`;

async function readEntry(kv: KVNamespace, id: string): Promise<CacheEntry | null> {
  return kv.get<CacheEntry>(dataKey(id), 'json');
}

async function readFailure(kv: KVNamespace, id: string): Promise<FailureEntry | null> {
  return kv.get<FailureEntry>(errorKey(id), 'json');
}

// --- fetching ------------------------------------------------------------

interface FetchOutcome {
  entry?: CacheEntry;
  failure?: FailureEntry;
}

/**
 * Fetch one source from upstream and shape it. Never throws: a failure is a
 * value, because it has to be storable and displayable rather than merely
 * logged somewhere nobody reads.
 *
 * `cacheTtl` collapses concurrent cold-start fetches within a colo onto a
 * single upstream request. Without it, the first visitors after a deploy would
 * each trigger their own fetch and trip exactly the rate limit that put this
 * source in Lane B.
 */
async function fetchUpstream(
  source: ProxySource,
  env: ProxyEnv,
  { patientOn429 = false }: { patientOn429?: boolean } = {},
): Promise<FetchOutcome> {
  const built = source.buildUrl(env);
  if ('missing' in built) {
    return { failure: { at: new Date().toISOString(), reason: built.missing } };
  }

  try {
    let response = await fetch(built.url, {
      headers: { 'user-agent': USER_AGENT, accept: '*/*' },
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      cf: { cacheTtl: Math.min(source.refreshEverySeconds, 300), cacheEverything: true },
    });

    // A 429 is the source telling us its cadence, in detail. Verification from
    // a GitHub runner showed GDELT answering 429 to the very first request of a
    // run — a per-IP limit shared with everything else on that runner, not our
    // pacing. A single patient retry costs one refresh cycle nothing and is the
    // difference between "the source refused" and "we did not wait".
    //
    // Only the scheduled path waits. On the request path a visitor would be
    // held for the whole delay, so it reports the 429 immediately instead.
    if (response.status === 429 && patientOn429) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_AFTER_429_MS));
      response = await fetch(built.url, {
        headers: { 'user-agent': USER_AGENT, accept: '*/*' },
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
        // No `cf` cache on the retry: the point is to get past the 429, and a
        // cached copy of the 429 itself is what we are trying not to re-read.
      });
    }

    if (!response.ok) {
      const detail =
        response.status === 429
          ? `${source.attribution} answered HTTP 429 — it is rate-limiting this origin. Nothing new could be fetched this cycle.`
          : `${source.attribution} answered HTTP ${response.status}.`;
      return { failure: { at: new Date().toISOString(), reason: detail } };
    }

    const body = await response.text();
    const shaped = source.shape(body);
    return {
      entry: {
        // Our clock, and labelled as ours everywhere it is shown.
        fetchedAt: new Date().toISOString(),
        sourceTimestamp: shaped.sourceTimestamp,
        count: shaped.count,
        data: shaped.data,
      },
    };
  } catch (error) {
    const reason =
      error instanceof Error && error.name === 'TimeoutError'
        ? `${source.attribution} did not answer within ${UPSTREAM_TIMEOUT_MS / 1000}s.`
        : `Could not reach ${source.attribution}: ${error instanceof Error ? error.message : 'request failed'}`;
    return { failure: { at: new Date().toISOString(), reason } };
  }
}

/**
 * Refresh one source into KV.
 *
 * A failure writes the failure record and leaves the last good payload exactly
 * as it was — same bytes, same `fetchedAt`. Overwriting good data with an
 * error would throw away the only real thing we have; restamping it would be a
 * lie. Keeping both is what lets the route serve an ageing snapshot with the
 * reason it stopped ageing forward printed on it.
 */
export async function refreshSource(
  source: ProxySource,
  env: ProxyEnv,
  options: { patientOn429?: boolean } = {},
): Promise<FetchOutcome> {
  const kv = env.FEED_CACHE;
  if (kv === undefined) return { failure: { at: new Date().toISOString(), reason: 'No FEED_CACHE binding on this deployment.' } };

  const outcome = await fetchUpstream(source, env, options);
  if (outcome.entry !== undefined) {
    await kv.put(dataKey(source.id), JSON.stringify(outcome.entry));
    await kv.delete(errorKey(source.id));
  } else if (outcome.failure !== undefined) {
    await kv.put(errorKey(source.id), JSON.stringify(outcome.failure), {
      // Long enough to survive several refresh cycles, short enough that a
      // resolved failure does not linger as a warning about nothing.
      expirationTtl: Math.max(600, source.refreshEverySeconds * 4),
    });
  }
  return outcome;
}

/**
 * The scheduled handler's work: refresh the sources whose cron just fired.
 *
 * Routed by cron expression rather than refreshing everything on every tick.
 * A source that asked to be read hourly should be read hourly — re-fetching it
 * every fifteen minutes because something else needed to be would be us
 * ignoring a limit the publisher stated.
 */
export async function refreshForCron(cron: string, env: ProxyEnv): Promise<string[]> {
  const due = SOURCES.filter((source) => source.cron === cron);
  const log: string[] = [];
  for (const source of due) {
    const outcome = await refreshSource(source, env, { patientOn429: true });
    log.push(
      outcome.entry !== undefined
        ? `${source.id}: ${outcome.entry.count} records`
        : `${source.id}: ${outcome.failure?.reason ?? 'failed'}`,
    );
  }
  return log;
}

// --- the route -----------------------------------------------------------

/**
 * `GET /api/<module-id>` — serve the cached payload with its true age.
 *
 * Returns 200 with `ok: false` and a reason whenever there is nothing honest to
 * serve, so the client always parses one envelope shape and always has
 * something to display. HTTP status still distinguishes the cases for anything
 * reading the route directly.
 */
export async function handleProxy(source: ProxySource, env: ProxyEnv): Promise<Response> {
  const kv = env.FEED_CACHE;
  if (kv === undefined) {
    return json(
      {
        ok: false,
        module: source.id,
        lane: 'B',
        error: 'no_cache_binding',
        message: 'The FEED_CACHE KV binding is missing from this deployment, so Lane B cannot serve anything.',
      },
      503,
    );
  }

  let entry = await readEntry(kv, source.id);
  let failure = await readFailure(kv, source.id);
  let cached = true;

  // Cold cache: nothing has been stored yet, because this is the first request
  // after a deploy and the cron has not fired. Fetch once now rather than
  // making the first visitors wait up to a full refresh interval to see
  // anything. Labelled `cached: false`, because that is what it is.
  if (entry === null) {
    const outcome = await refreshSource(source, env);
    if (outcome.entry !== undefined) {
      entry = outcome.entry;
      failure = null;
      cached = false;
    } else {
      failure = outcome.failure ?? failure;
    }
  }

  if (entry === null) {
    return json(
      {
        ok: false,
        module: source.id,
        lane: 'B',
        attribution: source.attribution,
        upstream: source.publicUrl,
        error: 'unavailable',
        // The reason the source gave, verbatim where possible. "Unavailable"
        // on its own tells a reader nothing they can act on.
        message: failure?.reason ?? 'This feed has never been fetched successfully.',
        failedAt: failure?.at ?? null,
      },
      503,
    );
  }

  const fetchedMs = Date.parse(entry.fetchedAt);
  const ageSeconds = Number.isFinite(fetchedMs) ? Math.max(0, Math.round((Date.now() - fetchedMs) / 1000)) : null;

  return json({
    ok: true,
    module: source.id,
    lane: 'B',
    attribution: source.attribution,
    upstream: source.publicUrl,
    /** Our clock: when this Worker fetched the payload from upstream. */
    fetchedAt: entry.fetchedAt,
    fetchAgeSeconds: ageSeconds,
    cached,
    refreshEverySeconds: source.refreshEverySeconds,
    /** The source's own newest timestamp, in ms. Null when it publishes none. */
    sourceTimestamp: entry.sourceTimestamp,
    count: entry.count,
    /**
     * Set when the most recent refresh failed. The payload below is then the
     * last good copy, still carrying its real `fetchedAt` — an ageing snapshot
     * with the reason it stopped ageing forward attached, not a fresh reading.
     */
    refreshError: failure === null ? null : { at: failure.at, reason: failure.reason },
    data: entry.data,
  });
}
