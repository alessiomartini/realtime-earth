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

Cloudflare D1, database `realtime-earth-notes`
(`a4e13537-0705-4a67-82d4-6ade1dd87213`), table `notes`:

| column | meaning |
| --- | --- |
| `id` | note number, used to refer to it |
| `body` | what was written |
| `page` | the path it was written from, e.g. `/m/surface-temperature` |
| `status` | `open` or `done` |
| `created_at` | when it was written |
| `done_at` | when it was marked done |

D1 rather than KV for one reason: a SQL database can be read directly through
the Cloudflare API, which is what removes the copy-and-paste step entirely.

## Reading them

```sql
-- everything still to do, oldest first so the queue is worked in order
SELECT id, page, created_at, body FROM notes WHERE status = 'open' ORDER BY id;

-- close one off once it is actually implemented
UPDATE notes SET status = 'done', done_at = strftime('%Y-%m-%dT%H:%M:%SZ','now') WHERE id = ?;
```

Over HTTP, with the passphrase:

```sh
curl -H "Authorization: Bearer $NOTES_TOKEN" https://realtime-earth.alemarti-2001.workers.dev/api/notes
```

## Why it is gated

The site is public and this endpoint writes to a database, so it requires a
passphrase and **fails closed**: with no `NOTES_TOKEN` configured the Worker
refuses to write at all, rather than leaving an open write endpoint running on a
public origin unnoticed. The token is compared in constant time, so a wrong
guess leaks nothing about how much of it was right.

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
