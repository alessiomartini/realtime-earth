import { describe, expect, it } from 'vitest';
import { AisRelay, parsePositionReport, subscriptionMessage, VesselStore, type Vessel } from './ais-relay.js';

// Fake data only. Shape follows the aisstream.io PositionReport message.
const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);

function report(overrides: Record<string, unknown> = {}, meta: Record<string, unknown> = {}): string {
  return JSON.stringify({
    MessageType: 'PositionReport',
    MetaData: { MMSI: 123456789, ShipName: 'TEST VESSEL  ', ...meta },
    Message: {
      PositionReport: {
        UserID: 123456789,
        Latitude: 52.4,
        Longitude: 4.8,
        Sog: 12.3,
        Cog: 90.5,
        TrueHeading: 88,
        ...overrides,
      },
    },
  });
}

function vessel(mmsi: number, seenAt: number, name: string | null = null): Vessel {
  return { mmsi, lat: 1, lon: 2, sogKn: null, cogDeg: null, headingDeg: null, name, seenAt };
}

describe('parsePositionReport', () => {
  it('reads a position report', () => {
    expect(parsePositionReport(report(), NOW)).toEqual({
      mmsi: 123456789,
      lat: 52.4,
      lon: 4.8,
      sogKn: 12.3,
      cogDeg: 90.5,
      headingDeg: 88,
      name: 'TEST VESSEL',
      seenAt: NOW,
    });
  });

  it('turns the "not available" sentinels into null instead of fake values', () => {
    const v = parsePositionReport(report({ Sog: 102.3, Cog: 360, TrueHeading: 511 }), NOW);
    expect(v).toMatchObject({ sogKn: null, cogDeg: null, headingDeg: null });
  });

  it('drops positions that are the "not available" sentinels (lat 91, lon 181)', () => {
    expect(parsePositionReport(report({ Latitude: 91 }), NOW)).toBeNull();
    expect(parsePositionReport(report({ Longitude: 181 }), NOW)).toBeNull();
  });

  it('drops messages without a usable position or id', () => {
    expect(parsePositionReport(report({ Latitude: 'x' }), NOW)).toBeNull();
    expect(parsePositionReport(report({ Longitude: undefined }), NOW)).toBeNull();
    expect(parsePositionReport(report({ UserID: 0 }, { MMSI: undefined }), NOW)).toBeNull();
  });

  it('ignores other message types and non-JSON', () => {
    expect(parsePositionReport(JSON.stringify({ MessageType: 'ShipStaticData', Message: {} }), NOW)).toBeNull();
    expect(parsePositionReport('not json', NOW)).toBeNull();
    expect(parsePositionReport('null', NOW)).toBeNull();
    expect(parsePositionReport('{"error":"Api Key Is Not Valid"}', NOW)).toBeNull();
  });

  it('treats a blank ship name as unknown', () => {
    expect(parsePositionReport(report({}, { ShipName: '   ' }), NOW)?.name).toBeNull();
  });
});

describe('VesselStore', () => {
  it('keeps only the latest position per vessel', () => {
    const store = new VesselStore(10, 60_000);
    store.upsert({ ...vessel(1, NOW), lat: 10 });
    store.upsert({ ...vessel(1, NOW + 1000), lat: 20 });
    expect(store.size).toBe(1);
    expect(store.snapshot(NOW + 1000)[0]?.lat).toBe(20);
  });

  it('keeps an earlier name when a later message has none', () => {
    const store = new VesselStore(10, 60_000);
    store.upsert(vessel(1, NOW, 'NAMED'));
    store.upsert(vessel(1, NOW + 1, null));
    expect(store.snapshot(NOW + 1)[0]?.name).toBe('NAMED');
  });

  it('evicts the least recently heard vessel when over the cap', () => {
    const store = new VesselStore(3, 60_000);
    store.upsert(vessel(1, NOW));
    store.upsert(vessel(2, NOW + 1));
    store.upsert(vessel(3, NOW + 2));
    store.upsert(vessel(1, NOW + 3)); // 1 heard again, so 2 is now the oldest
    store.upsert(vessel(4, NOW + 4));
    const ids = store.snapshot(NOW + 5).map((v) => v.mmsi);
    expect(ids.sort()).toEqual([1, 3, 4]);
  });

  it('drops vessels older than the TTL, and keeps the rest', () => {
    const store = new VesselStore(10, 60_000);
    store.upsert(vessel(1, NOW));
    store.upsert(vessel(2, NOW + 50_000));
    expect(store.prune(NOW + 70_000)).toBe(1);
    expect(store.snapshot(NOW + 70_000).map((v) => v.mmsi)).toEqual([2]);
  });

  it('applies the TTL when taking a snapshot', () => {
    const store = new VesselStore(10, 60_000);
    store.upsert(vessel(1, NOW));
    expect(store.snapshot(NOW + 61_000)).toEqual([]);
  });
});

describe('subscriptionMessage', () => {
  it('asks for position reports only, over the world, with the given key', () => {
    expect(JSON.parse(subscriptionMessage('FAKE-KEY'))).toEqual({
      APIKey: 'FAKE-KEY',
      BoundingBoxes: [
        [
          [-90, -180],
          [90, 180],
        ],
      ],
      FilterMessageTypes: ['PositionReport'],
    });
  });
});

describe('AisRelay without the API key', () => {
  it('answers a plain GET with a clear disabled, empty snapshot and nothing breaks', async () => {
    for (const env of [{}, { AISSTREAM_API_KEY: '' }, { AISSTREAM_API_KEY: '   ' }]) {
      const relay = new AisRelay({} as DurableObjectState, env);
      const response = await relay.fetch(new Request('https://example.test/ws/ais-vessels'));
      expect(response.status).toBe(200);
      const body = (await response.json()) as Record<string, unknown>;
      expect(body).toMatchObject({ ok: true, enabled: false, upstream: 'disabled', vessels: [] });
      expect(String(body.reason)).toContain('AISSTREAM_API_KEY');
    }
  });

  it('reports enabled when a key is present, without opening anything for a plain GET', async () => {
    const relay = new AisRelay({} as DurableObjectState, { AISSTREAM_API_KEY: 'FAKE-KEY' });
    const body = (await (await relay.fetch(new Request('https://example.test/'))).json()) as Record<string, unknown>;
    expect(body).toMatchObject({ enabled: true, upstream: 'idle', vessels: [] });
  });
});
