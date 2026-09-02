/**
 * A diagnostic, not a feed.
 *
 * Real-time lightning is wanted and Blitzortung is the only free source for it.
 * Two rounds of verification produced two findings worth keeping:
 *
 * 1. Every probe from a GitHub runner failed, including plain HTTPS. That is
 *    the same shape of result GDELT produced immediately before proving to work
 *    perfectly from Cloudflare — "unreachable from CI" is not a fact about the
 *    source.
 * 2. From Cloudflare, port 3000 is unreachable but **port 443 answers
 *    `HTTP/1.1 101 Switching Protocols`**. That matters enormously: a Worker's
 *    `fetch` can only reach a fixed set of ports and 3000 is not among them,
 *    but 443 is. So the relay can use the ordinary WebSocket upgrade rather
 *    than hand-rolled framing over a raw socket.
 *
 * What remains unverified is the thing that decides the parser: the shape of an
 * actual strike message. A handshake proves a door opens, not what comes
 * through it. So this subscribes and captures real frames verbatim.
 *
 * No feed reads from this, and nothing it returns is displayed as data.
 */

const UPSTREAM = 'https://ws1.blitzortung.org/';
/** Blitzortung's stream stays silent until subscribed to. */
const SUBSCRIBE = '{"time":0}';
const WAIT_MS = 12_000;
const MAX_FRAMES = 3;

export async function handleBlitzortungProbe(): Promise<Response> {
  const started = Date.now();
  const frames: string[] = [];
  let statusCode: number | null = null;
  let error: string | null = null;
  let opened = false;

  try {
    const response = await fetch(UPSTREAM, { headers: { Upgrade: 'websocket' } });
    statusCode = response.status;
    const socket = response.webSocket;

    if (socket === null || socket === undefined) {
      error = 'the response carried no WebSocket — the upgrade was not accepted';
    } else {
      socket.accept();
      opened = true;
      socket.send(SUBSCRIBE);

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, WAIT_MS);
        socket.addEventListener('message', (event) => {
          const raw =
            typeof event.data === 'string'
              ? event.data
              : `[binary frame, ${(event.data as ArrayBuffer).byteLength} bytes]`;
          // Verbatim and untruncated where it fits: the exact field names and
          // the units of the timestamp are the whole point of asking.
          frames.push(raw.slice(0, 1200));
          if (frames.length >= MAX_FRAMES) {
            clearTimeout(timer);
            resolve();
          }
        });
        socket.addEventListener('close', () => {
          clearTimeout(timer);
          resolve();
        });
        socket.addEventListener('error', () => {
          error = 'the socket reported an error after opening';
          clearTimeout(timer);
          resolve();
        });
      });

      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }

  return new Response(
    JSON.stringify(
      {
        ok: frames.length > 0,
        diagnostic: 'blitzortung-payload',
        note: 'Asks from Cloudflare, because that is where the relay connects from. Not a data feed.',
        upstream: UPSTREAM,
        subscribe: SUBSCRIBE,
        statusCode,
        upgraded: opened,
        framesReceived: frames.length,
        waitedMs: Date.now() - started,
        error,
        frames,
      },
      null,
      2,
    ),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
