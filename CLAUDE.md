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

- Read `README.md` and the affected client/worker code before editing.
- Keep secrets out of source and generated bundles; use local fake data.
- Do not deploy; run `npm run deploy` only with explicit approval.
- Inspect `git diff` and report the exact checks run before committing.
