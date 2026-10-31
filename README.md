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

## The notebook

A **Notes** button on every page lets Alessio jot a comment or idea while
actually using the site, from whichever page prompted it. Notes go to the
shared `site-notes` Worker (repo `alessiomartini/site-notes`), which only accepts
new notes: nothing can be read back over HTTP, so no visitor can see what was
written. Claude reads them from the D1 and turns them into `ROADMAP.md` items. See `scripts/notes.md` for the full
design, including why notes are queued in `localStorage` first so a failed
request never loses a note.

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

## Data sources

Every source the app uses or plans to use. Lanes are defined in [The three
lanes](#the-three-lanes); reachability and CORS findings for each endpoint are in
[Verified source status](#verified-source-status), not repeated here.

How to read the table:

- **Cadence** is what the module itself declares (`cadence` in its source) or,
  for Worker-proxied sources, the cron in `wrangler.jsonc`. For sources not yet
  wired it is "to verify" — no cadence is claimed without evidence.
- **Licence / terms** marked **(verified)** was checked against the provider's own
  page on 2026-10-22. Entries marked **(as declared in module)** are the string
  the module shows on its card (`source.license`) and have not been independently
  re-checked. Everything else is "to verify": do not rely on it.

### Live (shipped modules)

| Source | What it provides | Endpoint (host) | Lane | Typical latency / cadence | Licence / terms | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Binance | BTC/USDT trades, plus 180 one-minute klines of history | `data-stream.binance.vision` (WS), `data-api.binance.vision` (REST) | A | live; ~10–50 trades/s | Public market data, free for non-commercial use per Binance terms (as declared in module) 2026-10-31 audit: no terms page for the `binance.vision` endpoints could be fetched, so the declaration is **not confirmed**. See [Licence audit](#licence-audit-2026-10-31). | live (geo-restricted for some visitors; see status section) |
| USGS Earthquake Hazards | Global earthquakes, past 24h then live | `earthquake.usgs.gov` | A | near-real-time; polled every 60 s | Public domain, U.S. Government work (verified: USGS-authored data is U.S. public domain; non-USGS material on USGS sites may not be) | live |
| Open-Meteo | Surface weather model field on a zoomable grid (17 fields) | `api.open-meteo.com` | A | near-real-time; model output, polled every 10 min | CC BY 4.0; free API for non-commercial use only, under 10,000 calls/day, 5,000/hour, 600/minute (verified) | live |
| Wikimedia EventStreams | Every edit to every Wikimedia wiki (`recentchange`) | `stream.wikimedia.org` | A | live; ~3–10 edits/s | No data licence stated by the provider; the module no longer claims CC0. Service is meant for small-scale external tools. 2026-10-31 audit: neither the EventStreams docs nor its OpenAPI spec state a data licence (the spec's Apache-2.0 is the service code; terms point to the Wikimedia Terms of Use): **still unclear**. See [Licence audit](#licence-audit-2026-10-31). | live |
| Blitzortung.org | Lightning strikes detected by a volunteer network | `ws1.blitzortung.org` (upstream), `/ws/lightning-strikes` (our relay) | C | live; continuous, bursty | Free for non-commercial use, with attribution (as declared in module). Their policy asks apps to serve their own clients from their own server, hence Lane C. 2026-10-31 audit: the page found only says raw data is free for participating station owners for non-commercial use; the module's terms are **not confirmed**. See [Licence audit](#licence-audit-2026-10-31). | live |
| GDELT Project | News articles indexed by GDELT DOC 2.0 (last hour, then refreshes) | `api.gdeltproject.org` | B | delayed; Worker refreshes every 15 min, index runs about 35–45 min behind real time | Open data, free for any use with attribution (as declared in module). API limit documented as one request every 5 s. 2026-10-31 audit: gdeltproject.org/about.html: unrestricted use including commercial, redistribution allowed, citation and link to the GDELT website required (**verified, ok with attribution**). | live |
| Meteored (tiempo.com) | Current conditions for one locality | `api.tiempo.com` | B | delayed; Worker refreshes every 30 min | Requires a registered, activated account; used under their API terms (as declared in module); exact terms to verify 2026-10-31 audit: only the general site terms were readable; they allow redistribution only for personal, non-commercial purposes with source citation and hyperlink, and forbid corporate redistribution and AI training. API-specific terms not retrievable: **still unclear**. See [Licence audit](#licence-audit-2026-10-31). | blocked (needs `METEORED_AFFILIATE_ID`) |
| NASA FIRMS | Active fire detections (VIIRS NOAA-20 NRT, world, last day; Suomi NPP production ends 2026-11-02) | `firms.modaps.eosdis.nasa.gov` | B | Worker refreshes hourly; satellite pass cadence to verify | NASA ESDIS: data are CC0 unless marked otherwise; NASA to be acknowledged as source, no implied endorsement (verified 2026-10-31). MAP_KEY limit 5,000 transactions per 10 minutes: **ok with attribution**. See [Licence audit](#licence-audit-2026-10-31). | blocked (needs free `FIRMS_MAP_KEY`; route registered, no module yet) |
| NOAA SWPC planetary K-index | Geomagnetic activity, 3-hour Kp bins, about a week of history | `services.swpc.noaa.gov` | A | near-real-time; polled every 5 min, source bins are 3 h (newest may be in progress) | Public domain, U.S. Government work (verified: weather.gov/disclaimer, linked from swpc.noaa.gov: NWS/NOAA pages are public domain unless noted) | live |
| NOAA SWPC GOES X-ray flux | Solar X-ray flux (0.1-0.8 nm), 24 h of 1-minute values; flare class | `services.swpc.noaa.gov` | A | near-real-time; polled every 60 s, source resolution 1 min; zero-flux minutes shown as gaps | Public domain, U.S. Government work (verified: weather.gov/disclaimer, linked from swpc.noaa.gov) | live |
| NOAA SWPC real-time solar wind | Proton speed and density, magnetic field Bt and Bz (GSM), about 24 h of 1-minute values | `services.swpc.noaa.gov` | A | near-real-time; polled every 60 s, source resolution 1 min; only rows SWPC flags `active` are used | Public domain, U.S. Government work (verified: weather.gov/disclaimer, linked from swpc.noaa.gov) | live |

### Planned (verified reachable, not yet wired to a module)

Status of each is in [Verified source status](#verified-source-status). Cadence
is "to verify" for all of them; licence findings from the 2026-10-31 audit are in each row and in [Licence audit](#licence-audit-2026-10-31).

| Source | What it provides | Endpoint (host) | Lane | Typical latency / cadence | Licence / terms | Status |
| --- | --- | --- | --- | --- | --- | --- |
| Coinbase Exchange | Trade `matches` channel, second Bitcoin venue | `ws-feed.exchange.coinbase.com` | A | to verify | Docs say the Market Data API is under Coinbase's "Market Data Terms of Use"; that page could not be fetched (HTTP 403), so terms unread: **still unclear**. See [Licence audit](#licence-audit-2026-10-31). | planned |
| mempool.space | Unconfirmed transactions, fee bands, blocks | `mempool.space` | A | to verify | Code is AGPL-3.0; the Terms of Service (July 2024 text from the project repo) give no warranty and state no data licence or API rate limit: **still unclear**. See [Licence audit](#licence-audit-2026-10-31). | planned |
| Ethereum public RPC (PublicNode) | Block number, base fee, gas used | `ethereum-rpc.publicnode.com` | A | to verify | PublicNode ToS cover the website service only (revocable, non-transferable licence); no data licence or RPC usage limits stated: **still unclear**. See [Licence audit](#licence-audit-2026-10-31). | planned |
| RIPE RIS Live | BGP UPDATE stream | `ris-live.ripe.net` | A | to verify | RIS Live manual states no licence; the RIPE Data Repository terms (non-commercial research, no redistribution) are written for raw-data accounts and their applicability to RIS Live is not stated: **still unclear**. See [Licence audit](#licence-audit-2026-10-31). | planned |
| airplanes.live | ADS-B aircraft positions | `api.airplanes.live` | A | to verify | Site and API guide blocked by a bot challenge (HTTP 403) from this environment, terms unread: **still unclear**. See [Licence audit](#licence-audit-2026-10-31). | planned |
| adsb.lol, adsb.fi | ADS-B aircraft positions | `api.adsb.lol`, `opendata.adsb.fi` | B (no CORS header) | to verify | adsb.lol: ODbL 1.0 (stated on its API page). adsb.fi: personal, non-commercial use only, must cite adsb.fi with a link, no sublicensing (its README). See [Licence audit](#licence-audit-2026-10-31). | planned (alternatives to airplanes.live) |
| OpenSky Network | ADS-B / Mode S states | `opensky-network.org` | B (CORS restricted to its own origin) | to verify | **Not usable as is**: commercial use and any operational REST API use (live product or service) need a written licence from OpenSky, even for non-profits. See [Licence audit](#licence-audit-2026-10-31). | planned, rate-limited |
| AIS Stream | Ship positions (AIS) | `stream.aisstream.io` | C | to verify | Docs state no data licence or terms link; direct browser connections are forbidden (proxy only), max 3 connections per account: **still unclear**. See [Licence audit](#licence-audit-2026-10-31). | planned (needs API key; handshake verified) |
| Carbon Intensity (UK) | Grid carbon intensity and generation mix | `api.carbonintensity.org.uk` | A | to verify | CC BY 4.0 plus API Terms of Use (no resale, no replacing the operator's own service, no implied endorsement): **ok with attribution**. See [Licence audit](#licence-audit-2026-10-31). | planned |
| Stooq | Equity and index quotes (CSV) | `stooq.com` | B | to verify | Terms pages not reachable from this environment: **still unclear** (source is blocked on a key anyway). See [Licence audit](#licence-audit-2026-10-31). | blocked (API key issued only by email to `www@stooq.com`) |

### Licence audit (2026-10-31)

Each provider's own terms were fetched and read on 2026-10-31 (an automated pass
from a sandbox with no browser; pages that block bots or render only in
JavaScript could not be read, and those sources are marked **still unclear**
rather than guessed). This is a reading of the published text, not legal advice.
Verdicts: **ok** = usable as is; **ok with attribution** = usable if the stated
credit is shown; **not usable** = needs an agreement we do not have; **still
unclear** = no licence found, or the terms page could not be read.

| Source | Terms page read | What it says | Attribution | Commercial / redistribution limits | Verdict |
| --- | --- | --- | --- | --- | --- |
| NOAA SWPC | `weather.gov/disclaimer` (linked from swpc.noaa.gov) | NWS web pages are public domain unless noted | Do not claim it as your own; no implied endorsement | None beyond that | ok (already live) |
| Carbon Intensity (UK) | `github.com/carbon-intensity/terms` (linked from carbonintensity.org.uk) | CC BY 4.0 | Required (CC BY) | No sale or sublicensing; must not replace the operator's own service; no implied endorsement; licence revocable | ok with attribution |
| NASA FIRMS | `earthdata.nasa.gov/engage/open-data-services-software-policies/data-use-guidance`; `firms.modaps.eosdis.nasa.gov/api/area/` | CC0 unless marked; free `MAP_KEY`, 5,000 transactions per 10 minutes | NASA acknowledged as source; citation strongly urged | No restrictions on use; no implied NASA endorsement | ok with attribution (needs the key) |
| GDELT | `gdeltproject.org/about.html` | Unlimited, unrestricted use, commercial included | Citation and link to gdeltproject.org required | Redistribution and mirroring allowed | ok with attribution |
| adsb.lol | `adsb.lol/docs/open-data/api` | "license: ODbL 1.0"; API open to everyone, key promised for the future | ODbL attribution | ODbL share-alike applies to derived databases; no CORS header, so Lane B only | ok with attribution (ODbL) |
| adsb.fi | `github.com/adsbfi/opendata` README | Personal, non-commercial use only | Cite adsb.fi with a link to its home page | No licensing, selling, renting or leasing; public endpoints 1 request per second | ok with attribution for non-commercial use only; see decision in ROADMAP |
| OpenSky Network | `opensky-network.org/about/terms-of-use` | Written licence needed for any commercial use and for operational REST API use (live product or service), even non-profit | n/a | Redistribution not granted | not usable without a written agreement |
| Meteored | `meteored.com/legal` (general terms, Feb 2026) | Redistribution only for personal, non-commercial purposes; no scraping, corporate redistribution or AI training | Source citation plus active hyperlink | Non-commercial only | still unclear: API-specific terms are in a JavaScript dashboard that could not be read |
| Wikimedia EventStreams | `stream.wikimedia.org/?spec`, wikitech EventStreams page | No data licence stated; terms point to the Wikimedia Terms of Use; Apache-2.0 refers to the service code | Not stated | Connections are cut after 15 minutes (reconnect with Last-Event-ID) | still unclear: CC0 not confirmed |
| mempool.space | `mempool/mempool` repo (`LICENSE`, Terms of Service component) | AGPL-3.0 for code; trademarks reserved; service provided as is | Not stated | No data licence or API limits stated | still unclear |
| PublicNode (Ethereum RPC) | `publicnode.com/terms` | Website terms: revocable, non-transferable licence | Not stated | No RPC usage limits or data licence stated | still unclear |
| RIPE RIS Live | `ris-live.ripe.net/manual/`; `ripe.net/about-us/legal/ripe-data-repository-terms-and-conditions` | Manual states no licence and no authentication; the Data Repository terms limit raw data to scientific or network-operations research, no commercial use, no redistribution | Not stated | See previous column | still unclear (the terms may not apply to RIS Live) |
| Coinbase Exchange | `coinbase.com/legal/market_data` (named by the API docs) | Page returned HTTP 403 | Unknown | Unknown | still unclear |
| airplanes.live | `airplanes.live` (API guide) | Bot challenge, HTTP 403 | Unknown | Unknown | still unclear |
| AIS Stream | `aisstream.io/documentation` | No terms link found; API key required; no direct browser connections; 3 connections per account and per IP | Unknown | Unknown | still unclear |
| Blitzortung | `blitzortung.org/en/cover_your_area.php` | Raw data free to participating station owners for non-commercial use; no relay policy found | Unknown | Unknown | still unclear: module declaration not confirmed |
| Binance | docs on `github.com/binance/binance-spot-api-docs` (market-data-only URLs) | Describes the `binance.vision` hosts as public market data, but states no licence | Unknown | Unknown | still unclear |
| Stooq | `stooq.com` | Not reachable | Unknown | Unknown | still unclear (also blocked on a key) |

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

See `ROADMAP.md` for what is left on this roadmap, known
and per-source blockers.

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
