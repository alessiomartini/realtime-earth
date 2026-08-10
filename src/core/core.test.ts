import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { RingBuffer } from './ring-buffer.js';
import { Backoff } from './backoff.js';
import { BaseModule } from './base-module.js';
import type { SourceRef } from './types.js';

/**
 * Tests for the machinery every feed depends on.
 *
 * These exercise the honesty guarantees, not just the mechanics: that a silent
 * feed becomes `stale` rather than staying green, that a disconnected module
 * does not report itself as healthy, and that the buffer's bound is hard.
 *
 * The module used here is a test double with no transport at all. It never
 * ships, is never registered, and renders nothing — it exists to drive
 * BaseModule's state machine directly. That is not a mock feed in the sense the
 * project forbids: nothing it produces is ever displayed as data.
 */

const SOURCE: SourceRef = {
  name: 'Test',
  url: 'https://example.invalid',
  license: 'n/a',
  attribution: 'n/a',
};

class ProbeModule extends BaseModule {
  opened = 0;
  closed = 0;

  constructor(staleAfterMs: number | null = 3_000) {
    super({
      id: 'probe',
      section: 'earth',
      title: 'Probe',
      oneLiner: 'test double',
      why: 'test double',
      transport: 'poll',
      lane: 'A',
      latencyClass: 'live',
      cadence: 'every 1s',
      source: SOURCE,
      staleAfterMs,
      backoff: { baseMs: 100, maxMs: 800, factor: 2 },
    });
  }

  mount(): void {
    /* nothing to render */
  }

  protected openStream(): void {
    this.opened += 1;
  }

  protected closeStream(): void {
    this.closed += 1;
  }

  // Expose the protected reporting API to the test.
  receive(sourceTimestamp: number | null): void {
    this.markReceived(sourceTimestamp);
  }

  breakDown(reason: string, retry = true): void {
    this.fail(reason, { retry });
  }
}

describe('RingBuffer', () => {
  it('never exceeds its capacity, however much is written', () => {
    const buffer = new RingBuffer<number>(3);
    for (let i = 0; i < 1_000; i += 1) buffer.push(i);
    expect(buffer.size).toBe(3);
    expect(buffer.toArray()).toEqual([997, 998, 999]);
  });

  it('reports what was written even after overwriting, so losses are knowable', () => {
    const buffer = new RingBuffer<number>(2);
    buffer.push(1);
    buffer.push(2);
    expect(buffer.overwriting).toBe(false);
    buffer.push(3);
    expect(buffer.written).toBe(3);
    expect(buffer.overwriting).toBe(true);
  });

  it('iterates oldest to newest without allocating', () => {
    const buffer = new RingBuffer<string>(3);
    for (const value of ['a', 'b', 'c', 'd']) buffer.push(value);
    expect([...buffer]).toEqual(['b', 'c', 'd']);
    expect(buffer.last).toBe('d');
  });

  it('rejects a capacity that would make the bound meaningless', () => {
    expect(() => new RingBuffer(0)).toThrow(RangeError);
  });

  it('drops references on clear but keeps the record of what arrived', () => {
    const buffer = new RingBuffer<number>(4);
    buffer.push(1);
    buffer.push(2);
    buffer.clear();
    expect(buffer.size).toBe(0);
    expect(buffer.last).toBeUndefined();
    expect(buffer.written).toBe(2);
  });
});

describe('Backoff', () => {
  it('grows exponentially up to the cap', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const backoff = new Backoff({ baseMs: 100, maxMs: 800, factor: 2 });
    expect(backoff.next()).toBe(100);
    expect(backoff.next()).toBe(200);
    expect(backoff.next()).toBe(400);
    expect(backoff.next()).toBe(800);
    expect(backoff.next()).toBe(800);
    vi.restoreAllMocks();
  });

  it('jitters within the cap so retries do not synchronise', () => {
    vi.spyOn(Math, 'random').mockReturnValue(0.25);
    const backoff = new Backoff({ baseMs: 100, factor: 2 });
    expect(backoff.next()).toBe(25);
    vi.restoreAllMocks();
  });

  it('resets after a success', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const backoff = new Backoff({ baseMs: 100, factor: 2 });
    backoff.next();
    backoff.next();
    backoff.reset();
    expect(backoff.attempt).toBe(0);
    expect(backoff.next()).toBe(100);
    vi.restoreAllMocks();
  });
});

describe('BaseModule', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('counts received messages and keeps the source timestamp verbatim', () => {
    const probe = new ProbeModule();
    probe.connect();
    probe.receive(1_700_000_000_000);
    expect(probe.messageCount).toBe(1);
    // Not our clock: exactly what the source said.
    expect(probe.lastSourceTimestamp).toBe(1_700_000_000_000);
    expect(probe.health).toBe('ok');
  });

  it('leaves the source timestamp null when the source gave none', () => {
    const probe = new ProbeModule();
    probe.connect();
    probe.receive(null);
    expect(probe.messageCount).toBe(1);
    expect(probe.lastSourceTimestamp).toBeNull();
  });

  it('goes stale when nothing arrives within the expected window', () => {
    const probe = new ProbeModule(3_000);
    probe.connect();
    probe.receive(Date.now());
    expect(probe.health).toBe('ok');

    vi.advanceTimersByTime(2_999);
    expect(probe.health).toBe('ok');

    vi.advanceTimersByTime(2);
    // A feed that stopped talking says so. It does not stay green.
    expect(probe.health).toBe('stale');
  });

  it('recovers from stale when data resumes', () => {
    const probe = new ProbeModule(1_000);
    probe.connect();
    probe.receive(Date.now());
    vi.advanceTimersByTime(1_500);
    expect(probe.health).toBe('stale');
    probe.receive(Date.now());
    expect(probe.health).toBe('ok');
  });

  it('never goes stale when there is no cadence to miss', () => {
    const probe = new ProbeModule(null);
    probe.connect();
    probe.receive(Date.now());
    vi.advanceTimersByTime(60 * 60 * 1000);
    expect(probe.health).toBe('ok');
  });

  it('reports a failure with its reason instead of rendering as empty', () => {
    const probe = new ProbeModule();
    probe.connect();
    probe.breakDown('403 from upstream', false);
    expect(probe.health).toBe('error');
    expect(probe.errorReason).toBe('403 from upstream');
  });

  it('retries with backoff after a failure, and stops once disconnected', () => {
    vi.spyOn(Math, 'random').mockReturnValue(1);
    const probe = new ProbeModule();
    probe.connect();
    expect(probe.opened).toBe(1);

    probe.breakDown('upstream closed');
    vi.advanceTimersByTime(100);
    expect(probe.opened).toBe(2);

    probe.breakDown('upstream closed again');
    probe.disconnect();
    vi.advanceTimersByTime(10_000);
    // No reconnect after disconnect: a torn-down module stays torn down.
    expect(probe.opened).toBe(2);
    vi.restoreAllMocks();
  });

  it('does not report itself healthy once disconnected', () => {
    const probe = new ProbeModule();
    probe.connect();
    probe.receive(Date.now());
    expect(probe.health).toBe('ok');
    probe.disconnect();
    expect(probe.health).not.toBe('ok');
    expect(probe.closed).toBe(1);
  });

  it('clears its stale timer on disconnect so a torn-down module has no timers left', () => {
    const probe = new ProbeModule(1_000);
    probe.connect();
    probe.receive(Date.now());
    probe.disconnect();
    vi.advanceTimersByTime(5_000);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('is idempotent: connecting twice opens one stream', () => {
    const probe = new ProbeModule();
    probe.connect();
    probe.connect();
    expect(probe.opened).toBe(1);
  });
});
