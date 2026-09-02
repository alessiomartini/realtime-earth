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

/**
 * Candidate subscription messages, tried in order.
 *
 * `{"time":0}` came from a published client library and produced a clean
 * upgrade followed by twelve seconds of complete silence — which is exactly
 * why the probe waits for a frame instead of calling a handshake a success.
 * `{"a":111}` is what current clients send. Rather than swap one guess for
 * another, both are tried and the report says which one actually delivered.
 */
const SUBSCRIBE_CANDIDATES = ['{"a":111}', '{"time":0}'];
const WAIT_MS = 9_000;
const MAX_FRAMES = 2;

/**
 * Blitzortung compresses each frame with an LZW variant.
 *
 * This is the widely-replicated decoder for that format. It is NOT taken on
 * trust: the probe reports the decoded text alongside the raw bytes, so whether
 * it produces valid JSON with plausible coordinates is visible rather than
 * assumed. A decoder that silently produced plausible-looking garbage is the
 * failure to guard against, and JSON either parses or it does not.
 */
export function lzwDecode(input: string): string {
  if (input.length === 0) return '';
  const dictionary = new Map<number, string>();
  let currentChar = input[0]!;
  let oldPhrase = currentChar;
  const out: string[] = [currentChar];
  let code = 256;

  for (let i = 1; i < input.length; i += 1) {
    const currentCode = input.charCodeAt(i);
    let phrase: string;
    if (currentCode < 256) {
      phrase = input[i]!;
    } else {
      const known = dictionary.get(currentCode);
      phrase = known !== undefined ? known : oldPhrase + currentChar;
    }
    out.push(phrase);
    currentChar = phrase.charAt(0);
    dictionary.set(code, oldPhrase + currentChar);
    code += 1;
    oldPhrase = phrase;
  }
  return out.join('');
}

interface Attempt {
  subscribe: string;
  statusCode: number | null;
  upgraded: boolean;
  framesReceived: number;
  /** The first frame exactly as it arrived, truncated only for readability. */
  rawSample: string | null;
  /** The same frame after LZW decoding. */
  decodedSample: string | null;
  /** Whether the decoded text is valid JSON — the test of the decoder. */
  decodedParses: boolean;
  /** The decoded object's field names, which is what the parser will be built on. */
  decodedKeys: string[] | null;
  error: string | null;
  waitedMs: number;
}

async function tryOne(subscribe: string): Promise<Attempt> {
  const started = Date.now();
  const attempt: Attempt = {
    subscribe,
    statusCode: null,
    upgraded: false,
    framesReceived: 0,
    rawSample: null,
    decodedSample: null,
    decodedParses: false,
    decodedKeys: null,
    error: null,
    waitedMs: 0,
  };

  try {
    const response = await fetch(UPSTREAM, { headers: { Upgrade: 'websocket' } });
    attempt.statusCode = response.status;
    const socket = response.webSocket;

    if (socket === null || socket === undefined) {
      attempt.error = 'the response carried no WebSocket — the upgrade was not accepted';
    } else {
      socket.accept();
      attempt.upgraded = true;
      socket.send(subscribe);

      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, WAIT_MS);
        const done = (): void => {
          clearTimeout(timer);
          resolve();
        };
        socket.addEventListener('message', (event) => {
          attempt.framesReceived += 1;
          if (attempt.rawSample === null) {
            const raw =
              typeof event.data === 'string'
                ? event.data
                : `[binary frame, ${(event.data as ArrayBuffer).byteLength} bytes]`;
            attempt.rawSample = raw.slice(0, 400);
            if (typeof event.data === 'string') {
              const decoded = lzwDecode(event.data);
              attempt.decodedSample = decoded.slice(0, 900);
              try {
                const parsed = JSON.parse(decoded) as Record<string, unknown>;
                attempt.decodedParses = true;
                // The field names are the whole point: they decide the parser,
                // and the timestamp's magnitude decides its units.
                attempt.decodedKeys = Object.keys(parsed);
              } catch {
                attempt.decodedParses = false;
              }
            }
          }
          if (attempt.framesReceived >= MAX_FRAMES) done();
        });
        socket.addEventListener('close', done);
        socket.addEventListener('error', () => {
          attempt.error = 'the socket reported an error after opening';
          done();
        });
      });

      try {
        socket.close();
      } catch {
        /* already closing */
      }
    }
  } catch (caught) {
    attempt.error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }

  attempt.waitedMs = Date.now() - started;
  return attempt;
}

export async function handleBlitzortungProbe(): Promise<Response> {
  const attempts: Attempt[] = [];
  for (const subscribe of SUBSCRIBE_CANDIDATES) {
    const attempt = await tryOne(subscribe);
    attempts.push(attempt);
    // Stop at the first one that actually delivers. Trying the rest would only
    // add load to a volunteer network to learn nothing new.
    if (attempt.framesReceived > 0) break;
  }

  const working = attempts.find((attempt) => attempt.framesReceived > 0) ?? null;

  return new Response(
    JSON.stringify(
      {
        ok: working !== null,
        diagnostic: 'blitzortung-payload',
        note: 'Asks from Cloudflare, because that is where the relay connects from. Not a data feed.',
        upstream: UPSTREAM,
        // The one finding the relay needs: which subscription actually works.
        workingSubscribe: working?.subscribe ?? null,
        decoderProducesJson: working?.decodedParses ?? false,
        attempts,
      },
      null,
      2,
    ),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
