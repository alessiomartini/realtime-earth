import { describe, expect, it } from 'vitest';
import { allModules, moduleById, moduleCount } from './all.js';

/**
 * These exist because of a real failure. The feed imports originally sat at the
 * bottom of `registry.ts`, and ES imports are hoisted: every feed called
 * `register()` before the registry's Map had been created, and the entire site
 * died on load with "Cannot read properties of undefined". A typecheck cannot
 * catch that, and neither can a test that imports the registry alone — it only
 * shows up when the feed list is actually loaded.
 */

describe('the feed list loads', () => {
  it('registers every feed without an import-order failure', () => {
    expect(moduleCount()).toBeGreaterThan(0);
  });

  it('gives every feed a unique, routable id', () => {
    const ids = allModules().map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const id of ids) {
      // Ids appear in URLs as /m/<id>, so they must survive being a path segment.
      expect(id).toMatch(/^[a-z0-9-]+$/);
      expect(moduleById(id)?.id).toBe(id);
    }
  });

  it('gives every feed the provenance the site promises', () => {
    for (const module of allModules()) {
      expect(module.source.name, module.id).toBeTruthy();
      expect(module.source.url, module.id).toMatch(/^https:\/\//);
      expect(module.source.license, module.id).toBeTruthy();
      expect(module.source.attribution, module.id).toBeTruthy();
      expect(module.why.length, module.id).toBeGreaterThan(40);
      expect(module.cadence, module.id).toBeTruthy();
    }
  });

  it('starts every feed disconnected, with nothing received and no invented timestamp', () => {
    for (const module of allModules()) {
      expect(module.messageCount, module.id).toBe(0);
      expect(module.lastSourceTimestamp, module.id).toBeNull();
      expect(module.health, module.id).toBe('connecting');
    }
  });
});
