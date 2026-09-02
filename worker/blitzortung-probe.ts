/**
 * A diagnostic, not a feed.
 *
 * Real-time lightning is wanted, and Blitzortung is the only free source for
 * it. Verification from a GitHub runner could not reach the host at all — not
 * port 3000, not port 443, not even a plain HTTPS request. That is the same
 * shape of result GDELT produced, and GDELT turned out to be perfectly alive
 * from Cloudflare. So the question "is Blitzortung reachable?" has to be asked
 * from the place that would actually be doing the connecting.
 *
 * There is a second question this answers, and it decides the whole design. A
 * Worker's `fetch` can only reach a fixed set of ports, and 3000 is not among
 * them, so a relay cannot open the upstream WebSocket the easy way. Raw TCP via
 * `connect()` has no such restriction — this establishes whether that route
 * works before any relay is built on the assumption that it does.
 *
 * It performs the WebSocket opening handshake by hand and reports the server's
 * status line verbatim. No feed reads from this, and nothing it returns is ever
 * displayed as data.
 */

import { connect } from 'cloudflare:sockets';

const CONNECT_TIMEOUT_MS = 8_000;

interface ProbeResult {
  target: string;
  port: number;
  ok: boolean;
  /** The server's HTTP status line, verbatim, when there was one. */
  statusLine: string | null;
  /** Whether the response was a WebSocket upgrade. */
  upgraded: boolean;
  headers: string[];
  error: string | null;
  elapsedMs: number;
}

async function probeOne(hostname: string, port: number): Promise<ProbeResult> {
  const started = Date.now();
  const result: ProbeResult = {
    target: hostname,
    port,
    ok: false,
    statusLine: null,
    upgraded: false,
    headers: [],
    error: null,
    elapsedMs: 0,
  };

  let socket: ReturnType<typeof connect> | null = null;
  try {
    socket = connect({ hostname, port }, { secureTransport: 'on', allowHalfOpen: false });

    const writer = socket.writable.getWriter();
    // A minimal RFC 6455 opening handshake. The key is a fixed base64 value:
    // it only has to be 16 bytes, and nothing here validates the accept hash,
    // because the question is whether the server answers at all.
    const request =
      `GET / HTTP/1.1\r\n` +
      `Host: ${hostname}\r\n` +
      `Upgrade: websocket\r\n` +
      `Connection: Upgrade\r\n` +
      `Sec-WebSocket-Key: AAAAAAAAAAAAAAAAAAAAAA==\r\n` +
      `Sec-WebSocket-Version: 13\r\n` +
      `Origin: https://realtime-earth.alemarti-2001.workers.dev\r\n` +
      `\r\n`;
    await writer.write(new TextEncoder().encode(request));
    writer.releaseLock();

    const reader = socket.readable.getReader();
    const timeout = new Promise<null>((resolve) => setTimeout(() => resolve(null), CONNECT_TIMEOUT_MS));
    const first = await Promise.race([reader.read(), timeout]);

    if (first === null) {
      result.error = `connected, but no bytes within ${CONNECT_TIMEOUT_MS / 1000}s`;
    } else if (first.done === true || first.value === undefined) {
      result.error = 'connection closed without sending anything';
    } else {
      const text = new TextDecoder().decode(first.value);
      const lines = text.split('\r\n');
      result.statusLine = lines[0] ?? null;
      result.headers = lines.slice(1).filter((line) => line !== '').slice(0, 12);
      result.upgraded = /\b101\b/.test(result.statusLine ?? '');
      result.ok = true;
    }
    await reader.cancel().catch(() => undefined);
  } catch (error) {
    result.error = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  } finally {
    try {
      await socket?.close();
    } catch {
      /* already gone */
    }
    result.elapsedMs = Date.now() - started;
  }

  return result;
}

export async function handleBlitzortungProbe(): Promise<Response> {
  const targets: Array<[string, number]> = [
    ['ws1.blitzortung.org', 3000],
    ['ws7.blitzortung.org', 3000],
    ['ws1.blitzortung.org', 443],
    ['blitzortung.org', 443],
  ];

  const results: ProbeResult[] = [];
  for (const [hostname, port] of targets) {
    results.push(await probeOne(hostname, port));
  }

  return new Response(
    JSON.stringify(
      {
        ok: true,
        diagnostic: 'blitzortung-reachability',
        note: 'Asks from Cloudflare, because that is where a relay would connect from. Not a data feed.',
        vantagePoint: 'cloudflare-worker',
        results,
      },
      null,
      2,
    ),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
