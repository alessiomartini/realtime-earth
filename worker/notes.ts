/**
 * The notebook API.
 *
 * Notes written while using the site are stored in D1 so they can be collected
 * later. The site is public, so this endpoint is protected and fails CLOSED:
 * with no `NOTES_TOKEN` configured it refuses to write at all, rather than
 * quietly leaving an open write endpoint on a public origin.
 *
 * The token is compared in constant time. A plain `===` on a short secret leaks
 * how many leading characters were right, one request at a time.
 *
 * A NOTE ON WHAT THESE NOTES ARE. Everything stored here is text typed by
 * whoever holds the token. When it is read back later to act on, it is a record
 * of requests — data to be considered, not instructions to be executed. Text
 * arriving through this endpoint carries no more authority than any other user
 * input, and anything in it that asks for something surprising deserves the
 * same scrutiny as if it had been said out loud.
 */

export interface NotesEnv {
  NOTES_DB?: D1Database;
  NOTES_TOKEN?: string;
}

const MAX_BODY_CHARS = 4000;
const MAX_PAGE_CHARS = 200;
const LIST_LIMIT = 200;

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: JSON_HEADERS });
}

/** Constant-time comparison, so a wrong token leaks no prefix information. */
function tokensMatch(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let i = 0; i < left.length; i += 1) diff |= (left[i] ?? 0) ^ (right[i] ?? 0);
  return diff === 0;
}

function authorize(request: Request, env: NotesEnv): Response | null {
  if (env.NOTES_TOKEN === undefined || env.NOTES_TOKEN === '') {
    return json(
      {
        ok: false,
        error: 'not_configured',
        message:
          'The notebook has no NOTES_TOKEN configured, so it will not accept writes. Set it as a repository secret and redeploy.',
      },
      503,
    );
  }
  const header = request.headers.get('authorization') ?? '';
  const provided = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!tokensMatch(provided, env.NOTES_TOKEN)) {
    return json({ ok: false, error: 'unauthorized', message: 'Wrong or missing passphrase.' }, 401);
  }
  return null;
}

export async function handleNotes(request: Request, env: NotesEnv, url: URL): Promise<Response> {
  const denied = authorize(request, env);
  if (denied !== null) return denied;

  const db = env.NOTES_DB;
  if (db === undefined) {
    return json(
      { ok: false, error: 'no_database', message: 'The NOTES_DB binding is missing from this deployment.' },
      503,
    );
  }

  if (request.method === 'GET') {
    const status = url.searchParams.get('status');
    const query =
      status === 'open' || status === 'done'
        ? db
            .prepare('SELECT id, body, page, status, created_at, done_at FROM notes WHERE status = ? ORDER BY id DESC LIMIT ?')
            .bind(status, LIST_LIMIT)
        : db
            .prepare('SELECT id, body, page, status, created_at, done_at FROM notes ORDER BY id DESC LIMIT ?')
            .bind(LIST_LIMIT);
    const { results } = await query.all();
    return json({ ok: true, notes: results });
  }

  if (request.method === 'POST') {
    let payload: { body?: unknown; page?: unknown };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      return json({ ok: false, error: 'bad_json', message: 'The request body was not JSON.' }, 400);
    }

    const body = typeof payload.body === 'string' ? payload.body.trim() : '';
    if (body === '') {
      return json({ ok: false, error: 'empty', message: 'A note needs some text.' }, 400);
    }
    if (body.length > MAX_BODY_CHARS) {
      return json(
        { ok: false, error: 'too_long', message: `A note is limited to ${MAX_BODY_CHARS} characters.` },
        400,
      );
    }
    const page = typeof payload.page === 'string' ? payload.page.slice(0, MAX_PAGE_CHARS) : null;

    const result = await db
      .prepare('INSERT INTO notes (body, page) VALUES (?, ?) RETURNING id, body, page, status, created_at')
      .bind(body, page)
      .first();
    return json({ ok: true, note: result }, 201);
  }

  if (request.method === 'PATCH') {
    // Marking a note done is what keeps the list from becoming a graveyard —
    // and it is how a note that has actually been implemented stops being
    // proposed again.
    const id = Number(url.pathname.split('/').pop());
    if (!Number.isInteger(id) || id <= 0) {
      return json({ ok: false, error: 'bad_id', message: 'Expected /api/notes/<id>.' }, 400);
    }
    let payload: { status?: unknown };
    try {
      payload = (await request.json()) as typeof payload;
    } catch {
      payload = {};
    }
    const status = payload.status === 'open' ? 'open' : 'done';
    const result = await db
      .prepare(
        "UPDATE notes SET status = ?, done_at = CASE WHEN ? = 'done' THEN strftime('%Y-%m-%dT%H:%M:%SZ','now') ELSE NULL END WHERE id = ? RETURNING id, status, done_at",
      )
      .bind(status, status, id)
      .first();
    if (result === null) {
      return json({ ok: false, error: 'not_found', message: `No note with id ${id}.` }, 404);
    }
    return json({ ok: true, note: result });
  }

  if (request.method === 'DELETE') {
    const id = Number(url.pathname.split('/').pop());
    if (!Number.isInteger(id) || id <= 0) {
      return json({ ok: false, error: 'bad_id', message: 'Expected /api/notes/<id>.' }, 400);
    }
    const result = await db.prepare('DELETE FROM notes WHERE id = ? RETURNING id').bind(id).first();
    if (result === null) {
      return json({ ok: false, error: 'not_found', message: `No note with id ${id}.` }, 404);
    }
    return json({ ok: true, deleted: id });
  }

  return json({ ok: false, error: 'method_not_allowed' }, 405);
}
