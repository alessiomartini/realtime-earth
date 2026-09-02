/**
 * The Real-Time Earth — single Worker entrypoint.
 *
 * This Worker is the only origin the site has. It serves:
 *   - static assets (the Vite build) through the `ASSETS` binding, handled by
 *     the runtime before this script runs for every path except the ones
 *     listed in `run_worker_first` in wrangler.jsonc;
 *   - `/api/<module-id>` — Lane B proxy/cache routes;
 *   - `/ws/<module-id>`  — Lane C Durable Object relay routes.
 *
 * It also runs on a schedule, refreshing the Lane B sources into KV, so that no
 * visitor's page load is what makes a rate-limited source get hit.
 */

import { handleNotes, type NotesEnv } from './notes.js';
import { handleProxy, proxySourceById, refreshForCron, type ProxyEnv } from './proxy.js';
import { handleBlitzortungProbe } from './blitzortung-probe.js';
import { handleMeteoredProbe } from './meteored-probe.js';
import { handleLightningSocket, LightningRelay, type RelayEnv } from './lightning-relay.js';

// The Durable Object class has to be exported from the Worker's entrypoint for
// the runtime to find it.
export { LightningRelay };

export interface Env extends NotesEnv, ProxyEnv, RelayEnv {
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
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // The notebook: notes written while using the site, kept so they can be
    // collected and acted on later. Protected, and refuses to write at all
    // when no token is configured — an open write endpoint on a public origin
    // is not something to leave running by accident.
    if (url.pathname === '/api/notes' || url.pathname.startsWith('/api/notes/')) {
      return handleNotes(request, env, url);
    }

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
          B: 'proxy + scheduled refresh into KV, served from /api/<module-id>',
          C: 'Durable Object relay: one upstream stream shared by every viewer, at /ws/<module-id>',
        },
      });
    }

    // A reachability diagnostic, not a feed. Verification from a GitHub runner
    // could not reach Blitzortung at all, and the same was true of GDELT right
    // before it turned out to work perfectly from Cloudflare. This asks from
    // here instead. Nothing reads it as data.
    if (url.pathname === '/api/_diag/blitzortung') {
      return handleBlitzortungProbe();
    }

    // Reveals Meteored's real element names once a key exists, so the shaper's
    // candidate lists can be corrected from a real response rather than guessed
    // at a second time. Read-only, and never displayed as data.
    if (url.pathname === '/api/_diag/meteored') {
      return handleMeteoredProbe(env);
    }

    // Lane C. One relay, one upstream connection, however many people are
    // watching — which is both what the lane is for and what Blitzortung asks
    // of applications that use their volunteers' data.
    if (url.pathname === '/ws/lightning-strikes') {
      return handleLightningSocket(request, env);
    }

    // Lane B. Every proxied source is served from `/api/<module-id>` by the
    // same handler, so the honesty of the envelope — fetch time, cache age,
    // refresh errors — cannot drift between one source and the next.
    if (url.pathname.startsWith('/api/')) {
      const source = proxySourceById(url.pathname.slice('/api/'.length));
      if (source !== undefined) return handleProxy(source, env);
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

  /**
   * Lane B's refresh loop.
   *
   * Each source declares its own cron and only the sources whose expression
   * fired are refreshed. That is the difference between honouring a publisher's
   * stated cadence and merely knowing it: a source that asks to be read hourly
   * is read hourly, even when something else needs reading every fifteen
   * minutes.
   *
   * Failures are stored, not thrown. A refresh that cannot reach its source has
   * to end up on the page as a reason the reader can see, and an exception here
   * would end up only in a log.
   */
  async scheduled(event: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(
      refreshForCron(event.cron, env).then((log) => {
        // Observability is enabled for this Worker, so this line is the record
        // of what each scheduled run actually managed to fetch.
        console.log(`scheduled ${event.cron}: ${log.join(' | ')}`);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
