#!/usr/bin/env node
/**
 * Endpoint verification gate.
 *
 * The project rule is: before wiring ANY endpoint, verify it actually works —
 * status, CORS headers, auth requirements, and whether it still exists. This
 * script does that check for every candidate source, so the answer is evidence
 * rather than recollection, and so it can be re-run whenever a source is
 * suspected of having changed.
 *
 * It is also the gate for Lane A specifically: a source only qualifies for Lane
 * A if it is keyless AND returns `access-control-allow-origin` permitting a
 * browser origin. Anything else must go through the Worker (Lane B or C).
 *
 * Requires unrestricted outbound network access — run it from a normal machine
 * or CI runner, not from a sandbox with an egress allowlist.
 *
 * Usage:
 *   node scripts/verify-endpoints.mjs                   # check everything
 *   node scripts/verify-endpoints.mjs usgs binance      # check by id substring
 *   node scripts/verify-endpoints.mjs --json            # machine-readable output
 *   node scripts/verify-endpoints.mjs --json-out=f.json # table + JSON in one pass
 *
 * Use `--json-out` rather than running the script twice. Probing a source twice
 * in quick succession is enough to trip the rate limits of the very sources
 * this is meant to assess (GDELT allows one request per five seconds), which
 * turns the report into a measurement of our own impatience.
 */

const TIMEOUT_MS = 20_000;
const BROWSER_ORIGIN = 'https://realtime-earth.example';

// Some sources treat an unidentified client differently from a browser. Since
// the question being answered is "will a browser get this?", the probe presents
// itself as one rather than as a bare fetch client.
const USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36';

/**
 * IMPORTANT CAVEAT ON WHERE THIS RUNS.
 *
 * In CI this executes on a GitHub runner, which is US-based. Some sources
 * geo-restrict, so a refusal here is evidence about the runner's location, not
 * necessarily about a visitor's browser — and conversely a success here does
 * not prove availability everywhere. Where that distinction matters (Binance is
 * the known case) the report says so rather than silently declaring the source
 * dead. Run this locally too before dropping a source on CI evidence alone.
 */

/**
 * Candidate sources named in the project spec. `expectedLane` records the lane
 * the spec assumes; the script reports when the evidence contradicts it.
 */
const ENDPOINTS = [
  // --- Section 1: finance & markets ---
  // VERIFIED: stream.binance.com refuses from a US runner with HTTP 451
  // ("Service unavailable from a restricted location"). That is a statement
  // about where the probe runs, not about the endpoint, so it is kept in the
  // list — a visitor's browser elsewhere may well connect. The REST ping is
  // what surfaces the 451 body, since a WebSocket handshake failure alone
  // never explains itself.
  { id: 'binance-ws', kind: 'ws', expectedLane: 'A', url: 'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade', note: 'geo-restricted: 451 from US runners; may work from a visitor browser' },
  { id: 'binance-rest-ping', kind: 'rest', expectedLane: 'A', url: 'https://api.binance.com/api/v3/ping', note: 'diagnostic: exposes the 451 body behind the WS handshake failure' },
  // VERIFIED WORKING from the runner: the market-data-only host is not
  // geo-restricted, so this is the endpoint the module should use.
  { id: 'binance-ws-vision', kind: 'ws', expectedLane: 'A', url: 'wss://data-stream.binance.vision/stream?streams=btcusdt@aggTrade', note: 'market-data-only host; handshake accepted where the main host refused' },
  { id: 'coinbase-ws', kind: 'ws', expectedLane: 'A', url: 'wss://ws-feed.exchange.coinbase.com', note: 'matches channel, second venue for spread' },
  // Stooq introduced an API key around 2026-04-01, issued only by emailing
  // www@stooq.com. Both keyless CSV paths now answer with an HTML 404 rather
  // than a 401, which is why they read as "not found" instead of "gated".
  // Until a key exists this source cannot be wired at all.
  { id: 'stooq-quote', kind: 'rest', expectedLane: 'B', url: 'https://stooq.com/q/l/?s=spy.us&f=sd2t2ohlcv&h&e=csv', note: 'key required since ~2026-04-01 (email www@stooq.com); keyless path 404s' },
  { id: 'stooq-index', kind: 'rest', expectedLane: 'B', url: 'https://stooq.com/q/l/?s=%5Espx&f=sd2t2ohlcv&h&e=csv', note: 'same key requirement' },

  // --- Section 2: logistics & infrastructure ---
  // ADS-B: the spec assumed adsb.lol / adsb.fi were the CORS-friendly ones.
  // The first verification run showed the opposite — both answer 200 with no
  // access-control-allow-origin at all, so a browser cannot read them, while
  // airplanes.live returns `*`. `expectedLane` still records what the spec
  // assumed, so the report keeps flagging the contradiction until the design
  // is updated rather than quietly agreeing with itself.
  { id: 'adsb-lol', kind: 'rest', expectedLane: 'A', url: 'https://api.adsb.lol/v2/lat/51.5/lon/0.0/dist/50', note: 'keyless, but no CORS header observed — browser cannot read it directly' },
  { id: 'adsb-fi', kind: 'rest', expectedLane: 'A', url: 'https://opendata.adsb.fi/api/v2/lat/51.5/lon/0.0/dist/50', note: 'keyless, but no CORS header observed' },
  { id: 'airplanes-live', kind: 'rest', expectedLane: 'A', url: 'https://api.airplanes.live/v2/point/51.5/0.0/50', note: 'keyless AND CORS `*` — the only Lane A ADS-B source found' },
  { id: 'opensky', kind: 'rest', expectedLane: 'A', url: 'https://opensky-network.org/api/states/all?lamin=50&lomin=-1&lamax=52&lomax=2', note: 'answers, but CORS is restricted to its own origin; also rate-limited' },
  { id: 'ripe-ris-live', kind: 'ws', expectedLane: 'A', url: 'wss://ris-live.ripe.net/v1/ws/', note: 'BGP UPDATE stream' },
  { id: 'aisstream', kind: 'ws', expectedLane: 'C', url: 'wss://stream.aisstream.io/v0/stream', note: 'key-gated: expect handshake ok, then auth failure without a key', needsKey: true },

  // --- Section 3: earth system & energy ---
  { id: 'carbonintensity-uk', kind: 'rest', expectedLane: 'A', url: 'https://api.carbonintensity.org.uk/intensity', note: 'keyless, CORS-open' },
  { id: 'carbonintensity-mix', kind: 'rest', expectedLane: 'A', url: 'https://api.carbonintensity.org.uk/generation', note: 'generation mix' },
  // Every file under /products/solar-wind/ 404s — plasma and mag, at every
  // window — while other SWPC paths (K-index, GOES X-ray) still return 200.
  // SWPC stopped ingesting DSCOVR and moved to SOLAR-1 as the primary solar
  // wind source in 2026, retiring the legacy products. Rather than guess the
  // replacement filenames, these two entries read the source's own directory
  // listings, so the next run reports what SWPC actually publishes today.
  // CONFIRMED by reading /products/ itself: there is no `solar-wind/`
  // directory any more. It is not a moved file or a renamed window — the whole
  // directory is gone, along with the DSCOVR plasma and mag products the spec
  // asked for. The remaining question is what replaced them, so the search
  // continues one level down instead of guessing filenames.
  { id: 'swpc-index-products', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 2600, url: 'https://services.swpc.noaa.gov/products/', note: 'DISCOVERY: full listing — solar-wind/ is absent from it' },
  { id: 'swpc-index-summary', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 2600, url: 'https://services.swpc.noaa.gov/products/summary/', note: 'DISCOVERY: summary products, a likely home for wind speed and Bz' },
  { id: 'swpc-index-json', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 2600, url: 'https://services.swpc.noaa.gov/json/', note: 'DISCOVERY: the other SWPC tree, where GOES X-ray already lives' },
  { id: 'swpc-plasma-5min', kind: 'rest', expectedLane: 'A', url: 'https://services.swpc.noaa.gov/products/solar-wind/plasma-5-minute.json', note: 'RETIRED: directory no longer exists (DSCOVR ingest stopped)' },
  { id: 'swpc-kp', kind: 'rest', expectedLane: 'A', url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', note: 'planetary K-index' },
  { id: 'swpc-xray', kind: 'rest', expectedLane: 'A', url: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json', note: 'GOES X-ray flux' },
  { id: 'usgs-hour', kind: 'rest', expectedLane: 'A', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson', note: 'keyless, CORS-open' },
  { id: 'usgs-day', kind: 'rest', expectedLane: 'A', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', note: 'keyless, CORS-open' },
  { id: 'firms', kind: 'rest', expectedLane: 'B', url: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/MAP_KEY_PLACEHOLDER/VIIRS_SNPP_NRT/world/1', note: 'needs MAP_KEY; 401/403 without one is the expected result', needsKey: true },

  // --- Section 4: collective information flows ---
  { id: 'wikimedia-sse', kind: 'sse', expectedLane: 'A', url: 'https://stream.wikimedia.org/v2/stream/recentchange', note: 'Server-Sent Events, NOT WebSocket' },
  { id: 'gdelt-doc', kind: 'rest', expectedLane: 'B', url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=climate&mode=artlist&format=json&maxrecords=5', note: 'no CORS — expect Lane B' },
  { id: 'mempool-ws', kind: 'ws', expectedLane: 'A', url: 'wss://mempool.space/api/v1/ws', note: 'unconfirmed tx, fee bands, blocks' },
  { id: 'eth-rpc-publicnode', kind: 'rest', method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}', expectedLane: 'A', url: 'https://ethereum-rpc.publicnode.com', note: 'block number, base fee, gas used' },
];

const args = process.argv.slice(2);
const asJson = args.includes('--json');
const jsonOut = args.find((a) => a.startsWith('--json-out='))?.slice('--json-out='.length);
const filters = args.filter((a) => !a.startsWith('--'));
const selected = filters.length
  ? ENDPOINTS.filter((e) => filters.some((f) => e.id.includes(f)))
  : ENDPOINTS;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function checkHttp(endpoint, attempt = 1) {
  const { signal, done } = withTimeout(TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      method: endpoint.method ?? 'GET',
      // Sending a browser-like Origin is the whole point: it is what reveals
      // whether the source will actually answer a browser (Lane A) or not.
      headers: {
        origin: BROWSER_ORIGIN,
        'user-agent': USER_AGENT,
        ...(endpoint.body ? { 'content-type': 'application/json' } : {}),
        ...(endpoint.kind === 'sse' ? { accept: 'text/event-stream' } : {}),
      },
      ...(endpoint.body ? { body: endpoint.body } : {}),
      signal,
    });

    const acao = response.headers.get('access-control-allow-origin');
    const corsOk = acao === '*' || acao === BROWSER_ORIGIN;

    // Discovery endpoints (directory indexes) need a longer excerpt, because
    // the point of probing them is to read what the source actually publishes
    // instead of guessing filenames.
    const sampleChars = endpoint.sampleChars ?? 120;

    let sample = '';
    if (endpoint.kind === 'sse') {
      // Read only the first chunk: an SSE endpoint never ends on its own.
      const reader = response.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        sample = new TextDecoder().decode(value ?? new Uint8Array()).slice(0, sampleChars).replace(/\s+/g, ' ');
        await reader.cancel();
      }
    } else {
      sample = (await response.text()).slice(0, sampleChars).replace(/\s+/g, ' ');
    }

    return {
      ok: response.ok,
      status: String(response.status),
      cors: acao ?? 'none',
      corsOk,
      ms: Date.now() - started,
      contentType: response.headers.get('content-type') ?? '',
      sample,
    };
  } catch (error) {
    // Retry once on a transport failure. A source that is merely slow or drops
    // one connection should not be recorded as dead — that would be as
    // misleading as recording a dead source as alive.
    if (attempt === 1) {
      done();
      return checkHttp(endpoint, 2);
    }
    return {
      ok: false,
      status: 'ERR',
      cors: 'n/a',
      corsOk: false,
      ms: Date.now() - started,
      contentType: '',
      sample: `${String(error?.message ?? error)} (2 attempts)`,
    };
  } finally {
    done();
  }
}

function checkWebSocket(endpoint) {
  const started = Date.now();
  return new Promise((resolve) => {
    let socket;
    let settled = false;

    const finish = (result) => {
      // A failing socket can emit `error` and then `close`, and a timeout can
      // race both. Settle exactly once, or the report double-counts a single
      // endpoint.
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        // Only an OPEN socket can be closed; calling close() while still
        // CONNECTING throws from inside the WebSocket implementation and
        // surfaces as an unhandled rejection.
        if (socket && socket.readyState === WebSocket.OPEN) socket.close();
      } catch {
        /* nothing left to clean up */
      }
      resolve({ ms: Date.now() - started, cors: 'n/a', corsOk: true, contentType: '', ...result });
    };

    const timer = setTimeout(
      () => finish({ ok: false, status: 'TIMEOUT', sample: `no open event within ${TIMEOUT_MS}ms` }),
      TIMEOUT_MS,
    );

    try {
      socket = new WebSocket(endpoint.url);
    } catch (error) {
      finish({ ok: false, status: 'ERR', sample: String(error?.message ?? error) });
      return;
    }

    socket.addEventListener('open', () => {
      // A successful handshake is all this script claims. Whether the stream
      // then delivers data can depend on a subscription message and a key, so
      // that is verified per-module, not here.
      finish({ ok: true, status: 'OPEN', sample: 'handshake accepted' });
    });
    socket.addEventListener('error', () => {
      finish({ ok: false, status: 'ERR', sample: 'handshake failed' });
    });
    socket.addEventListener('close', (event) => {
      // Reached only when the socket closed without ever opening.
      finish({
        ok: false,
        status: 'CLOSED',
        sample: `closed before open (code ${event.code}${event.reason ? `: ${event.reason}` : ''})`,
      });
    });
  });
}

const results = [];
for (const endpoint of selected) {
  const outcome = endpoint.kind === 'ws' ? await checkWebSocket(endpoint) : await checkHttp(endpoint);

  // Lane A requires keyless + CORS-permitted. Anything else must be proxied.
  //
  // An unreachable source yields no lane evidence at all. Calling it "Lane B"
  // because no CORS header came back would be inventing a finding out of a
  // failure — the same move the site's first principle forbids — so it is
  // reported as unknown and no mismatch is claimed.
  // A key-gated source answering 401/403 without a key is working as designed:
  // the host is up and the gate is real. That is a successful probe, and it is
  // also the evidence that the source cannot be Lane A.
  const gated = Boolean(endpoint.needsKey) && ['400', '401', '403'].includes(outcome.status);

  // A 429 is the source answering, in detail, that we asked too often. That is
  // a live source with a documented cadence limit — recording it as an outage
  // would be false, and would hide the fact that the fix is to poll slower
  // (which is precisely why such a source belongs in Lane B behind a
  // scheduled handler).
  const throttled = outcome.status === '429';
  const reachable = outcome.ok || gated || throttled;

  let laneEvidence;
  if (endpoint.kind === 'ws') {
    laneEvidence = reachable ? (endpoint.needsKey ? 'C' : 'A') : '?';
  } else {
    laneEvidence = reachable ? (outcome.corsOk && !endpoint.needsKey ? 'A' : 'B') : '?';
  }

  results.push({
    reachable,
    gated,
    throttled,
    id: endpoint.id,
    kind: endpoint.kind,
    url: endpoint.url,
    expectedLane: endpoint.expectedLane,
    laneEvidence,
    laneMismatch: laneEvidence !== '?' && laneEvidence !== endpoint.expectedLane,
    discovery: Boolean(endpoint.discovery),
    note: endpoint.note,
    ...outcome,
  });
}

if (jsonOut) {
  const { writeFileSync } = await import('node:fs');
  writeFileSync(jsonOut, JSON.stringify(results, null, 2));
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(pad('ID', 22) + pad('KIND', 6) + pad('STATUS', 12) + pad('CORS', 26) + pad('LANE', 12) + 'MS');
  console.log('-'.repeat(96));
  for (const r of results) {
    const lane = r.laneMismatch ? `${r.expectedLane}→${r.laneEvidence} !` : r.laneEvidence === '?' ? `${r.expectedLane} (?)` : r.expectedLane;
    const status = r.gated ? `${r.status} gated` : r.throttled ? `${r.status} slow-down` : r.status;
    console.log(pad(r.id, 22) + pad(r.kind, 6) + pad(status, 12) + pad(r.cors, 26) + pad(lane, 12) + r.ms);
    // Print the body for anything that is not a plain success, so a gate's own
    // wording is visible — that is what distinguishes "needs a key" from
    // "rate limited" from "blocked by something between us and the source".
    if (!r.reachable || r.laneMismatch || r.gated || r.throttled || r.discovery) {
      console.log(`  ↳ ${r.sample}`);
    }
  }
  console.log('-'.repeat(96));
  const failed = results.filter((r) => !r.reachable);
  const mismatched = results.filter((r) => r.laneMismatch);
  console.log(`${results.length - failed.length}/${results.length} reachable; ${mismatched.length} lane mismatch(es).`);
  if (failed.length) console.log(`Unreachable: ${failed.map((r) => r.id).join(', ')}`);
  if (mismatched.length) console.log(`Lane evidence differs from spec for: ${mismatched.map((r) => r.id).join(', ')}`);
  console.log('\nA failure here is a finding, not a bug to code around: substitute the source or');
  console.log('show an honest error in the module. Never ship a placeholder feed.');
}
