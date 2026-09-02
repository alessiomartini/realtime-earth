/**
 * The feed list. One import line per feed — this is the "add one file, add one
 * line" seam.
 *
 * It lives apart from `registry.ts` on purpose. ES imports are hoisted, so
 * importing feeds from inside the registry would run their `register()` calls
 * before the registry's own Map existed. Here the registry is imported first
 * and the feeds after, which is an order the language actually guarantees.
 */

import './registry.js';

import './binance-btc.js'; //        markets   — Lane A, WebSocket + klines history
import './usgs-earthquakes.js'; //   earth     — Lane A, poll + 24h history
import './weather-field.js'; //      earth     — Lane A, poll, 17 fields, zoomable grid
import './wikipedia-changes.js'; //  noosphere — Lane A, SSE, no history available
import './gdelt-news.js'; //         noosphere — Lane B, Worker proxy + KV, 1h history

export { allModules, moduleById, moduleCount } from './registry.js';
