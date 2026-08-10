import type { DataModule } from '../core/types.js';

/**
 * The module registry.
 *
 * Adding a feed to this site is: create one file under `src/modules/`, and add
 * one import line below. Nothing else. The catalog, the filters, the status
 * strips, the lifecycle management and the global counter all pick it up from
 * here.
 *
 * Modules self-register by calling `register()` at import time.
 */

const registered = new Map<string, DataModule>();

export function register(module: DataModule): void {
  if (registered.has(module.id)) {
    // Two modules sharing an id would silently shadow one another, and the
    // catalog would quietly show one fewer feed than the site claims.
    throw new Error(`Duplicate module id "${module.id}" — ids must be unique.`);
  }
  registered.set(module.id, module);
}

export function allModules(): DataModule[] {
  return [...registered.values()];
}

export function moduleById(id: string): DataModule | undefined {
  return registered.get(id);
}

export function moduleCount(): number {
  return registered.size;
}

// --- registrations -------------------------------------------------------
// One import line per feed. Keep them grouped by section, in catalog order.
//
// Step 3 adds the three reference modules covering the direct transports:
//   import './usgs-earthquakes.js';     // Lane A, poll
//   import './wikipedia-changes.js';    // Lane A, SSE
//   import './binance-trades.js';       // Lane A, WebSocket
//
// Nothing is registered yet. The catalog renders that as an explicit empty
// state rather than as placeholder cards: until a feed is wired to a verified
// endpoint, it does not exist on this site.
