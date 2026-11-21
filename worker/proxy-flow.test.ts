import { afterEach, describe, expect, it, vi } from 'vitest';
import { ADSB_LOL_KEY_HEADER, handleProxy, proxySourceById, refreshForCron, refreshSource } from './proxy.js';

/**
 * Lane B's storage flow: cache hit/miss, failure handling and the scheduled
 * refresh, against an in-memory KV and a mocked `fetch`.
 */

function fakeKv(): KVNamespace & { store: Map<string, string> } {
  const store = new Map<string, string>();
  return {
    store,
    get: async (key: string, type?: string) => {
      const value = store.get(key);
      if (value === undefined) return null;
      return type === 'json' ? JSON.parse(value) : value;
    },
    put: async (key: string, value: string) => {
      store.set(key, value);
    },
    delete: async (key: string) => {
      store.delete(key);
    },
  } as unknown as KVNamespace & { store: Map<string, string> };
}

const GDELT_BODY = JSON.stringify({
  articles: [{ url: 'https://example.org/a', title: 'A', seendate: '20261031T101500Z', domain: 'example.org' }],
});

const ADSB_BODY = JSON.stringify({
  now: 1794657546010,
  total: 1,
  ac: [{ hex: '398566', flight: 'HOP51BV ', t: 'E190', alt_baro: 36625, gs: 430.9, track: 159.63, lat: 50.1, lon: 8.2, seen_pos: 0.4 }],
});

const gdelt = proxySourceById('gdelt-news')!;
const adsb = proxySourceById('adsb-lol-aircraft')!;

function mockFetch(impl: () => Response | Promise<Response>) {
  const spy = vi.fn(async () => impl());
  vi.stubGlobal('fetch', spy);
  return spy;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const asJson = async (res: Response): Promise<any> => res.json();

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('handleProxy', () => {
  it('reports a missing KV binding as a 503, not a crash', async () => {
    const res = await handleProxy(gdelt, {});
    expect(res.status).toBe(503);
    expect((await asJson(res)).error).toBe('no_cache_binding');
  });

  it('on a cold cache fetches once, stores it and labels it uncached', async () => {
    const kv = fakeKv();
    const spy = mockFetch(() => new Response(GDELT_BODY));
    const res = await handleProxy(gdelt, { FEED_CACHE: kv });
    const body = await asJson(res);
    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.cached).toBe(false);
    expect(body.count).toBe(1);
    expect(kv.store.has('feed:gdelt-news')).toBe(true);
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('on a hit serves KV without touching upstream and keeps the original fetchedAt', async () => {
    const kv = fakeKv();
    mockFetch(() => new Response(GDELT_BODY));
    const first = await asJson(await handleProxy(gdelt, { FEED_CACHE: kv }));
    const spy = mockFetch(() => new Response('should not be called', { status: 500 }));
    const second = await asJson(await handleProxy(gdelt, { FEED_CACHE: kv }));
    expect(spy).not.toHaveBeenCalled();
    expect(second.cached).toBe(true);
    expect(second.fetchedAt).toBe(first.fetchedAt);
    expect(second.refreshError).toBeNull();
  });

  it('answers 503 with the upstream reason when cold and upstream fails', async () => {
    const kv = fakeKv();
    mockFetch(() => new Response('nope', { status: 500 }));
    const res = await handleProxy(gdelt, { FEED_CACHE: kv });
    const body = await asJson(res);
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.message).toContain('HTTP 500');
  });
});

describe('refreshSource', () => {
  it('keeps the last good payload, byte for byte, when a refresh fails, and records why', async () => {
    const kv = fakeKv();
    mockFetch(() => new Response(GDELT_BODY));
    await refreshSource(gdelt, { FEED_CACHE: kv });
    const good = kv.store.get('feed:gdelt-news');

    mockFetch(() => new Response('', { status: 503 }));
    const outcome = await refreshSource(gdelt, { FEED_CACHE: kv });
    expect(outcome.failure?.reason).toContain('HTTP 503');
    expect(kv.store.get('feed:gdelt-news')).toBe(good);

    const served = await asJson(await handleProxy(gdelt, { FEED_CACHE: kv }));
    expect(served.ok).toBe(true);
    expect(served.refreshError.reason).toContain('HTTP 503');
  });

  it('clears the failure record after a later success', async () => {
    const kv = fakeKv();
    mockFetch(() => new Response('', { status: 503 }));
    await refreshSource(gdelt, { FEED_CACHE: kv });
    expect(kv.store.has('feed:gdelt-news:error')).toBe(true);
    mockFetch(() => new Response(GDELT_BODY));
    await refreshSource(gdelt, { FEED_CACHE: kv });
    expect(kv.store.has('feed:gdelt-news:error')).toBe(false);
  });

  it('turns a network error into a failure value instead of throwing', async () => {
    const kv = fakeKv();
    mockFetch(() => {
      throw new Error('boom');
    });
    const outcome = await refreshSource(gdelt, { FEED_CACHE: kv });
    expect(outcome.failure?.reason).toContain('boom');
  });

  it('does not fetch a key-gated source without its key and names the secret', async () => {
    const kv = fakeKv();
    const spy = mockFetch(() => new Response(''));
    const outcome = await refreshSource(proxySourceById('firms-fires')!, { FEED_CACHE: kv });
    expect(spy).not.toHaveBeenCalled();
    expect(outcome.failure?.reason).toContain('FIRMS_MAP_KEY');
  });

  it('waits and retries once on a 429 when patient, and not otherwise', async () => {
    vi.useFakeTimers();
    const kv = fakeKv();
    let calls = 0;
    const spy = mockFetch(() => (++calls === 1 ? new Response('', { status: 429 }) : new Response(GDELT_BODY)));
    const pending = refreshSource(gdelt, { FEED_CACHE: kv }, { patientOn429: true });
    await vi.advanceTimersByTimeAsync(8_000);
    expect((await pending).entry?.count).toBe(1);
    expect(spy).toHaveBeenCalledTimes(2);

    calls = 0;
    spy.mockClear();
    const impatient = await refreshSource(gdelt, { FEED_CACHE: kv });
    expect(impatient.failure?.reason).toContain('429');
    expect(spy).toHaveBeenCalledTimes(1);
  });
});

describe('adsb.lol route without a key', () => {
  it('answers 503 naming the secret and makes no network call', async () => {
    const spy = mockFetch(() => new Response(ADSB_BODY));
    const res = await handleProxy(adsb, { FEED_CACHE: fakeKv() });
    const body = await asJson(res);
    expect(res.status).toBe(503);
    expect(body.ok).toBe(false);
    expect(body.error).toBe('unavailable');
    expect(body.message).toContain('ADSB_LOL_API_KEY');
    expect(spy).not.toHaveBeenCalled();
  });

  it('serves data when the key is set', async () => {
    mockFetch(() => new Response(ADSB_BODY));
    const res = await handleProxy(adsb, { FEED_CACHE: fakeKv(), ADSB_LOL_API_KEY: 'test-key' });
    expect(res.status).toBe(200);
    expect((await asJson(res)).count).toBe(1);
  });
});

describe('refreshForCron', () => {
  it('refreshes only the sources whose cron fired', async () => {
    const kv = fakeKv();
    // GDELT and adsb.lol share one cron slot, so both are due; FIRMS and
    // Meteored (other slots) must stay untouched.
    const spy = vi.fn(async (url: string) =>
      new Response(String(url).includes('adsb.lol') ? ADSB_BODY : GDELT_BODY),
    );
    vi.stubGlobal('fetch', spy);
    const log = await refreshForCron(gdelt.cron, { FEED_CACHE: kv, ADSB_LOL_API_KEY: 'test-key' });
    expect(log).toHaveLength(2);
    expect(log.join(' ')).toContain('gdelt-news');
    expect(log.join(' ')).toContain('adsb-lol-aircraft: 1 records');
    expect(spy).toHaveBeenCalledTimes(2);
    expect([...kv.store.keys()].sort()).toEqual(['feed:adsb-lol-aircraft', 'feed:gdelt-news']);
  });

  it('skips adsb.lol entirely without ADSB_LOL_API_KEY: no request to it, no data', async () => {
    const kv = fakeKv();
    const spy = vi.fn(async (url: string) => {
      if (String(url).includes('adsb.lol')) throw new Error('adsb.lol must not be called');
      return new Response(GDELT_BODY);
    });
    vi.stubGlobal('fetch', spy);
    const log = await refreshForCron(gdelt.cron, { FEED_CACHE: kv });
    expect(log.join(' ')).toContain('adsb-lol-aircraft: ADSB_LOL_API_KEY is not configured');
    expect(spy).toHaveBeenCalledTimes(1);
    expect(kv.store.has('feed:adsb-lol-aircraft')).toBe(false);
  });

  it('sends the adsb.lol key in the documented header when configured', async () => {
    const kv = fakeKv();
    const spy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(ADSB_BODY));
    vi.stubGlobal('fetch', spy);
    const outcome = await refreshSource(adsb, { FEED_CACHE: kv, ADSB_LOL_API_KEY: 'test-key' });
    expect(outcome.entry?.count).toBe(1);
    const headers = spy.mock.calls[0]![1]!.headers as Record<string, string>;
    expect(headers[ADSB_LOL_KEY_HEADER]).toBe('test-key');
  });

  it('does nothing for an unknown cron', async () => {
    const spy = mockFetch(() => new Response(GDELT_BODY));
    expect(await refreshForCron('0 0 1 1 *', { FEED_CACHE: fakeKv() })).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
