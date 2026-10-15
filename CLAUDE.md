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

- Read `README.md`, `FUTURE-ARCHITECTURE.md` and the affected client/worker code
  before editing. `FUTURE-ARCHITECTURE.md` tracks the remaining roadmap steps
  and known per-source blockers (Stooq key, FIRMS key, Binance geo-restriction).
- Keep secrets out of source and generated bundles; use local fake data.
- Do not deploy; run `npm run deploy` only with explicit approval.
- Inspect `git diff` and report the exact checks run before committing.
- The `worker/notes.ts` "notebook" endpoint is author-only (gated by
  `NOTES_TOKEN`, fails closed), not a public feedback form — do not build
  public-facing feedback on top of it without discussing the change first.

## Roadmap e progressi

Questo progetto è tracciato in https://alessiomartini.github.io/projects-overview/ tramite il file `ROADMAP.md`
nella root del repo. Mantienilo aggiornato:

- Alla fine di ogni sessione di lavoro (prima del commit finale), aggiorna `ROADMAP.md`:
  - spunta (`- [x]`) i punti completati in questa sessione;
  - aggiungi come `- [ ]` i nuovi compiti emersi, nella fase giusta (titoli `##`);
  - aggiungi in cima alla sezione `## Log` una riga `- AAAA-MM-GG: <cosa è stato fatto, in una frase>`
    (se esiste già una riga con la data di oggi, estendila invece di crearne un'altra).
- Non riscrivere né riordinare le voci esistenti senza motivo; non cancellare le voci completate.
- Se `ROADMAP.md` non esiste, crealo con le fasi `## ...`, le checkbox e una sezione `## Log`.
- Includi l'aggiornamento di `ROADMAP.md` nello stesso commit del lavoro.
