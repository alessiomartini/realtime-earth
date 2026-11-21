# Roadmap

<!--
Single file for todos, ideas, decisions and diary, read by Projects Overview
(https://alessiomartini.github.io/projects-overview/). Protocol: templates/ROADMAP.md of projects-overview.
-->

## Roadmap
- [x] Scaffold: Vite + TS, Worker, deploy in CI
- [x] Module contract, registry, lifecycle manager
- [x] First four live feeds
- [x] Lane B: proxy in the Worker, `scheduled` handler, KV (code and tests complete: `worker/proxy.ts`, `worker/proxy-flow.test.ts`)
  - [ ] Check that the `FEED_CACHE` namespace id in `wrangler.jsonc` is the real one of Alessio's Cloudflare account
  - [ ] Set the `FIRMS_MAP_KEY` and `METEORED_AFFILIATE_ID` secrets (Alessio's keys are needed)
- [x] Lane C: AIS relay with Durable Object and map module (code and tests complete: `worker/ais-relay.ts`, `src/modules/ais-vessels.ts`; the Blitzortung relay in `worker/lightning-relay.ts` is the precedent to follow)
  - [ ] Set the AISSTREAM_API_KEY secret and deploy (Alessio)
- [ ] Remaining modules, section by section (source status in the "Verified source status" table of the README)
  - [x] NOAA SWPC planetary Kp index (`src/modules/swpc-kp.ts`, Lane A, public domain)
  - [x] NOAA SWPC GOES X-ray flux (`src/modules/swpc-xray.ts`, Lane A, public domain)
  - [x] NOAA SWPC solar wind, speed and Bz (`src/modules/swpc-wind.ts`, Lane A, public domain)
  - [x] Carbon intensity and generation mix of the GB grid (`src/modules/carbon-intensity.ts`, Lane A, CC BY 4.0 with attribution)
  - [x] Aircraft from adsb.lol (Lane B, ODbL 1.0, `src/modules/adsb-lol-aircraft.ts` + source in `worker/proxy.ts`): 250 nm circle around 50°N 8°E; merged but disabled until the `ADSB_LOL_API_KEY` secret exists (without a key no request goes to adsb.lol, the module says it is not configured)
  - [ ] Alessio: ask adsb.lol for a free key and add it with `wrangler secret put ADSB_LOL_API_KEY`; first, check in the adsb.lol docs the exact name of the key header (`ADSB_LOL_KEY_HEADER` in `worker/proxy.ts`, currently `x-api-key`, not verified)
- [x] Complete README with source table (license, lane, latency)
- [ ] Verify the licenses of the sources marked "to verify" in the README (2026-11-07: second automatic read, no new readable terms except Wikimedia; the manual sub-items remain) (planned sources; Wikimedia CC0, FIRMS, Meteored and the licenses declared in the modules without a check on the provider's site)
  - [ ] Coinbase Exchange: read the "Market Data Terms of Use" (`coinbase.com/legal/market_data`, 403 response from the automated environment), from a real browser
  - [ ] airplanes.live: read the API terms (anti-bot challenge, 403 from the automated environment)
  - [ ] mempool.space and PublicNode (Ethereum RPC): they declare neither a data license nor usage limits; consider writing to them or using an alternative with an explicit license
  - [ ] RIPE RIS Live: ask (rislive@ripe.net) whether the terms of the RIPE Data Repository (research only, no commercial use or redistribution) also apply to RIS Live
  - [ ] Meteored: read the API-specific terms (in the JavaScript dashboard); the general terms only allow non-commercial redistribution with citation and link
  - [ ] AIS Stream, Stooq, Binance (`binance.vision`), Blitzortung: no readable terms page; verify by hand
  - [ ] Wikimedia EventStreams: the module's `source.license` now says that no data license is declared by the provider (no longer CC0); find a provider page that fixes the license and update it
  - [x] Decide whether adsb.fi (personal non-commercial use only) is acceptable for this site; adsb.lol (ODbL 1.0) yes with attribution (2026-11-07, Alessio: yes, the site is personal; cite adsb.fi)
  - [ ] OpenSky: waiting for a reply to the request for permission for the REST API (draft in Gmail of 2026-11-07, to contact@opensky-network.org); until a written yes arrives, no OpenSky
  - [x] FIRMS: confirmed by the FIRMS team blog (2026-10-27): production of new Suomi NPP data ends on 2026-11-02 at 13:00 UTC; the source moves to `VIIRS_NOAA20_NRT` (NOAA-21 remains an equivalent alternative)
- [x] Binance: honest error for geo-blocked visitors instead of assuming the workaround works

## Ideas
- [ ] Observatory of the world's flows (maybe to grow here, which is already a catalog of live feeds). Data to track:
  - maritime traffic
  - air traffic
  - road traffic
  - rail traffic
  - tourism and business travel
  - internet usage
  - electricity: quantity and sources
  - environment: air, soil, humidity, temperature, wind, UV exposure
  - other: …

- [x] Centralized feedback: a single D1 + Worker shared by all sites (done on 2026-10-19: `site-notes`, details below)
- [ ] Idea (Google Tasks, 2026-11-14, Alessio's words): "Fare una machine learning model che faccia clustering quindi credo sia anzi propice learning con i dati dei voli in tutto il mondo e con i dati delle navi di tutto il mondo"
- [ ] Note from the site (2026-08-29, Bitcoin page): besides Binance, other Bitcoin markets (e.g. Coinbase, Kraken, Bitstamp, which have public WebSocket feeds), possibly side by side to compare prices

## Decisions and things tried

### License audit (2026-10-31)

Read the providers' terms (README, section "Licence audit"). Outcome: ok with attribution for Carbon Intensity (CC BY 4.0), FIRMS (CC0 unless stated otherwise, NASA cited as source), GDELT (citation and link) and adsb.lol (ODbL); not usable without a written agreement OpenSky (commercial use or operational REST); adsb.fi personal non-commercial use only. Everything else stays "still unclear" because the terms page cannot be read from an automated environment (403, anti-bot challenge, JavaScript-only page) or declares nothing: nothing was inferred. The generic item stays open until the sub-items are resolved.

Second pass (2026-11-07): Coinbase and airplanes.live still 403, Stooq and the Meteored dashboard without text, AIS Stream and Blitzortung reread with no license or attribution declared. Wikimedia: `dumps.wikimedia.org/legal.html` assigns CC0 only to Wikidata structured data and Analytics datasets, does not mention EventStreams: the module stays without CC0. No new incompatibility; the sub-items stay open because a real browser or an email to the providers is needed.

Third pass Wikimedia EventStreams (2026-11-21, official pages, no data license found; the module reads `type`, `wiki`, `title`, `bot`, `length`, timestamp of `recentchange`): `wikitech.wikimedia.org/wiki/Event_Platform/EventStreams` and `.../EventStreams_HTTP_Service` only have the footer "Text is available under the Creative Commons Attribution-ShareAlike License; additional terms may apply." (it applies to the wiki page text, not to the stream); `foundation.wikimedia.org/wiki/Policy:Terms_of_Use` does not cover metadata or CC0 (only the waiver of database rights on CC BY-SA content); `foundation.wikimedia.org/wiki/Policy:Wikimedia_Foundation_API_Usage_Guidelines`: "Follow the requirements of the content licenses when republishing downloaded or cached data." (it refers to the content licenses, without fixing one for the metadata); `meta.wikimedia.org/wiki/Wikimedia_Foundation_Terms_of_Use` and `meta.wikimedia.org/wiki/Data_dumps/Legal` not reachable (404). No page fixes the license of the payloads: `source.license` and README unchanged, sub-item open (still to ask Wikimedia or to find a page on Analytics data that names `recentchange`).

### Aircraft from adsb.lol (2026-11-14)

Single bounded query: `/v2/point/50/8/250` (250 nm circle, the maximum accepted, around central Europe; about 1100 aircraft, 580 KB raw reduced to about 190 KB by keeping only the drawn fields, with a cap of 2000 aircraft). Without a key the documented limit is 500 requests per day per IP: a 15-minute cadence = 96 per day, so I reuse the GDELT cron slot (`4,19,34,49 * * * *`) and `wrangler.jsonc` does not change; the cadence is declared "delayed". The map does not move the aircraft between one update and the next. In the flow test the slot now starts two sources. Note: on the `adsb.lol` page (not on the API) a banner says that automated clients should use the API with a key; if the per-IP limit shared on Cloudflare gives 429, ask for a free key (`x-api-key`) and set it as a secret. Update 2026-11-21: since adsb.lol asks automated clients for the key, the source is behind the optional secret `ADSB_LOL_API_KEY` (like FIRMS and Meteored: `buildUrl` returns `missing`, the cron makes no request, the route answers 503 with the secret name); the deploy smoke test accepts 200 or 503.

### Detail of steps 4–7 (from the README)

Steps 4–7 (step 4, Lane B, is implemented; see the code in `worker/proxy.ts`):

4. Lane B: Worker proxy route pattern, `scheduled` handler, KV storage, and
   one proxied module.
5. Lane C: the AIS Durable Object relay and its map module (the lightning
   relay for Blitzortung already exists as a Lane C precedent — see
   `worker/lightning-relay.ts` — so AIS can follow the same shape).
6. Remaining modules, section by section — see the "Verified source status"
   table in `README.md` for which sources are confirmed reachable and on
   which lane, including the ones blocked on a key (Stooq, NASA FIRMS) or on
   a geo-restriction workaround (Binance).
7. Full README pass: a table of every source with license, lane and latency
   class — the current README covers four shipped feeds plus the verified
   candidates, not the full catalog envisioned in step 7.

### Blocked sources

From the last full `npm run verify:endpoints` run (2026-08-10, see README):

- **Stooq CSV** — needs an API key issued only by emailing `www@stooq.com`.
  Blocked until that key exists.
- **NASA FIRMS** — needs `FIRMS_MAP_KEY`; gate confirmed working, key not yet
  obtained.
- **Binance WebSocket** — geo-restricted (451) from the CI runner and from
  some visitor locations; already worked around with
  `wss://data-stream.binance.vision`, but the module still needs to show an
  honest error for visitors who are themselves blocked rather than assuming
  the workaround always succeeds.

Re-run `npm run verify:endpoints` periodically (it also runs on a schedule in
CI) — this table goes stale as soon as a source changes its API.

### Centralized feedback (done on 2026-10-19: single `site-notes` backend)

The notebook now writes to `site-notes` (repo `alessiomartini/site-notes`, `site = 'realtime-earth'`),
initially as a private site (token also needed to write). Then, the same day, **write-only and no
token**: Alessio does not need the page to read the notes back, he needs Claude to read them from the D1 and bring them into
this ROADMAP; the notebook now shows only the notes not yet sent. Removed
`worker/notes.ts`, `/api/notes`, the `NOTES_DB` binding, the secret upload and the notebook check in the
deploy. The `realtime-earth-notes` D1 and the `NOTES_TOKEN` secret were switched off after the migration.
The text below is the earlier discussion, kept as history.


This site already has a "notebook" (`worker/notes.ts`, D1 table `notes(id,
body, page, status, created_at, done_at)`, see also `scripts/notes.md`).
**It is not public visitor feedback**: it is a note box for
Alessio himself while he uses the site, protected by a `NOTES_TOKEN` that the
Worker requires on *every* method (GET/POST/PATCH/DELETE) and for which the Worker
fails CLOSED if the token is not configured — nobody writes without
knowing the passphrase, even though the "Notes" button is visible to anyone
visiting the site.

Idea, not decided: consolidate into a **single D1 database shared by all
of Alessio's sites** (including `markets-first-principles`, which has the same
pattern in `worker/schema.sql`), behind a **single Worker** with a CORS
allowlist per calling domain, with a schema like
`notes(id, site, page, text, created_at, ...)` instead of one D1 + Worker per
site.

**Pros:**
- Less Cloudflare infrastructure to maintain (one D1, one Worker, one deploy
  workflow instead of N).
- A single place to read all the notes of all sites, instead of
  querying a different D1 for each.

**Cons:**
- A bug in the shared Worker breaks note collection everywhere, not just on one
  site — today a problem in the `realtime-earth` notebook does not touch
  `markets-first-principles` and vice versa.
- The existing history (`realtime-earth-notes` and the equivalent of
  `markets-first-principles`) must be migrated to the new schema with a `site` column.
- The per-token/per-site authentication mechanism would need rethinking: today
  each Worker has its own `NOTES_TOKEN`; a shared Worker would still have to
  keep failing CLOSED and not expose a public read endpoint,
  a principle this project treats as non-negotiable (see
  `worker/notes.ts` and `scripts/notes.md`, section "Why it is gated").

**Low priority** — the current system works, there are no known bugs, and steps 4-7
of the roadmap above are more urgent. Do not implement unless
Alessio explicitly asks.

### Binance: honest error for geo-blocked visitors (done on 2026-10-20)

`src/modules/binance-geo.ts` classifies the failure: HTTP 451/403 or a body with
"restricted location" (from the klines backfill) give "Binance is not reachable
from your location (geo-restricted). Data unavailable." and stop the retries;
a WebSocket that errors or closes before the first message gives a
cautious message ("restricts your location or the network blocked the
connection"), because the browser does not expose the handshake status and a 451
without CORS headers arrives as a plain TypeError. Limits: geo-block cannot be
told apart from offline network with certainty; after the first message a close
remains a normal "stream closed". Verified only with unit tests and
`check`/`build`: no browser test (Playwright is not in the dependencies).

AIS relay (2026-11-07): `AisRelay` does nothing without the `AISSTREAM_API_KEY` secret: no upstream connection, a plain GET on `/ws/ais-vessels` answers 200 with `enabled: false` and no vessels, and the WebSocket sends `upstream: disabled` (the module says so instead of showing an empty sea). It stays inactive until Alessio runs `wrangler secret put AISSTREAM_API_KEY` and deploys (migration v2 registers the class). Choices: world BoundingBox and only `PositionReport`; cap of 3000 vessels and TTL of 15 minutes; updates to browsers in batches every 3 s, not one message per vessel; upstream connection opened by the first viewer and closed by the last, as for lightning. Data license still not declared by the provider (it stays in the sub-items to verify).

## Log
- 2026-11-21: 🤖 adsb.lol module made mergeable: behind the optional secret `ADSB_LOL_API_KEY` (without it, no call to adsb.lol), tests for both cases and smoke test in the deploy; merged main into the branch. 🤖 Wikimedia EventStreams license: read wikitech, Terms of Use and API Usage Guidelines, no official page fixes the data license; code unchanged, sub-item still open with the results in the decisions; ROADMAP translated to English (language rule).
- 2026-11-14: 🤖 New Lane A module: carbon intensity and generation mix of the GB electricity grid (Carbon Intensity API, CC BY 4.0), with parser, tests and README row moved among the live sources. 🤖 New Lane B module: aircraft from adsb.lol (ODbL 1.0) on the map, with parser and tests on fake data; reuses the GDELT cron slot, no change to `wrangler.jsonc`.
- 2026-11-10: PR #20 (Lane C AIS) merged into main on Alessio's decision, deploy succeeded; the module says "AISSTREAM_API_KEY is not configured" until Alessio sets the secret. Fixed verify-live (meteored has two `.readout`, failing since 7/11).
- 2026-11-07: 🤖 Lane C AIS: `AisRelay` Durable Object (a single connection to aisstream.io, position set bounded by count and TTL, snapshot on arrival and batched updates), `ais-vessels` map module, tests with fake data, check in the deploy; inactive while the secret is missing. License decisions: adsb.fi accepted (personal site, non-commercial); OpenSky: permission asked by email. 🤖 Second automatic read of the "to verify" licenses: only Wikimedia gave a new datum (CC0 not applicable to EventStreams), the rest remains to be verified by hand.
- 2026-11-06: canonical notes widget v2 (public/notes-widget.js) in place of the notebook (migrates realtime-earth.notes.queue); removed notebook.ts and CSS.
- 2026-10-31: 🤖 FIRMS moves from VIIRS SNPP to NOAA-20 (Suomi NPP ends on 2026-11-02, confirmed by the FIRMS blog); Wikimedia license in the module made non-CC0 until confirmed. License audit of the sources (README: new section "Licence audit"): 4 ok with attribution, OpenSky not usable, the rest still to be clarified; sub-items opened in the ROADMAP. New Lane A modules from NOAA SWPC: Kp index (~1 week of history), GOES X-ray (24 h, minutes without measurement as gaps) and solar wind (24 h, only `active` rows), parsers with tests; README rows moved among the live sources. Lane B verified already present in the code (proxy, `scheduled`, KV); added flow tests with fake KV and simulated fetch (hit/miss, error with stale data, 429, cron) and ticked the item.
- 2026-10-22: 🤖 README: "Data sources" section with a table of all sources (lane, cadence, license, status); licenses verified on the provider's site only for USGS and Open-Meteo, the others declared in the modules or "to verify"
- 2026-10-20: 🤖 Binance: honest error message for geo-blocked visitors (451/403, WebSocket handshake refused), with unit tests
- 2026-10-19: notebook moved to the single `site-notes` backend; removed `/api/notes` from the worker; then write-only, no token (Claude reads them from the D1); notes from the site brought into the ROADMAP (other Bitcoin markets in the Ideas); notes send the author (`?sono-alessio` marks Alessio's browser, the others are visitors'); installable as a standalone app from the phone (manifest with its own name, icon and scope)
- 2026-10-18: added the ideas from IDEE.md (single protocol)
- 2026-10-18: FUTURE-ARCHITECTURE.md merged into ROADMAP.md (single protocol)
- 2026-10-15: created the roadmap for Projects Overview
