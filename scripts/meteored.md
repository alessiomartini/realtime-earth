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

## What is now built

Everything except the key.

- **`/api/meteored-conditions`** is a registered Lane B source, refreshed twice
  an hour by the scheduled handler. Without a key it answers 503 **naming
  `METEORED_AFFILIATE_ID`**, and the Worker does not call tiempo.com at all.
- **`worker/xml.ts`** is a small XML reader, because Workers have no
  `DOMParser`.
- **The tile is live on the site**, showing the honest refusal until a key
  exists.
- **`/api/_diag/meteored`** returns the raw XML and a census of every element in
  it, so the real schema can be read off a real response.

### The parser is deliberately shape-tolerant

Meteored's element names have never been observed here — every keyless request
is refused — so a parser written against remembered names would be a guess
wearing the clothes of a fact. Instead the shaper tries several candidate names
per field, **records which one matched**, and carries a census of every element
the response contained.

A wrong guess therefore appears on the page as *"None of the fields this page
looks for were found. The response did contain: …"* rather than as an empty
panel. That is the difference between "no reading" and "we were looking for the
wrong word", and it is covered by a test that was confirmed able to fail.

### The forecast is deliberately not shown

Meteored's response contains a multi-day forecast. The module shows only the
current values.

A forecast is a statement about a future that has not happened. Putting predicted
temperatures on the same page as received earthquake times, under the same "as
received" banner, would quietly redefine what that banner means. So the forecast
days are left out, and the page says they were left out rather than pretending
the response did not contain them.

## To finish it

1. Register at <https://www.meteored.com/> / <https://www.tiempo.com/> and get
   the account **activated** — the refusal distinguishes "not registered" from
   "not activated", so both steps matter.
2. `npx wrangler secret put METEORED_AFFILIATE_ID`
   (optionally also `METEORED_LOCALITY`; it defaults to Madrid, `3117735`).
3. Run the **Diagnose a source from production** workflow and read
   `/api/_diag/meteored`. That prints the real element names.
4. Correct `METEORED_FIELDS` in `worker/proxy.ts` from that evidence.

Step 3 is the one that matters. Until a real response has been seen, the field
names in the code are candidates, not facts, and the code says so.
