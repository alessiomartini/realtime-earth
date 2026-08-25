import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { ProxyModule, type ProxyEnvelope } from './proxy-module.js';
import type { SourceRef } from './types.js';

/**
 * Tests for the client half of Lane B.
 *
 * The bug this class exists to prevent is silent and invisible on screen: the
 * Worker answers every poll, and between refreshes it answers with the same
 * bytes. Counting those as arrivals would make a feed refreshed four times an
 * hour report hundreds of "messages received" — inflating the single number the
 * whole site's argument rests on, while looking completely normal.
 *
 * So the important assertions here are about what does NOT happen: no message
 * counted for a re-served cache entry, no source timestamp invented from our
 * own clock, no green state while the Worker is reporting that its refresh is
 * failing.
 *
 * The double below has no transport of its own — it drives ProxyModule's poll
 * loop against a stubbed `fetch`. Nothing it produces is ever displayed.
 */

const SOURCE: SourceRef = {
  name: 'Test',
  url: 'https://example.invalid',
  license: 'n/a',
  attribution: 'n/a',
};

interface Payload {
  value: number;
}

class ProbeProxy extends ProxyModule<Payload> {
  payloads: Payload[] = [];
  polls = 0;

  constructor() {
    super({
      id: 'probe-proxy',
      section: 'noosphere',
      title: 'Probe',
      oneLiner: 'test double',
      why: 'test double',
      transport: 'proxy-poll',
      lane: 'B',
      latencyClass: 'delayed',
      cadence: 'every 15 min',
      staleAfterMs: null,
      pollMs: 60_000,
      source: SOURCE,
    });
  }

  mount(): void {
    /* nothing to render */
  }

  protected onPayload(data: Payload): void {
    this.payloads.push(data);
  }

  protected onPolled(): void {
    this.polls += 1;
  }

  /** Exposed so the tests can read what the page would show. */
  get shownCacheLabel(): string {
    return this.cacheLabel();
  }

  get shownRefreshError(): string | null {
    return this.refreshError;
  }
}

function envelope(overrides: Partial<ProxyEnvelope<Payload>>): ProxyEnvelope<Payload> {
  return {
    ok: true,
    module: 'probe-proxy',
    lane: 'B',
    fetchedAt: '2026-08-25T00:00:00.000Z',
    fetchAgeSeconds: 30,
    cached: true,
    refreshEverySeconds: 900,
    sourceTimestamp: 1_787_614_200_000,
    count: 1,
    refreshError: null,
    data: { value: 1 },
    ...overrides,
  };
}

/** Queue of responses the stubbed fetch will hand back, one per poll. */
function stubFetch(responses: Array<{ status?: number; body: unknown }>): void {
  let index = 0;
  vi.stubGlobal('fetch', () => {
    const next = responses[Math.min(index, responses.length - 1)];
    index += 1;
    return Promise.resolve({
      status: next?.status ?? 200,
      json: () => Promise.resolve(next?.body),
    } as Response);
  });
}

/** Run the module's initial poll and let its promise chain settle. */
async function connectAndSettle(module: ProbeProxy): Promise<void> {
  module.connect();
  // Two turns: the fetch promise, then the json() promise.
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe('ProxyModule', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('counts a genuinely new payload as one received message', async () => {
    stubFetch([{ body: envelope({}) }]);
    const module = new ProbeProxy();
    await connectAndSettle(module);

    expect(module.payloads).toHaveLength(1);
    expect(module.messageCount).toBe(1);
    expect(module.health).toBe('ok');
    module.disconnect();
  });

  it('does NOT count a re-served cache entry as a new message', async () => {
    // Same fetchedAt on every poll: the Worker has not fetched anything new.
    stubFetch([{ body: envelope({}) }]);
    const module = new ProbeProxy();
    await connectAndSettle(module);

    for (let i = 0; i < 5; i += 1) {
      await vi.advanceTimersByTimeAsync(60_000);
    }

    // Six polls, one payload. The counter reflects what the source produced,
    // not how often we asked about it.
    expect(module.polls).toBeGreaterThan(1);
    expect(module.payloads).toHaveLength(1);
    expect(module.messageCount).toBe(1);
    module.disconnect();
  });

  it('counts the next refresh once the Worker’s fetch time changes', async () => {
    stubFetch([
      { body: envelope({}) },
      { body: envelope({ fetchedAt: '2026-08-25T00:15:00.000Z', data: { value: 2 } }) },
    ]);
    const module = new ProbeProxy();
    await connectAndSettle(module);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(module.payloads).toHaveLength(2);
    expect(module.messageCount).toBe(2);
    module.disconnect();
  });

  it('reports the source’s timestamp, never the Worker’s fetch time', async () => {
    stubFetch([{ body: envelope({}) }]);
    const module = new ProbeProxy();
    await connectAndSettle(module);

    expect(module.lastSourceTimestamp).toBe(1_787_614_200_000);
    expect(module.lastSourceTimestamp).not.toBe(Date.parse('2026-08-25T00:00:00.000Z'));
    module.disconnect();
  });

  it('leaves the age unknown when the source published no timestamp', async () => {
    stubFetch([{ body: envelope({ sourceTimestamp: null }) }]);
    const module = new ProbeProxy();
    await connectAndSettle(module);

    // Null, not our clock. An unknown age has to read as unknown.
    expect(module.lastSourceTimestamp).toBeNull();
    module.disconnect();
  });

  it('goes into error, with the Worker’s reason, when a refresh is failing', async () => {
    stubFetch([
      {
        body: envelope({
          refreshError: { at: '2026-08-25T00:20:00.000Z', reason: 'The GDELT Project answered HTTP 429.' },
        }),
      },
    ]);
    const module = new ProbeProxy();
    await connectAndSettle(module);

    // The payload is still delivered — it is real data and stays on screen —
    // but the feed does not get to look healthy while it is not being refreshed.
    expect(module.payloads).toHaveLength(1);
    expect(module.health).toBe('error');
    expect(module.errorReason).toBe('The GDELT Project answered HTTP 429.');
    expect(module.shownRefreshError).toBe('The GDELT Project answered HTTP 429.');
    module.disconnect();
  });

  it('surfaces the proxy’s own explanation when the route refuses', async () => {
    stubFetch([
      {
        status: 503,
        body: {
          ok: false,
          module: 'probe-proxy',
          lane: 'B',
          error: 'unavailable',
          message: 'FIRMS_MAP_KEY is not configured on this deployment.',
        },
      },
    ]);
    const module = new ProbeProxy();
    await connectAndSettle(module);

    expect(module.health).toBe('error');
    // Verbatim. A generic "unavailable" would throw away the only part of this
    // a reader can act on.
    expect(module.errorReason).toBe('FIRMS_MAP_KEY is not configured on this deployment.');
    expect(module.payloads).toHaveLength(0);
    module.disconnect();
  });

  it('describes the cache age as ours, and never as live', async () => {
    stubFetch([{ body: envelope({ fetchAgeSeconds: 360 }) }]);
    const module = new ProbeProxy();
    await connectAndSettle(module);

    const label = module.shownCacheLabel;
    expect(label).toContain('our Worker');
    expect(label).toContain('6m ago');
    expect(label).not.toContain('live');
    module.disconnect();
  });

  it('stops polling when disconnected', async () => {
    stubFetch([{ body: envelope({}) }]);
    const module = new ProbeProxy();
    await connectAndSettle(module);
    const pollsAtDisconnect = module.polls;

    module.disconnect();
    await vi.advanceTimersByTimeAsync(300_000);

    // A feed nobody is looking at must not keep asking. Lane B's whole purpose
    // is to make one request serve everyone; leaving orphaned pollers running
    // would undo that from the other end.
    expect(module.polls).toBe(pollsAtDisconnect);
  });
});
