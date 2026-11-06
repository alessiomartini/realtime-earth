/**
 * Classifying "Binance is not reachable" for the visitor.
 *
 * Binance answers HTTP 451 ("Service unavailable from a restricted location")
 * to blocked countries, sometimes 403 from its CDN. A browser cannot read the
 * status of a blocked WebSocket handshake, and a 451 without CORS headers
 * surfaces as a bare fetch TypeError, so for those cases the honest statement
 * is "unreachable, probably geo-restriction", not a certainty.
 */

export const GEO_BLOCKED_MESSAGE =
  'Binance is not reachable from your location (geo-restricted). Data unavailable.';
export const UNREACHABLE_MESSAGE =
  'Binance could not be reached: either it restricts your location or the network blocked the connection. Data unavailable.';

export interface BinanceFailure {
  /** HTTP status, when a response was actually readable. */
  status?: number;
  /** Response body text, if any. */
  body?: string;
  /** A fetch TypeError / WebSocket error or close before the first message. */
  network?: boolean;
}

export function isGeoBlocked({ status, body }: BinanceFailure): boolean {
  if (status === 451 || status === 403) return true;
  return typeof body === 'string' && /restricted location/i.test(body);
}

/** The message to show, or null when the failure is not a reachability problem. */
export function binanceFailureMessage(failure: BinanceFailure): string | null {
  if (isGeoBlocked(failure)) return GEO_BLOCKED_MESSAGE;
  if (failure.network === true) return UNREACHABLE_MESSAGE;
  return null;
}
