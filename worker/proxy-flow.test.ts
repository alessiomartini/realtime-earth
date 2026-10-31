import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleProxy, proxySourceById, refreshForCron, refreshSource } from './proxy.js';

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

const gdelt = proxySourceById('gdelt-news')!;

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

describe('refreshForCron', () => {
  it('refreshes only the sources whose cron fired', async () => {
    const kv = fakeKv();
    const spy = mockFetch(() => new Response(GDELT_BODY));
    const log = await refreshForCron(gdelt.cron, { FEED_CACHE: kv });
    expect(log).toHaveLength(1);
    expect(log[0]).toContain('gdelt-news');
    expect(spy).toHaveBeenCalledTimes(1);
    expect([...kv.store.keys()]).toEqual(['feed:gdelt-news']);
  });

  it('does nothing for an unknown cron', async () => {
    const spy = mockFetch(() => new Response(GDELT_BODY));
    expect(await refreshForCron('0 0 1 1 *', { FEED_CACHE: fakeKv() })).toEqual([]);
    expect(spy).not.toHaveBeenCalled();
  });
});
