/**
 * A diagnostic for Meteored, not a feed.
 *
 * Meteored's exact element names have never been observed, because every
 * request without a registered and activated account is refused. The shaper
 * therefore tries several candidate names per field and reports which matched —
 * a design for working under uncertainty, not a substitute for evidence.
 *
 * This closes that gap the moment a key exists. It fetches once and returns the
 * raw XML alongside a census of every element in it, so the real schema can be
 * read off a real response and the candidate lists corrected from evidence
 * rather than guessed at again.
 *
 * Without a key it says so, in the same words the feed uses. Nothing here is
 * ever displayed as data.
 */

import { elementCensus, parseXml } from './xml.js';
import type { ProxyEnv } from './proxy.js';

export async function handleMeteoredProbe(env: ProxyEnv): Promise<Response> {
  const key = env.METEORED_AFFILIATE_ID;
  const locality = env.METEORED_LOCALITY ?? '3117735';

  if (key === undefined || key === '') {
    return new Response(
      JSON.stringify(
        {
          ok: false,
          diagnostic: 'meteored-schema',
          error: 'not_configured',
          message:
            'METEORED_AFFILIATE_ID is not configured. Register at tiempo.com, get the account ACTIVATED — the API distinguishes the two — then `wrangler secret put METEORED_AFFILIATE_ID`.',
        },
        null,
        2,
      ),
      { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
    );
  }

  const url = `https://api.tiempo.com/index.php?api_lang=en&localidad=${encodeURIComponent(locality)}&affiliate_id=${encodeURIComponent(key)}`;
  let body = '';
  let status: number | null = null;
  let error: string | null = null;

  try {
    const response = await fetch(url, {
      headers: { 'user-agent': 'realtime-earth/1.0 (+https://realtime-earth.alemarti-2001.workers.dev)' },
      signal: AbortSignal.timeout(20_000),
    });
    status = response.status;
    body = await response.text();
  } catch (caught) {
    error = caught instanceof Error ? `${caught.name}: ${caught.message}` : String(caught);
  }

  const root = body === '' ? null : parseXml(body);

  return new Response(
    JSON.stringify(
      {
        ok: error === null && root !== null,
        diagnostic: 'meteored-schema',
        note: 'Reveals the real element names so the shaper’s candidate lists can be corrected from evidence. Not a data feed.',
        // The key never appears here, only the locality it was asked about.
        locality,
        status,
        error,
        parsedAsXml: root !== null,
        // The finding: every element name the response actually contained.
        census: root === null ? null : elementCensus(root),
        rawSample: body.slice(0, 3000),
      },
      null,
      2,
    ),
    { status: 200, headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' } },
  );
}
