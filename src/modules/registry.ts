import type { DataModule } from '../core/types.js';

/**
 * The module registry.
 *
 * Adding a feed to this site is: create one file under `src/modules/`, and add
 * one import line to `all.ts`. Nothing else. The grid, the filters, the status
 * strips, the lifecycle management and the global counter all pick it up.
 *
 * Modules self-register by calling `register()` at import time.
 *
 * THIS FILE MUST NOT IMPORT ANY MODULE. ES imports are hoisted above the rest
 * of a module's body, so an `import './some-feed.js'` here would run that
 * feed's `register()` call before the Map below had been created — and the
 * whole site would fail to start. The import list therefore lives in `all.ts`,
 * which imports this file first and the feeds after.
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
