# Meteored — what the gate found

Meteored was requested as the source for high-resolution weather, replacing the
coarse temperature map. It was probed before anything was wired, and the answer
was clear enough to write down.

## It is alive, and it is gated

Its developer product is `api.tiempo.com`. Probed without a key:

```
meteored-api  rest  200  cors: none  →  Lane B
<?xml version="1.0" encoding="UTF-8" ?><report><error>You are not a registered
user of the API from tiempo.com or your account has not been activated.</error></report>
```

Three facts in one response:

1. The host is up and the API works — this is a refusal, not an outage.
2. It requires a **registered and activated** account. There is no keyless path.
3. It sends **no CORS header**, so a browser could not read it even with a key.
   It would be Lane B, behind the Worker, with the key as a Worker secret.

## The second finding: shape, not just access

Meteored's documented product returns a **forecast for a named locality** — a
town, by id — as XML. A world map needs a *gridded field*: many coordinates
answered in one request, each carrying the model cell it came from.

Those are different instruments. A source can be perfectly alive, perfectly
licensed, and still be the wrong tool for the picture being drawn. Meteored is
excellent at "what is the weather in this town"; it is not built to answer "give
me 260 points across this rectangle".

## What was built instead, and why

Open-Meteo, which was already the source behind the old map, and which
verification showed can do everything the request was really asking for:

- **km-scale models, individually confirmed**: 1 km over the Alps, 1.5 km
  France, 2 km UK, 2.2 km Germany and Italy, 3 km continental US.
- **300 coordinates in a single request**, which is what makes a fine grid
  affordable at all.
- **Seventeen current variables at once**, with units — including the pressure,
  the wind at four heights and the four separate radiation components.
- Keyless, CORS-open, and it reports the coordinates and elevation of the grid
  cell it actually used, which is what lets the page state its resolution as a
  measurement rather than a claim.

The coarse blocks were never Open-Meteo's limit. They were a fixed global grid
of 216 points, and the fix was to make the grid follow the view.

## To wire Meteored anyway

It is a small job once a key exists, and worth doing if its own model is wanted
as a second opinion for point forecasts:

1. Register at <https://www.meteored.com/> / <https://www.tiempo.com/> and get
   the account **activated** — the refusal above distinguishes "not registered"
   from "not activated".
2. `wrangler secret put METEORED_AFFILIATE_ID`.
3. Add a source to `SOURCES` in `worker/proxy.ts` with a `buildUrl` that refuses
   when the secret is absent, and a `shape()` that parses the XML.

It would be a locality-forecast feed, not a replacement for the field map.
