# Roadmap

<!--
Unico file per todo, idee, decisioni e diario, letto da Projects Overview
(https://alessiomartini.github.io/projects-overview/). Protocollo: templates/ROADMAP.md di projects-overview.
-->

## Roadmap
- [x] Scaffold: Vite + TS, Worker, deploy in CI
- [x] Contratto dei moduli, registry, lifecycle manager
- [x] Primi quattro feed live
- [ ] Lane B: proxy nel Worker, handler `scheduled`, KV
- [ ] Lane C: relay AIS con Durable Object e modulo mappa (il relay Blitzortung in `worker/lightning-relay.ts` è il precedente da seguire)
- [ ] Moduli restanti, sezione per sezione (stato delle fonti nella tabella "Verified source status" del README)
- [ ] README completo con tabella delle fonti (licenza, lane, latenza)
- [ ] Binance: errore onesto per i visitatori geo-bloccati invece di dare per scontato il workaround

## Idee
- [ ] Osservatorio dei flussi del mondo (forse da far crescere qui, che è già un catalogo di feed live). Dati da tracciare:
  - traffico marittimo
  - traffico aereo
  - traffico su gomma
  - traffico su rotaia
  - turismo e viaggi di lavoro
  - uso di internet
  - elettricità: quantità e fonti
  - ambiente: aria, terreno, umidità, temperatura, vento, esposizione UV
  - altro: …

- [x] Feedback centralizzato: un unico D1 + Worker condiviso fra tutti i siti (fatto il 2026-10-19: `site-notes`, dettagli sotto)
- [ ] Nota dal sito (2026-08-29, pagina Bitcoin): oltre a Binance, altri mercati di Bitcoin (es. Coinbase, Kraken, Bitstamp, che hanno feed WebSocket pubblici), anche affiancati per confrontare i prezzi

## Decisioni e cose provate

### Dettaglio dei passi 4–7 (dal README)

Steps 4–7 are not done yet:

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

### Fonti bloccate

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

### Feedback centralizzato (fatto il 2026-10-19: backend unico `site-notes`)

Il notebook ora scrive in `site-notes` (repo `alessiomartini/site-notes`, `site = 'realtime-earth'`),
inizialmente come sito privato (token anche per scrivere). Poi, lo stesso giorno, **solo scrittura e niente
token**: ad Alessio non serve che la pagina rilegga le note, serve che Claude le legga dal D1 e le porti in
questo ROADMAP; il notebook ora mostra solo le note non ancora inviate. Tolti
`worker/notes.ts`, `/api/notes`, il binding `NOTES_DB`, l'upload del secret e il controllo del notebook nel
deploy. Il D1 `realtime-earth-notes` e il secret `NOTES_TOKEN` sono stati spenti dopo la migrazione.
Il testo sotto è la discussione di prima, tenuta come storia.


Questo sito ha già un "notebook" (`worker/notes.ts`, tabella D1 `notes(id,
body, page, status, created_at, done_at)`, vedi anche `scripts/notes.md`).
**Non è un feedback pubblico dei visitatori**: è una casella di note per
Alessio stesso mentre usa il sito, protetta da un `NOTES_TOKEN` che il
Worker richiede su *ogni* metodo (GET/POST/PATCH/DELETE) e a cui il Worker
fallisce CLOSED se il token non è configurato — nessuno scrive senza
conoscere la passphrase, anche se il pulsante "Notes" è visibile a chiunque
visiti il sito.

Idea, non decisa: consolidare in un **unico database D1 condiviso fra tutti i
siti** di Alessio (compreso `markets-first-principles`, che ha lo stesso
pattern in `worker/schema.sql`), dietro un **unico Worker** con allowlist
CORS per dominio chiamante, con uno schema tipo
`notes(id, site, page, text, created_at, ...)` invece di un D1 + Worker per
sito.

**Pro:**
- Meno infrastruttura Cloudflare da mantenere (un D1, un Worker, un deploy
  workflow invece di N).
- Un solo posto dove leggere tutte le note di tutti i siti, invece di
  interrogare un D1 diverso per ciascuno.

**Contro:**
- Un bug nel Worker condiviso rompe la raccolta note ovunque, non solo su un
  sito — oggi un problema nel notebook di `realtime-earth` non tocca
  `markets-first-principles` e viceversa.
- Va migrato lo storico esistente (`realtime-earth-notes` e l'equivalente di
  `markets-first-principles`) nel nuovo schema con colonna `site`.
- Il meccanismo di autenticazione per-token/per-sito andrebbe ripensato: oggi
  ogni Worker ha il proprio `NOTES_TOKEN`; un Worker condiviso dovrebbe
  comunque continuare a fallire CLOSED e a non esporre un read endpoint
  pubblico, principio che questo progetto tratta come non negoziabile (vedi
  `worker/notes.ts` e `scripts/notes.md`, sezione "Why it is gated").

**Priorità bassa** — il sistema attuale funziona, non ci sono bug noti, e i
passi 4-7 della roadmap sopra sono più urgenti. Non implementare senza che
Alessio lo chieda esplicitamente.

## Log
- 2026-10-19: notebook spostato nel backend unico `site-notes`; tolto `/api/notes` dal worker; poi solo scrittura, niente token (le legge Claude dal D1); note del sito portate nel ROADMAP (altri mercati di Bitcoin nelle Idee); le note mandano l'autore (`?sono-alessio` segna il browser di Alessio, le altre sono di visitatori)
- 2026-10-18: aggiunte le idee da IDEE.md (protocollo unico)
- 2026-10-18: FUTURE-ARCHITECTURE.md unito in ROADMAP.md (protocollo unico)
- 2026-10-15: creata la roadmap per Projects Overview
