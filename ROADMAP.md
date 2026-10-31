# Roadmap

<!--
Unico file per todo, idee, decisioni e diario, letto da Projects Overview
(https://alessiomartini.github.io/projects-overview/). Protocollo: templates/ROADMAP.md di projects-overview.
-->

## Roadmap
- [x] Scaffold: Vite + TS, Worker, deploy in CI
- [x] Contratto dei moduli, registry, lifecycle manager
- [x] Primi quattro feed live
- [x] Lane B: proxy nel Worker, handler `scheduled`, KV (codice e test completi: `worker/proxy.ts`, `worker/proxy-flow.test.ts`)
  - [ ] Controllare che l'id del namespace `FEED_CACHE` in `wrangler.jsonc` sia quello reale dell'account Cloudflare di Alessio
  - [ ] Impostare i secret `FIRMS_MAP_KEY` e `METEORED_AFFILIATE_ID` (servono le chiavi di Alessio)
- [ ] Lane C: relay AIS con Durable Object e modulo mappa (il relay Blitzortung in `worker/lightning-relay.ts` è il precedente da seguire)
- [ ] Moduli restanti, sezione per sezione (stato delle fonti nella tabella "Verified source status" del README)
  - [x] NOAA SWPC indice Kp planetario (`src/modules/swpc-kp.ts`, Lane A, dominio pubblico)
  - [x] NOAA SWPC flusso di raggi X GOES (`src/modules/swpc-xray.ts`, Lane A, dominio pubblico)
  - [x] NOAA SWPC vento solare, velocità e Bz (`src/modules/swpc-wind.ts`, Lane A, dominio pubblico)
- [x] README completo con tabella delle fonti (licenza, lane, latenza)
- [ ] Verificare le licenze delle fonti segnate "to verify" nel README (fonti pianificate; Wikimedia CC0, FIRMS, Meteored e le licenze dichiarate nei moduli senza controllo sul sito del fornitore)
  - [ ] Coinbase Exchange: leggere i "Market Data Terms of Use" (`coinbase.com/legal/market_data`, risposta 403 dall'ambiente automatico), da un browser vero
  - [ ] airplanes.live: leggere i termini dell'API (sfida anti-bot, 403 dall'ambiente automatico)
  - [ ] mempool.space e PublicNode (RPC Ethereum): non dichiarano né licenza dei dati né limiti d'uso; valutare se scrivere a loro o usare un'alternativa con licenza esplicita
  - [ ] RIPE RIS Live: chiedere (rislive@ripe.net) se i termini del RIPE Data Repository (solo ricerca, niente uso commerciale né ridistribuzione) valgano anche per RIS Live
  - [ ] Meteored: leggere i termini specifici dell'API (nel dashboard JavaScript); i termini generali ammettono solo ridistribuzione non commerciale con citazione e link
  - [ ] AIS Stream, Stooq, Binance (`binance.vision`), Blitzortung: nessuna pagina di termini leggibile; verificare a mano
  - [ ] Wikimedia EventStreams: la licenza CC0 dichiarata nel modulo non è confermata da nessuna pagina del fornitore; correggere `source.license` in `src/modules/wikipedia-changes.ts` o trovare la fonte
  - [ ] Decidere se adsb.fi (solo uso personale non commerciale) è accettabile per questo sito; adsb.lol (ODbL 1.0) sì con attribuzione
  - [ ] FIRMS: la banda Earthdata annuncia che la consegna di nuovi dati Suomi NPP cessa il 2026-11-02; il percorso `VIIRS_SNPP_NRT` in `worker/proxy.ts` va verificato e probabilmente spostato su NOAA-20/21
- [x] Binance: errore onesto per i visitatori geo-bloccati invece di dare per scontato il workaround

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

### Audit delle licenze (2026-10-31)

Letti i termini dei fornitori (README, sezione "Licence audit"). Esito: ok con attribuzione per Carbon Intensity (CC BY 4.0), FIRMS (CC0 salvo diversa indicazione, NASA citata come fonte), GDELT (citazione e link) e adsb.lol (ODbL); non utilizzabile senza accordo scritto OpenSky (uso commerciale o REST operativo); adsb.fi solo uso personale non commerciale. Tutto il resto resta "still unclear" perché la pagina dei termini non si lascia leggere da un ambiente automatico (403, sfida anti-bot, pagina solo JavaScript) o non dichiara nulla: non è stato dedotto niente. La voce generica resta aperta finché non sono risolte le sotto-voci.

### Dettaglio dei passi 4–7 (dal README)

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

### Binance: errore onesto per i visitatori geo-bloccati (fatto il 2026-10-20)

`src/modules/binance-geo.ts` classifica il fallimento: HTTP 451/403 o corpo con
"restricted location" (dal backfill dei klines) danno "Binance is not reachable
from your location (geo-restricted). Data unavailable." e fermano i tentativi;
un WebSocket che dà errore o si chiude prima del primo messaggio dà un
messaggio prudente ("restricts your location or the network blocked the
connection"), perché il browser non espone lo status dell'handshake e un 451
senza header CORS arriva come semplice TypeError. Limiti: non si può distinguere
con certezza geo-blocco da rete offline; dopo il primo messaggio una chiusura
resta un normale "stream closed". Verificato solo con test unitari e
`check`/`build`: nessuna prova in browser (Playwright non è nelle dipendenze).

## Log
- 2026-10-31: 🤖 Audit delle licenze delle fonti (README: nuova sezione "Licence audit"): 4 ok con attribuzione, OpenSky non utilizzabile, il resto ancora da chiarire; aperte le sotto-voci nel ROADMAP. Nuovi moduli Lane A da NOAA SWPC: indice Kp (storia di ~1 settimana), raggi X GOES (24 h, minuti senza misura come buchi) e vento solare (24 h, solo righe `active`), parser con test; righe README spostate fra le fonti live. Lane B verificata già presente nel codice (proxy, `scheduled`, KV); aggiunti test di flusso con KV finto e fetch simulato (hit/miss, errore con dato vecchio, 429, cron) e spuntata la voce.
- 2026-10-22: 🤖 README: sezione "Data sources" con tabella di tutte le fonti (lane, cadenza, licenza, stato); licenze verificate sul sito del fornitore solo per USGS e Open-Meteo, le altre dichiarate nei moduli o "to verify"
- 2026-10-20: 🤖 Binance: messaggio onesto di errore per i visitatori geo-bloccati (451/403, handshake WebSocket rifiutato), con test unitari
- 2026-10-19: notebook spostato nel backend unico `site-notes`; tolto `/api/notes` dal worker; poi solo scrittura, niente token (le legge Claude dal D1); note del sito portate nel ROADMAP (altri mercati di Bitcoin nelle Idee); le note mandano l'autore (`?sono-alessio` segna il browser di Alessio, le altre sono di visitatori); installabile come app a sé dal telefono (manifest con nome, icona e perimetro propri)
- 2026-10-18: aggiunte le idee da IDEE.md (protocollo unico)
- 2026-10-18: FUTURE-ARCHITECTURE.md unito in ROADMAP.md (protocollo unico)
- 2026-10-15: creata la roadmap per Projects Overview
