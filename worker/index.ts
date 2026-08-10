/**
 * The Real-Time Earth — single Worker entrypoint.
 *
 * This Worker is the only origin the site has. It serves:
 *   - static assets (the Vite build) through the `ASSETS` binding, handled by
 *     the runtime before this script runs for every path except the ones
 *     listed in `run_worker_first` in wrangler.jsonc;
 *   - `/api/<module-id>` — Lane B proxy/cache routes (added in step 4);
 *   - `/ws/<module-id>`  — Lane C Durable Object relay routes (added in step 5).
 *
 * Step 1 implements only the deployment smoke test, `/api/health`, so that a
 * successful deploy can be confirmed to serve BOTH the static assets and a
 * Worker route from one origin before any real feed is wired up.
 */

export interface Env {
  ASSETS: Fetcher;
}

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  // Responses are per-request and must never be served stale: a cached health
  // or data response would misrepresent how fresh the underlying datum is.
  'cache-control': 'no-store',
};

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body, null, 2), { status, headers: JSON_HEADERS });
}

export default {
  // `_env` is unused until step 4 — the assets runtime serves the bundle
  // without this script's involvement, so nothing here needs a binding yet.
  async fetch(request: Request, _env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/api/health') {
      // Every value here is observed by this Worker at request time. Nothing is
      // inferred or filled in.
      //
      // `colo` needs care: under `wrangler dev` the runtime synthesises a
      // placeholder `cf` object (it will happily report a colo like "DFW" on a
      // laptop). Reporting that as an observation would be exactly the kind of
      // plausible-looking invention principle 1 forbids, so on a local origin
      // the field is reported as absent and the runtime is labelled instead.
      const isLocal = url.hostname === 'localhost' || url.hostname === '127.0.0.1' || url.hostname === '[::1]';
      const colo = request.cf?.colo;
      return json({
        ok: true,
        service: 'realtime-earth',
        runtime: isLocal ? 'local-dev' : 'cloudflare',
        workerTime: new Date().toISOString(),
        colo: !isLocal && typeof colo === 'string' ? colo : null,
        lanes: {
          A: 'direct from the browser — no Worker involvement',
          B: 'not yet implemented (step 4)',
          C: 'not yet implemented (step 5)',
        },
      });
    }

    if (url.pathname.startsWith('/api/') || url.pathname.startsWith('/ws/')) {
      // An unknown module route is an error, not an empty success. Returning
      // `{}` here would let a module render "no data" when the truth is "this
      // endpoint does not exist".
      return json(
        {
          ok: false,
          error: 'unknown_route',
          message: `No handler is registered for ${url.pathname}.`,
        },
        404,
      );
    }

    // Paths outside /api and /ws only reach the Worker when the assets runtime
    // found nothing to serve, which means the build is missing or misdeployed.
    return json(
      {
        ok: false,
        error: 'asset_not_found',
        message: `No static asset matched ${url.pathname}. Was the site built before deploy?`,
      },
      404,
    );
  },

  // Placeholder for Lane B (step 4): scheduled refresh of slow-moving sources
  // into KV. Declared now so the shape of the Worker is visible from step 1.
} satisfies ExportedHandler<Env>;
