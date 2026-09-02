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
  // Reading the directories answered it: /products/ has no solar-wind/ entry
  // at all, /products/summary/ carries single current values for wind speed
  // and mag field, and /json/ has an rtsw/ tree — Real-Time Solar Wind, the
  // replacement for the retired DSCOVR products. Probing all three, since the
  // summary files are 60 bytes (one value each) while rtsw/ should hold the
  // series the space-weather module actually needs.
  { id: 'swpc-index-rtsw', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 2600, url: 'https://services.swpc.noaa.gov/json/rtsw/', note: 'DISCOVERY: real-time solar wind, successor to the DSCOVR products' },
  { id: 'swpc-summary-wind-speed', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 300, url: 'https://services.swpc.noaa.gov/products/summary/solar-wind-speed.json', note: 'current solar wind speed, single value' },
  { id: 'swpc-summary-mag-field', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 300, url: 'https://services.swpc.noaa.gov/products/summary/solar-wind-mag-field.json', note: 'current Bt/Bz, single value' },
  { id: 'swpc-index-products', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 2600, url: 'https://services.swpc.noaa.gov/products/', note: 'DISCOVERY: full listing — confirms solar-wind/ is gone, not moved' },
  { id: 'swpc-kp', kind: 'rest', expectedLane: 'A', url: 'https://services.swpc.noaa.gov/products/noaa-planetary-k-index.json', note: 'planetary K-index' },
  { id: 'swpc-xray', kind: 'rest', expectedLane: 'A', url: 'https://services.swpc.noaa.gov/json/goes/primary/xrays-6-hour.json', note: 'GOES X-ray flux' },
  { id: 'usgs-hour', kind: 'rest', expectedLane: 'A', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_hour.geojson', note: 'keyless, CORS-open' },
  { id: 'usgs-day', kind: 'rest', expectedLane: 'A', url: 'https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson', note: 'keyless, CORS-open' },
  { id: 'firms', kind: 'rest', expectedLane: 'B', url: 'https://firms.modaps.eosdis.nasa.gov/api/area/csv/MAP_KEY_PLACEHOLDER/VIIRS_SNPP_NRT/world/1', note: 'needs MAP_KEY; 401/403 without one is the expected result', needsKey: true },

  // --- Section 4: collective information flows ---
  { id: 'wikimedia-sse', kind: 'sse', expectedLane: 'A', url: 'https://stream.wikimedia.org/v2/stream/recentchange', note: 'Server-Sent Events, NOT WebSocket' },
  { id: 'gdelt-doc', kind: 'rest', expectedLane: 'B', minGapMs: 6000, url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=climate&mode=artlist&format=json&maxrecords=5', note: 'no CORS — expect Lane B' },
  // Candidate queries for the Lane B news module, probed rather than assumed.
  // GDELT's DOC API requires a query, and which forms it accepts is not
  // something to guess: an operator-only query is either supported or answered
  // with an error page, and the module's whole shape depends on which. The
  // long samples are so the JSON field names come back as evidence instead of
  // being remembered — `seendate`'s exact format decides the parser.
  { id: 'gdelt-artlist-lang', kind: 'rest', expectedLane: 'B', discovery: true, sampleChars: 1200, minGapMs: 6000, url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=sourcelang%3Aeng&mode=artlist&format=json&maxrecords=10&sort=datedesc&timespan=30min', note: 'DISCOVERY: operator-only query — the broadest honest "what is the world publishing" filter' },
  { id: 'gdelt-artlist-broad', kind: 'rest', expectedLane: 'B', discovery: true, sampleChars: 1200, minGapMs: 6000, url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=%28world%20OR%20news%29&mode=artlist&format=json&maxrecords=10&sort=datedesc&timespan=30min', note: 'DISCOVERY: keyword fallback if operator-only queries are rejected' },
  { id: 'gdelt-timeline-vol', kind: 'rest', expectedLane: 'B', discovery: true, sampleChars: 1200, minGapMs: 6000, url: 'https://api.gdeltproject.org/api/v2/doc/doc?query=sourcelang%3Aeng&mode=timelinevolraw&format=json&timespan=1d', note: 'DISCOVERY: article counts per 15-min bucket — real published history for the chart' },
  { id: 'mempool-ws', kind: 'ws', expectedLane: 'A', url: 'wss://mempool.space/api/v1/ws', note: 'unconfirmed tx, fee bands, blocks' },
  { id: 'eth-rpc-publicnode', kind: 'rest', method: 'POST', body: '{"jsonrpc":"2.0","id":1,"method":"eth_blockNumber","params":[]}', expectedLane: 'A', url: 'https://ethereum-rpc.publicnode.com', note: 'block number, base fee, gas used' },

  // --- history endpoints, so a view opens with data instead of empty --------
  // A chart that starts blank and fills over the next few minutes is useless on
  // arrival. Each module backfills from its source's OWN history endpoint —
  // still received data, not invention, which is precisely why these need
  // verifying like anything else.
  { id: 'binance-klines-vision', kind: 'rest', expectedLane: 'A', url: 'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=5', note: 'price history; market-data host, since api.binance.com is geo-restricted' },

  // --- surface temperature, for the hover map ------------------------------
  // Open-Meteo accepts several coordinates per request, which is what makes a
  // grid affordable. This is numerical model output, not a thermometer at that
  // spot, and the module has to say so.
  { id: 'open-meteo-grid', kind: 'rest', expectedLane: 'A', sampleChars: 400, discovery: true, url: 'https://api.open-meteo.com/v1/forecast?latitude=52.5,48.9,41.9&longitude=13.4,2.3,12.5&current=temperature_2m', note: 'multi-point current temperature, keyless' },

  // --- Meteored, requested as a replacement for the temperature map --------
  // Meteored's developer product is api.tiempo.com and it requires a
  // registered affiliate key. Probed WITHOUT one on purpose: the refusal is the
  // evidence, and what it says decides whether this can be wired at all.
  //
  // The second thing being checked here is shape, not just access. Meteored's
  // documented product returns a forecast for a named locality, which is a very
  // different thing from the gridded field a world map needs. A source can be
  // perfectly alive and still be the wrong instrument.
  { id: 'meteored-api', kind: 'rest', expectedLane: 'B', needsKey: true, discovery: true, sampleChars: 700, url: 'https://api.tiempo.com/index.php?api_lang=en&localidad=3117735&affiliate_id=MAP_KEY_PLACEHOLDER', note: 'Meteored developer API; registration required — the refusal text is the finding' },

  // --- high-resolution weather, to replace the 20x15 degree grid -----------
  // The coarse grid was a request-budget decision, not a limit of the source.
  // These probe what Open-Meteo will actually answer at km scale and how much
  // can be asked for at once, since that is what sets the real resolution.
  { id: 'openmeteo-highres-models', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 1600, url: 'https://api.open-meteo.com/v1/forecast?latitude=46.8&longitude=8.2&current=temperature_2m&models=meteoswiss_icon_ch1,icon_d2,arome_france_hd,ukmo_uk_deterministic_2km,italia_meteo_arpae_icon_2i,ncep_hrrr_conus', note: 'DISCOVERY: which km-scale models answer, and how they are named in the response' },
  { id: 'openmeteo-rich-vars', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 2000, url: 'https://api.open-meteo.com/v1/forecast?latitude=45.5&longitude=9.2&current=temperature_2m,relative_humidity_2m,dew_point_2m,apparent_temperature,surface_pressure,pressure_msl,wind_speed_10m,wind_speed_80m,wind_speed_120m,wind_speed_180m,wind_direction_10m,wind_gusts_10m,shortwave_radiation,direct_radiation,diffuse_radiation,direct_normal_irradiance,terrestrial_radiation,cloud_cover,cape,visibility,precipitation,weather_code,is_day', note: 'DISCOVERY: the full current-variable set the map can offer as layers (note 5)' },
  { id: 'openmeteo-pressure-levels', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 1200, url: 'https://api.open-meteo.com/v1/forecast?latitude=45.5&longitude=9.2&hourly=temperature_850hPa,wind_speed_850hPa,wind_speed_250hPa,geopotential_height_500hPa&forecast_days=1&models=best_match', note: 'DISCOVERY: wind and temperature aloft — the "different altitudes" the note asks for' },
  { id: 'openmeteo-elevation-cell', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 700, url: 'https://api.open-meteo.com/v1/forecast?latitude=45.9764&longitude=7.6586&current=temperature_2m&cell_selection=nearest&models=best_match', note: 'DISCOVERY: does the response report the model cell’s own elevation and coordinates' },

  // --- real-time lightning -------------------------------------------------
  // Blitzortung is a volunteer detection network. Its data policy requires a
  // third-party app to serve its own clients from its own servers, so this is
  // Lane C by the SOURCE'S TERMS rather than for any technical reason —
  // `policyLane` records that, so the report does not call it a mismatch when
  // the handshake succeeds from a browser.
  //
  // A handshake alone proves nothing here: the stream is silent until it is
  // subscribed to. So this probe sends the subscription and waits for a real
  // frame, and the sample is what decides the parser.
  { id: 'blitzortung-ws', kind: 'ws', expectedLane: 'C', policyLane: 'C', subscribe: '{"time":0}', awaitMessage: true, sampleChars: 700, url: 'wss://ws1.blitzortung.org:3000/', note: 'real-time strikes; their policy requires serving our own clients from our own server' },
  { id: 'blitzortung-ws-alt', kind: 'ws', expectedLane: 'C', policyLane: 'C', subscribe: '{"time":0}', awaitMessage: true, sampleChars: 700, url: 'wss://ws7.blitzortung.org:3000/', note: 'second server, so one host being down is distinguishable from the network being gone' },
  // "Handshake failed" has at least three causes that need different fixes:
  // the port is unreachable from here, the host is gone, or the server rejects
  // the request. These separate them.
  //
  // The 443 variant matters for a second reason, and it is the one that decides
  // whether this feed is buildable at all: a Cloudflare Worker's `fetch` can
  // only reach a fixed set of ports, and 3000 is not among them. If Blitzortung
  // only speaks on 3000, a Worker relay cannot open the upstream connection
  // with `fetch` at all — which is exactly the kind of constraint that has to be
  // found before a design depends on it, not after.
  { id: 'blitzortung-tcp-3000', kind: 'rest', expectedLane: 'C', discovery: true, sampleChars: 300, url: 'https://ws1.blitzortung.org:3000/', note: 'DISCOVERY: is port 3000 reachable at all from here — separates a blocked port from a refused handshake' },
  { id: 'blitzortung-ws-443', kind: 'ws', expectedLane: 'C', policyLane: 'C', subscribe: '{"time":0}', awaitMessage: true, sampleChars: 700, url: 'wss://ws1.blitzortung.org/', note: 'DISCOVERY: does it also speak on 443 — the only ports a Cloudflare Worker fetch can reach' },
  { id: 'blitzortung-http-443', kind: 'rest', expectedLane: 'C', discovery: true, sampleChars: 300, url: 'https://ws1.blitzortung.org/', note: 'DISCOVERY: what answers on 443, if anything' },

  // Individually probed high-resolution models. A combined `models=` request
  // returns one merged answer, which cannot show WHICH model replied — and
  // "we used a 1 km model" is a claim that has to be checked per model rather
  // than assumed from a list that was accepted without complaint.
  { id: 'openmeteo-model-ch1', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 400, url: 'https://api.open-meteo.com/v1/forecast?latitude=46.8&longitude=8.2&current=temperature_2m&models=meteoswiss_icon_ch1', note: 'DISCOVERY: 1 km, Alps' },
  { id: 'openmeteo-model-icond2', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 400, url: 'https://api.open-meteo.com/v1/forecast?latitude=52.5&longitude=13.4&current=temperature_2m&models=icon_d2', note: 'DISCOVERY: 2.2 km, central Europe' },
  { id: 'openmeteo-model-arome', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 400, url: 'https://api.open-meteo.com/v1/forecast?latitude=48.9&longitude=2.3&current=temperature_2m&models=arome_france_hd', note: 'DISCOVERY: 1.5 km, France' },
  { id: 'openmeteo-model-hrrr', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 400, url: 'https://api.open-meteo.com/v1/forecast?latitude=40.7&longitude=-74.0&current=temperature_2m&models=ncep_hrrr_conus', note: 'DISCOVERY: 3 km, continental US' },
  { id: 'openmeteo-model-italia', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 400, url: 'https://api.open-meteo.com/v1/forecast?latitude=41.9&longitude=12.5&current=temperature_2m&models=italia_meteo_arpae_icon_2i', note: 'DISCOVERY: 2.2 km, Italy' },
  { id: 'openmeteo-model-ukmo', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 400, url: 'https://api.open-meteo.com/v1/forecast?latitude=51.5&longitude=-0.1&current=temperature_2m&models=ukmo_uk_deterministic_2km', note: 'DISCOVERY: 2 km, UK' },
  // How many coordinates one request will take decides the real map resolution,
  // since that is what sets how many samples a single refresh can afford.
  { id: 'openmeteo-multipoint-cap', kind: 'rest', expectedLane: 'A', discovery: true, sampleChars: 300, buildUrl: () => {
    const lats = [];
    const lons = [];
    for (let i = 0; i < 300; i += 1) {
      lats.push((35 + (i % 20) * 0.5).toFixed(2));
      lons.push((-10 + Math.floor(i / 20) * 0.5).toFixed(2));
    }
    return `https://api.open-meteo.com/v1/forecast?latitude=${lats.join(',')}&longitude=${lons.join(',')}&current=temperature_2m`;
  }, note: 'DISCOVERY: does a 300-coordinate request succeed — this sets the map’s achievable grid density' },
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
    // Some probes need a URL too long to write out by hand — a 300-coordinate
    // request, for instance. `buildUrl` generates it; everything else is a
    // plain literal, which stays far easier to read and to re-run by hand.
    const target = endpoint.buildUrl ? endpoint.buildUrl() : endpoint.url;
    const response = await fetch(target, {
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

    const timer = setTimeout(() => {
      // Distinguish "never connected" from "connected and then said nothing".
      // They have completely different causes and completely different fixes,
      // and reporting both as TIMEOUT would hide which one happened.
      const opened = socket && socket.readyState === WebSocket.OPEN;
      finish(
        opened
          ? { ok: false, status: 'SILENT', sample: `handshake accepted, but no frame within ${TIMEOUT_MS}ms` }
          : { ok: false, status: 'TIMEOUT', sample: `no open event within ${TIMEOUT_MS}ms` },
      );
    }, TIMEOUT_MS);

    try {
      socket = new WebSocket(endpoint.url);
    } catch (error) {
      finish({ ok: false, status: 'ERR', sample: String(error?.message ?? error) });
      return;
    }

    socket.addEventListener('open', () => {
      // Some streams are silent until subscribed to, and for those a handshake
      // proves only that a port is listening. Where a subscription is declared,
      // this sends it and waits for a real frame before claiming anything —
      // otherwise "OPEN" would be recorded for a source that never delivers.
      if (endpoint.subscribe) {
        try {
          socket.send(endpoint.subscribe);
        } catch (error) {
          finish({ ok: false, status: 'ERR', sample: `subscribe failed: ${String(error?.message ?? error)}` });
          return;
        }
      }
      if (!endpoint.awaitMessage) {
        finish({ ok: true, status: 'OPEN', sample: 'handshake accepted' });
      }
      // Otherwise wait for the message listener below, or the timeout.
    });

    if (endpoint.awaitMessage) {
      socket.addEventListener('message', (event) => {
        const raw =
          typeof event.data === 'string'
            ? event.data
            : `[binary frame, ${event.data?.byteLength ?? event.data?.length ?? '?'} bytes]`;
        finish({
          ok: true,
          status: 'DATA',
          sample: raw.slice(0, endpoint.sampleChars ?? 300).replace(/\s+/g, ' '),
        });
      });
    }
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

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const results = [];
let lastProbeEndedAt = 0;
for (const endpoint of selected) {
  // Sources that publish a cadence limit get it honoured. GDELT documents one
  // request every five seconds, and probing it four times in a row would
  // produce three 429s that say nothing about GDELT and everything about this
  // script. A report has to measure the source, not the prober.
  if (endpoint.minGapMs) {
    const waited = Date.now() - lastProbeEndedAt;
    if (waited < endpoint.minGapMs) await sleep(endpoint.minGapMs - waited);
  }

  const outcome = endpoint.kind === 'ws' ? await checkWebSocket(endpoint) : await checkHttp(endpoint);
  lastProbeEndedAt = Date.now();

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
  if (!reachable) {
    laneEvidence = '?';
  } else if (endpoint.policyLane) {
    // Some lanes are decided by the source's TERMS, not by what its wire
    // protocol permits. Blitzortung's handshake succeeds from a browser and its
    // data policy still requires a third-party app to serve its own clients
    // from its own servers. Reading only the technical evidence there would
    // conclude "Lane A" and be wrong in the way that gets a project blocked.
    laneEvidence = endpoint.policyLane;
  } else if (endpoint.kind === 'ws') {
    laneEvidence = endpoint.needsKey ? 'C' : 'A';
  } else {
    laneEvidence = outcome.corsOk && !endpoint.needsKey ? 'A' : 'B';
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
