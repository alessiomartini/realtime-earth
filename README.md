# The Real-Time Earth

A modular catalog of live global data feeds. The thesis: right now, humanity has
an unprecedented amount of high-quality real-time data publicly available — this
site shows a live sample of it, unmodified.

**Status: step 1 of 7 (scaffold).** No data feeds are connected yet. The site
currently renders the thesis, the founding principles, and a deployment probe
that confirms one Worker is serving both the static bundle and its own API
route from one origin.

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

It needs unrestricted outbound network access — run it from a normal machine or
a CI runner, not from a sandbox with an egress allowlist. A failure is a
finding, not a bug to code around: substitute the source, or show an honest
error in the module.

## Deployment

CI is `.github/workflows/deploy-realtime-earth.yml` at the repository root. It
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
src/main.ts                       entry point (step 1: thesis + deploy probe)
src/styles.css                    instrument-panel styling
worker/index.ts                   the single Worker: assets + /api/* + /ws/*
wrangler.jsonc                    Worker + assets configuration
scripts/verify-endpoints.mjs      source verification gate
scripts/check-bundle-secrets.mjs  "no secrets in the bundle" acceptance check
```

## Order of work

1. ✅ Scaffold: Vite + TS, one Worker serving assets and routes, CI deploy.
2. Module contract, registry, card shell, status strip, lifecycle manager
   (lazy connect, pause, backoff, staleness).
3. Reference modules covering the direct transports: USGS (poll), Wikipedia
   (SSE), Binance (WebSocket).
4. Lane B: Worker proxy route pattern, `scheduled` handler, KV storage, and one
   proxied module.
5. Lane C: the AIS Durable Object relay and its map module.
6. Remaining modules, section by section.
7. Full README: how to add a module in under 20 lines, plus a table of every
   source with license, lane and latency class.
