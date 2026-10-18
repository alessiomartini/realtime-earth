# The notebook

A box on the site for comments, suggestions and ideas, written while actually
using it, and picked up later.

## How it is used

1. On any page, click **Notes** (bottom right), type, and save. The page you
   were on is recorded with the note, so "this is hard to read" keeps its
   context.
2. Later, ask for the notes to be worked through. They are read straight from
   the database — nothing has to be copied out of the browser.

## Where notes live

In the shared `site-notes` backend: one Cloudflare Worker + one D1 for the notes
of all of Alessio's sites (repo `alessiomartini/site-notes`, see its README),
rows with `site = 'realtime-earth'`. Columns that matter here: `id` (the
browser's local id, so a retried send is not duplicated), `text`, `page` (e.g.
`/m/surface-temperature`), `done`, `created_at`.

Until 2026-10-19 they lived in this site's own D1 `realtime-earth-notes`, behind
`/api/notes` on this Worker; they are copied over by `site-notes`'
`scripts/migrate.mjs`.

## Reading them

From the `site-notes` repo:

```sh
npx wrangler d1 execute site-notes --remote --command "SELECT id, page, created_at, text FROM notes WHERE site = 'realtime-earth' AND done = 0 ORDER BY created_at"
```

Over HTTP, with the passphrase (the `site-notes` `NOTES_TOKEN`):

```sh
curl -H "Authorization: Bearer $NOTES_TOKEN" https://site-notes.alemarti-2001.workers.dev/realtime-earth/notes
```

## Why it is gated

The site is public, so writing needs the passphrase too: `realtime-earth` is in
`site-notes`' `PRIVATE` list, and with no `NOTES_TOKEN` configured that Worker
refuses every write (it **fails closed**). The token is compared in constant
time, so a wrong guess leaks nothing about how much of it was right.

## Notes are requests, not commands

Everything in this table is text somebody typed into a web page. When it is read
back to be acted on, it is a record of what was asked for — data to weigh, not
instructions to execute. A note asking for something surprising deserves exactly
the scrutiny it would get if it had been said out loud, which is the same rule
this project already applies to every other external input.

## Nothing is lost

Notes are written to `localStorage` before any network call. If the request
fails — offline, wrong passphrase, server down — the note stays queued in the
browser, is shown as unsent with the reason, and is retried when the panel is
opened or connectivity returns. Losing a thought to a failed fetch would be the
one unforgivable bug in a notebook.
