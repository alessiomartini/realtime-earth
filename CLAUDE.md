# Claude Code instructions

## Project

Vite/TypeScript realtime-earth application with a worker and Cloudflare tooling.

## Verification

- Install with `npm ci` when needed.
- Run `npm run check`, `npm run test`, and `npm run build` as appropriate.
- Use `npm run dev` for browser changes and inspect the affected view and console.
- Run `npm run audit:bundle` when changing configuration, environment handling,
  or bundling.

## Workflow

- Read `README.md`, `ROADMAP.md` and the affected client/worker code
  before editing. `ROADMAP.md` tracks the remaining roadmap steps, ideas,
  decisions and known per-source blockers (Stooq key, FIRMS key, Binance geo-restriction).
- Keep secrets out of source and generated bundles; use local fake data.
- Do not deploy; run `npm run deploy` only with explicit approval.
- Inspect `git diff` and report the exact checks run before committing.
- The notebook (`src/ui/notebook.ts`) only writes to the shared `site-notes` Worker
  (repo `alessiomartini/site-notes`, write-only, no token). Notes are read by Claude
  from the D1 (procedure in that repo's CLAUDE.md), never by the page.

## Roadmap, idee e progressi

`ROADMAP.md` nella root è l'**unico** file per todo, idee, decisioni e diario del progetto
(niente `FUTURE-ARCHITECTURE.md`, `IDEE.md`, `TODO.md`). È letto da https://alessiomartini.github.io/projects-overview/.
Sezioni: `## <fase>` (checkbox, contano nella percentuale), `## Idee` (checkbox, non contano),
`## Decisioni e cose provate` (prosa: scartato/rimandato e perché, provato e annullato, limiti e bug noti), `## Log`.

- Alla fine di ogni sessione di lavoro (prima del commit finale), aggiorna `ROADMAP.md`:
  - spunta (`- [x]`) i punti completati in questa sessione;
  - aggiungi come `- [ ]` i nuovi compiti nella fase giusta, e le idee non decise in `## Idee`;
  - annota in `## Decisioni e cose provate` ciò che è stato scartato, rimandato o annullato, col perché;
  - aggiungi in cima a `## Log` una riga `- AAAA-MM-GG: <cosa è stato fatto, in una frase>`
    (se esiste già una riga con la data di oggi, estendila invece di crearne un'altra).
- Non riscrivere né riordinare le voci esistenti senza motivo; non cancellare le voci completate.
- Se `ROADMAP.md` non esiste, crealo da `templates/ROADMAP.md` di projects-overview.
- Includi l'aggiornamento di `ROADMAP.md` nello stesso commit del lavoro.
