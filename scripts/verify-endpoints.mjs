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
 *   node scripts/verify-endpoints.mjs              # check everything
 *   node scripts/verify-endpoints.mjs usgs binance # check by id substring
 *   node scripts/verify-endpoints.mjs --json       # machine-readable output
 */

const TIMEOUT_MS = 15_000;
const BROWSER_ORIGIN = 'https://realtime-earth.example';

/**
 * Candidate sources named in the project spec. `expectedLane` records the lane
 * the spec assumes; the script reports when the evidence contradicts it.
 */
const ENDPOINTS = [
  // --- Section 1: finance & markets ---
  { id: 'binance-ws', kind: 'ws', expectedLane: 'A', url: 'wss://stream.binance.com:9443/stream?streams=btcusdt@aggTrade', note: 'aggTrade + bookTicker, tick-by-tick' },
  { id: 'coinbase-ws', kind: 'ws', expectedLane: 'A', url: 'wss://ws-feed.exchange.coinbase.com', note: 'matches channel, second venue for spread' },
  { id: 'stooq-quote', kind: 'rest', expectedLane: 'B', url: 'https://stooq.com/q/l/?s=spy.us&f=sd2t2ohlcv&h&e=csv', note: 'delayed / EOD equities CSV' },

  // --- Section 2: logistics & infrastructure ---
  { id: 'adsb-lol', kind: 'rest', expectedLane: 'A', url: 'https://api.adsb.lol/v2/lat/51.5/lon/0.0/dist/50', note: 'keyless ADS-B, bounded region' },
  { id: 'adsb-fi', kind: 'rest', expectedLane: 'A', url: 'https://opendata.adsb.fi/api/v2/lat/51.5/lon/0.0/dist/50', note: 'ADS-B fallback' },
  { id: 'airplanes-live', kind: 'rest', expectedLane: 'A', url: 'https://api.airplanes.live/v2/point/51.5/0.0/50', note: 'ADS-B fallback' },
  { id: 'opensky', kind: 'rest', expectedLane: 'A', url: 'https://opensky-network.org/api/states/all?lamin=50&lomin=-1&lamax=52&lomax=2', note: 'heavily rate-limited, largely OAuth-gated now' },
  { id: 'ripe-ris-live', kind: 'ws', expectedLane: 'A', url: 'wss://ris-live.ripe.net/v1/ws/', note: 'BGP UPDATE stream' },
  { id: 'aisstream', kind: 'ws', expectedLane: 'C', url: 'wss://stream.aisstream.io/v0/stream', note: 'key-gated: expect handshake ok, then auth failure without a key', needsKey: true },

  // --- Section 3: earth system & energy ---
  { id: 'carbonintensity-uk', kind: 'rest', expectedLane: 'A', url: 'https://api.carbonintensity.org.uk/intensity', note: 'keyless, CORS-open' },
  { id: 'carbonintensity-mix', kind: 'rest', expectedLane: 'A', url: 'https://api.carbonintensity.org.uk/generation', note: 'generation mix' },
  { id: 'swpc-solar-wind', kind: 'rest', expectedLane: 'A', url: 'https://services.swpc.noaa.gov/products/solar-wind/plasma-5-minute.json', note: 'DSCOVR plasma' },
  { id: 'swpc-mag', kind: 'rest', expectedLane: 'A', url: 'https://services.swpc.noaa.gov/products/solar-wind/mag-5-minute.json', note: 'DSCOVR magnetic field, Bz' },
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
const filters = args.filter((a) => !a.startsWith('--'));
const selected = filters.length
  ? ENDPOINTS.filter((e) => filters.some((f) => e.id.includes(f)))
  : ENDPOINTS;

function withTimeout(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

async function checkHttp(endpoint) {
  const { signal, done } = withTimeout(TIMEOUT_MS);
  const started = Date.now();
  try {
    const response = await fetch(endpoint.url, {
      method: endpoint.method ?? 'GET',
      // Sending a browser-like Origin is the whole point: it is what reveals
      // whether the source will actually answer a browser (Lane A) or not.
      headers: {
        origin: BROWSER_ORIGIN,
        ...(endpoint.body ? { 'content-type': 'application/json' } : {}),
        ...(endpoint.kind === 'sse' ? { accept: 'text/event-stream' } : {}),
      },
      ...(endpoint.body ? { body: endpoint.body } : {}),
      signal,
    });

    const acao = response.headers.get('access-control-allow-origin');
    const corsOk = acao === '*' || acao === BROWSER_ORIGIN;

    let sample = '';
    if (endpoint.kind === 'sse') {
      // Read only the first chunk: an SSE endpoint never ends on its own.
      const reader = response.body?.getReader();
      if (reader) {
        const { value } = await reader.read();
        sample = new TextDecoder().decode(value ?? new Uint8Array()).slice(0, 120).replace(/\s+/g, ' ');
        await reader.cancel();
      }
    } else {
      sample = (await response.text()).slice(0, 120).replace(/\s+/g, ' ');
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
    return { ok: false, status: 'ERR', cors: 'n/a', corsOk: false, ms: Date.now() - started, contentType: '', sample: String(error?.message ?? error) };
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
  const reachable = outcome.ok || gated;

  let laneEvidence;
  if (endpoint.kind === 'ws') {
    laneEvidence = reachable ? (endpoint.needsKey ? 'C' : 'A') : '?';
  } else {
    laneEvidence = reachable ? (outcome.corsOk && !endpoint.needsKey ? 'A' : 'B') : '?';
  }

  results.push({
    reachable,
    gated,
    id: endpoint.id,
    kind: endpoint.kind,
    url: endpoint.url,
    expectedLane: endpoint.expectedLane,
    laneEvidence,
    laneMismatch: laneEvidence !== '?' && laneEvidence !== endpoint.expectedLane,
    note: endpoint.note,
    ...outcome,
  });
}

if (asJson) {
  console.log(JSON.stringify(results, null, 2));
} else {
  const pad = (s, n) => String(s).padEnd(n).slice(0, n);
  console.log(pad('ID', 22) + pad('KIND', 6) + pad('STATUS', 12) + pad('CORS', 26) + pad('LANE', 12) + 'MS');
  console.log('-'.repeat(96));
  for (const r of results) {
    const lane = r.laneMismatch ? `${r.expectedLane}→${r.laneEvidence} !` : r.laneEvidence === '?' ? `${r.expectedLane} (?)` : r.expectedLane;
    const status = r.gated ? `${r.status} gated` : r.status;
    console.log(pad(r.id, 22) + pad(r.kind, 6) + pad(status, 12) + pad(r.cors, 26) + pad(lane, 12) + r.ms);
    // Print the body for anything that is not a plain success, so a gate's own
    // wording is visible — that is what distinguishes "needs a key" from
    // "blocked by something between us and the source".
    if (!r.reachable || r.laneMismatch || r.gated) console.log(`  ↳ ${r.sample}`);
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
