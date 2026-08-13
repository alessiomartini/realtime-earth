# The Real-Time Earth

A modular catalog of live global data feeds. The thesis: right now, humanity has
an unprecedented amount of high-quality real-time data publicly available — this
site shows a live sample of it, unmodified.

**Status: step 3 of 7 — four live feeds.** Deployed at
<https://realtime-earth.alemarti-2001.workers.dev>.

The home page is a grid of tiles, one per feed, each linking to that feed's own
page at `/m/<id>` with the full chart or map. Feeds open with history from their
source's own endpoint where one exists, then continue live.

| Feed | Transport | History on open |
| --- | --- | --- |
| Bitcoin trades | WebSocket, tick-by-tick | 180 one-minute closes (Binance klines) |
| Global seismicity | poll, 60s | past 24h (USGS all_day) |
| Surface temperature | poll, 15 min | none — current field only |
| Wikipedia edits | Server-Sent Events | none available; opens empty and says so |

Verified against the deployed site by `scripts/verify-live.mjs`, which drives a
real browser after every deploy and daily. The development sandbox has no
outbound network, so that job is the only place the claim "the feeds work" can
honestly be made.

## Adding a module

One new file under `src/modules/`, and one import line in
`src/modules/all.ts`. Nothing else. (The import list deliberately lives in
`all.ts` rather than in `registry.ts`: ES imports are hoisted, so importing a
feed from `registry.ts` would run its `register()` call before the registry Map
existed, and the whole site would fail to start.) Extend `BaseModule`, which supplies
the counters, health, staleness watchdog and reconnect backoff, and implement
three methods:

```ts
class MyModule extends BaseModule {
  mount(el: HTMLElement) { /* render your chrome once */ }
  protected openStream() { /* open the transport */ }
  protected closeStream() { /* close it, fully */ }
}
register(new MyModule());
```

Inside the transport, call `this.markReceived(sourceTimestamp)` for each
message actually received, and `this.fail(reason)` when it breaks. Pass `null`
as the timestamp if the payload carries none — never `Date.now()`, which would
present our own latency as the data's freshness.

`staleAfterMs` should be about 3× the expected cadence. That is what turns a
feed going quiet into a visible `stale` state instead of a stale value shown as
current.

## Founding principles

These override convenience everywhere in this codebase.

1. **Displayed values are received values.** Never render a datum that was not
   actually received from the source. No interpolation, extrapolation, dead
   reckoning, smoothing, tweening or synthetic fill. If data arrives in jumps,
   it is displayed in jumps. The stutter is the signal.
2. **Gaps are shown as gaps.** Missing data is rendered as missing, never as a
   continued last value or a projected one.
3. **Never fabricate.** No mock feeds, no placeholder series, no demo mode. A
   source that is down or gated shows an honest error with the reason.
4. **Latency is labelled truthfully**, including for proxied and cached feeds.
5. **Provenance is visible.** Every number traces to a named, licensed,
   attributed source, carrying the source's own timestamp — never the fetch
   time.

## Hosting model

A **single Cloudflare Worker** serves everything:

| Path        | Served by                                     |
| ----------- | --------------------------------------------- |
| `/`, assets | the Wrangler `assets` binding (the Vite build) |
| `/api/*`    | the Worker script (Lane B proxy/cache routes)  |
| `/ws/*`     | the Worker script (Lane C Durable Object relay) |

One origin means no CORS between our own pieces, one deploy, and no API keys in
the client bundle. `run_worker_first` in `wrangler.jsonc` restricts Worker
invocation to `/api/*` and `/ws/*`; everything else is served asset-first.

## The three lanes

Every feed uses exactly one:

- **Lane A — DIRECT.** The browser opens the stream itself: keyless and
  CORS-enabled WebSocket / SSE / REST poll. Preferred.
- **Lane B — WORKER PROXY.** `/api/<module-id>` injects the API key, normalizes
  the payload, and caches. For key-gated or CORS-blocked sources. Slow-moving
  sources use a `scheduled` handler writing to KV instead.
- **Lane C — DURABLE OBJECT RELAY.** `/ws/<module-id>`: the Worker holds one
  upstream WebSocket and fans it out to browser clients. For key-gated
  *streams* — currently only AIS.

A source qualifies for Lane A only if it is keyless **and** returns an
`access-control-allow-origin` that permits a browser origin. `npm run
verify:endpoints` checks exactly that, per source.

## Commands

```sh
npm install

npm run dev               # Vite dev server (frontend only; /api/* does not exist here)
npm run preview           # build + `wrangler dev` — the full stack on one origin
npm run check             # typecheck client and worker
npm test                  # unit tests for the core machinery
npm run build             # Vite build into dist/client
npm run audit:bundle      # fail if anything credential-shaped is in the build
npm run verify:endpoints  # check every candidate source: status, CORS, lane
npm run deploy            # build + wrangler deploy
```

### Verifying sources before wiring them

`npm run verify:endpoints` is the gate the project rule demands: before wiring
any endpoint, verify it works. It reports HTTP status, the
`access-control-allow-origin` header, WebSocket handshake success, and whether
the evidence contradicts the lane the spec assumed.

```sh
npm run verify:endpoints            # everything
npm run verify:endpoints -- usgs    # by id substring
npm run verify:endpoints -- --json  # machine-readable
```

It needs unrestricted outbound network access, so it also runs as a GitHub
Actions job (`.github/workflows/verify-endpoints.yml`) on push, weekly, and on
demand. The job's log and its `endpoint-verification` artifact are the evidence
of record. A failure is a finding, not a bug to code around: substitute the
source, or show an honest error in the module.

### Verified source status

Last full run: 2026-08-10, 23 of 27 endpoints reachable. Four findings
contradict the original design and change what gets built:

| Source | Verified result | Consequence |
| --- | --- | --- |
| `stream.binance.com` | **451**, "Service unavailable from a restricted location" | Geo-restriction, not an outage. Use `wss://data-stream.binance.vision` (handshake accepted); the module must still show an honest error for visitors who are themselves blocked. |
| `api.adsb.lol`, `opendata.adsb.fi` | 200, **no CORS header** | Cannot be Lane A, despite the design assuming they were the CORS-friendly ones. `api.airplanes.live` returns `*` and is the Lane A ADS-B source. |
| `opensky-network.org` | 200, CORS restricted to its own origin | Lane B only. |
| SWPC `/products/solar-wind/` | **Directory does not exist** | DSCOVR ingest stopped in favour of SOLAR-1. Replacements verified: `/json/rtsw/`, plus `/products/summary/solar-wind-{speed,mag-field}.json`. |
| `stooq.com` CSV | 404 on every keyless path | Requires an API key since ~2026-04-01, issued only by emailing `www@stooq.com`. **Blocked** until that key exists. |
| GDELT DOC 2.0 | 429, "one request every 5 seconds" | Live, with a documented cadence limit — exactly why it belongs in Lane B behind a `scheduled` handler. |
| NASA FIRMS | 400, "Invalid MAP_KEY" | Gate is real and working; needs `FIRMS_MAP_KEY`. |

Confirmed Lane A (keyless, CORS `*`): Coinbase, RIPE RIS Live, mempool.space,
airplanes.live, Carbon Intensity (intensity + generation), SWPC K-index and GOES
X-ray, USGS (hour + day), Wikimedia SSE, Ethereum public RPC. AIS Stream accepts
the handshake, confirming Lane C.

Note on where the probe runs: CI uses a US-based runner, so a geo-refusal there
describes the runner's location, not necessarily a visitor's browser. Binance is
the known case.

## Deployment

CI is `.github/workflows/deploy.yml`. It
typechecks, builds, audits the bundle for secrets, and on `main` deploys with
`cloudflare/wrangler-action`.

Two repository secrets are required before the first deploy succeeds:

| Secret                  | Where to get it                                           |
| ----------------------- | --------------------------------------------------------- |
| `CLOUDFLARE_API_TOKEN`  | Cloudflare dashboard → API Tokens → *Edit Cloudflare Workers* |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare dashboard → Workers & Pages → account ID        |

Feed API keys are **never** repository-committed or bundled. They are set with
`wrangler secret put <NAME>` and read only inside `worker/`. Every secret name
this project uses is listed in `scripts/check-bundle-secrets.mjs`, which fails
the build if the name or a credential-shaped literal appears in the client
output.

## Layout

```
index.html                        page shell
src/main.ts                       entry point: thesis, principles, catalog
src/styles.css                    instrument-panel styling

src/core/types.ts                 the module contract
src/core/base-module.ts           counters, health, staleness, reconnect
src/core/lifecycle.ts             who is allowed to be connected, and when
src/core/ring-buffer.ts           fixed-capacity buffer — the hard memory bound
src/core/backoff.ts               exponential backoff with full jitter
src/core/core.test.ts             unit tests for the above

src/modules/registry.ts           one import line per feed

src/ui/card.ts                    card shell, collapse/expand, error display
src/ui/status-strip.ts            transport, lane, latency, health, count, age
src/ui/catalog.ts                 sections, filters, sort, global counter, pause
src/ui/dom.ts                     element helper and duration formatting

worker/index.ts                   the single Worker: assets + /api/* + /ws/*
wrangler.jsonc                    Worker + assets configuration
scripts/verify-endpoints.mjs      source verification gate
scripts/check-bundle-secrets.mjs  "no secrets in the bundle" acceptance check
```

## Order of work

1. ✅ Scaffold: Vite + TS, one Worker serving assets and routes, CI deploy.
2. ✅ Module contract, registry, card shell, status strip, lifecycle manager
   (lazy connect, pause, backoff, staleness).
3. Reference modules covering the direct transports: USGS (poll), Wikipedia
   (SSE), Binance (WebSocket).
4. Lane B: Worker proxy route pattern, `scheduled` handler, KV storage, and one
   proxied module.
5. Lane C: the AIS Durable Object relay and its map module.
6. Remaining modules, section by section.
7. Full README: how to add a module in under 20 lines, plus a table of every
   source with license, lane and latency class.
