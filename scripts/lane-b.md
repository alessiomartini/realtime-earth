# Lane B — proxied feeds

Some sources cannot be read from a browser. Those are fetched by the Worker
instead and served to everyone from `/api/<module-id>`.

## When a source belongs here

Any one of these is enough, and each is established by running
`scripts/verify-endpoints.mjs`, never by assumption:

| reason | what the probe shows |
| --- | --- |
| No CORS | 200, but no `access-control-allow-origin` a browser would accept |
| Needs a key | 401/403 without one — and the key must never reach the bundle |
| Published rate limit | 429, or documented cadence a public site would breach |

GDELT is in Lane B for the first and third reasons at once.

## The second clock

This is the whole difficulty. A Lane A feed has one clock — the source's. A
proxied feed has two, and presenting the wrong one as the other is the failure
this lane makes easy. So every response states both, separately:

| field | whose clock | meaning |
| --- | --- | --- |
| `sourceTimestamp` | the source's | the newest datum's own time. The only one treated as data. Null when the source publishes none — never substituted. |
| `fetchedAt` | ours | when this Worker fetched the payload from upstream |
| `fetchAgeSeconds` | ours | how old that fetch is now |
| `cached` | ours | whether this came out of KV rather than off the wire |
| `refreshEverySeconds` | ours | the source's declared refresh interval |
| `refreshError` | — | why the last refresh attempt failed, if it did |

On the page, `ProxyModule.cacheLabel()` renders the ours-half as *"fetched by
our Worker 6m ago, refreshed every 15 min"*. Nothing in this lane is ever
labelled live.

## A failed refresh

The last good payload keeps being served, with its real `fetchedAt`, and the
failure travels with it. That is an ageing snapshot with the reason it stopped
ageing forward printed on it — which is what actually happened.

Two things make it honest rather than a held value:

1. the payload is **never restamped**; and
2. the failure is **never hidden** because there was something to show.

Failures are stored under their own KV key (`feed:<id>:error`), so an error can
never overwrite the only real data we have.

## Not counting a re-read as an arrival

The Worker answers every poll, and between refreshes it answers with the same
bytes. `ProxyModule` recognises a payload whose `fetchedAt` has not changed and
counts it as nothing. Without that, a feed refreshed four times an hour would
report hundreds of "messages received" — inflating the single number this
site's argument rests on, while looking completely normal.

## Adding a proxied source

1. Probe it in `scripts/verify-endpoints.mjs` and run the workflow. **A source
   is not wired before this passes.**
2. Add an entry to `SOURCES` in `worker/proxy.ts`: id, attribution, a
   `publicUrl` with no key in it, its own cron, and a `shape()` that reduces the
   body to what the client needs and extracts the source's own timestamp.
3. Add its cron to `triggers.crons` in `wrangler.jsonc`. A unit test asserts
   every source declares one.
4. Add a client module extending `ProxyModule`, and one import line in
   `src/modules/all.ts`.

## A note on where you verify from

GDELT answered **429 to every probe from a GitHub runner**, including the first
request of a run, while the same query from Cloudflare's egress returned 75
articles. The limit is per-origin and CI shares its address with everything else
on that runner.

A source is not dead because it refused the place you asked from. Where the
answer depends on the caller's address, the deploy smoke test asks from
production, because that is the only vantage point that decides anything.

## Sources currently registered

| id | source | cron | state |
| --- | --- | --- | --- |
| `gdelt-news` | The GDELT Project, DOC 2.0 | `4,19,34,49 * * * *` | live |
| `firms-fires` | NASA FIRMS | `27 * * * *` | refuses — no `FIRMS_MAP_KEY` |

FIRMS answers 503 naming the missing key, and the scheduled handler does not
call NASA at all without one. The deploy fails if it ever answers 200 while
unconfigured: a fire map with nothing behind it must refuse, not render. Get a
free key at <https://firms.modaps.eosdis.nasa.gov/api/area/> and set it with
`wrangler secret put FIRMS_MAP_KEY`.

## Observed: GDELT's index lag

Two production fetches seven hours apart both returned a newest `seendate` on an
exact half-hour boundary, 35 and 45 minutes behind the fetch. GDELT's index is
quantised and runs roughly that far behind real time. Nothing corrects for it;
the page shows the age by GDELT's own clock and says so in words.

---

# Lane C — relayed feeds

`/ws/<module-id>`, backed by a Durable Object. One upstream connection for the
whole site, however many people are watching.

## Why a Durable Object and not a Worker

A Worker is instantiated per request, so a hundred visitors would open a hundred
upstream connections — exactly what this lane exists to prevent. A Durable
Object is a single addressable instance, so every client meets at one place and
shares one socket. `idFromName('blitzortung')` is the fixed name that makes that
true.

The upstream socket opens when the first viewer arrives and closes when the last
one leaves. Streaming from a volunteer-run network to an empty room is not
something to do by accident.

## What the relay must tell its clients

Our socket being open says nothing about whether the Worker can reach the
source. Without a status frame, a relay that cannot connect looks exactly like a
quiet night — so the relay sends `{type:'status', upstream, reason}` on connect
and on every change, and the module puts itself into the error state with the
source's own reason.

## Sources

| id | source | route | state |
| --- | --- | --- | --- |
| `lightning-strikes` | Blitzortung.org | `/ws/lightning-strikes` | live |

## What verification settled about Blitzortung

Four things, three of which would have shipped as silent bugs:

1. **Unreachable from GitHub runners.** Every probe failed, including plain
   HTTPS. That is not evidence about the source — GDELT did the same thing
   immediately before working perfectly from Cloudflare.
2. **Port 3000 is unreachable from Cloudflare; port 443 answers `HTTP/1.1 101`.**
   A Worker's `fetch` cannot reach 3000 but can reach 443, so the relay uses the
   ordinary WebSocket upgrade instead of hand-rolled framing over a raw socket.
3. **The subscription is `{"a":111}`.** The `{"time":0}` used by a published
   client library gets a clean upgrade and then permanent silence — a feed that
   connects flawlessly and never shows a strike.
4. **Frames are LZW-compressed and the timestamp is nanoseconds.** A raw frame is
   not JSON. And `1788366104013598000` read as milliseconds is fifty-six million
   years from now, while still *looking* like working code: dots appear, the
   counter climbs. Hence the range check, tested from both sides, with the real
   frame kept as a fixture.

The general rule this keeps proving: **a handshake proves a door opens, not what
comes through it.** Probes wait for a frame.
