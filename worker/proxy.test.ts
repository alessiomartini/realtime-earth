import { describe, expect, it } from 'vitest';
import {
  firmsRowTime,
  parseCsv,
  parseGdeltSeenDate,
  proxyCronExpressions,
  proxySourceById,
  shapeFirms,
  shapeGdelt,
} from './proxy.js';

/**
 * Lane B's parsers, tested where it matters: on the cases where the honest
 * answer is "unknown".
 *
 * Every one of these functions could be made to always return a number by
 * falling back to `Date.now()` on a malformed input, and every such fallback
 * would turn a missing source timestamp into a fresh-looking one. That is the
 * single most damaging bug this project can have, because it is invisible —
 * the page looks right. So the null paths are tested at least as hard as the
 * happy paths.
 */

describe('parseGdeltSeenDate', () => {
  it('reads GDELT’s own compact UTC stamp', () => {
    expect(parseGdeltSeenDate('20260825T101500Z')).toBe(Date.UTC(2026, 7, 25, 10, 15, 0));
  });

  it('returns null rather than guessing at anything else', () => {
    for (const bad of ['', '2026-08-25T10:15:00Z', '20260825T1015Z', 'yesterday', null, undefined, 42, {}]) {
      expect(parseGdeltSeenDate(bad)).toBeNull();
    }
  });
});

describe('shapeGdelt', () => {
  const body = JSON.stringify({
    articles: [
      { url: 'https://a.example/1', title: 'One', seendate: '20260825T101500Z', domain: 'a.example', language: 'English', sourcecountry: 'Italy' },
      { url: 'https://b.example/2', title: 'Two', seendate: '20260825T104500Z', domain: 'b.example', language: 'English', sourcecountry: 'Japan' },
      { url: 'https://c.example/3', title: 'Three', seendate: 'not-a-date', domain: 'c.example' },
    ],
  });

  it('reports the newest article time as the source timestamp', () => {
    const shaped = shapeGdelt(body);
    expect(shaped.sourceTimestamp).toBe(Date.UTC(2026, 7, 25, 10, 45, 0));
    expect(shaped.count).toBe(3);
  });

  it('keeps an unparseable time as unknown instead of dropping or inventing it', () => {
    const { articles } = shapeGdelt(body).data as { articles: Array<{ seenMs: number | null; title: string | null }> };
    // The article is still shown — it is real, and GDELT really published it.
    // Only its time is unknown, and unknown is displayable.
    expect(articles).toHaveLength(3);
    expect(articles[2]?.seenMs).toBeNull();
    expect(articles[2]?.title).toBe('Three');
  });

  it('reports no source timestamp at all when nothing carried one', () => {
    const shaped = shapeGdelt(JSON.stringify({ articles: [{ url: 'x', seendate: 'junk' }] }));
    expect(shaped.sourceTimestamp).toBeNull();
  });

  it('treats a payload with no articles as empty, not as an error', () => {
    const shaped = shapeGdelt(JSON.stringify({}));
    expect(shaped.count).toBe(0);
    expect(shaped.sourceTimestamp).toBeNull();
  });

  it('leaves missing fields null rather than filling them with placeholders', () => {
    const { articles } = shapeGdelt(JSON.stringify({ articles: [{ url: 'https://d.example' }] })).data as {
      articles: Array<Record<string, unknown>>;
    };
    expect(articles[0]).toMatchObject({ title: null, domain: null, language: null, country: null, seenMs: null });
  });
});

describe('parseCsv', () => {
  it('builds records from the file’s own header row', () => {
    const rows = parseCsv('latitude,longitude,frp\n1.5,2.5,10\n3.5,4.5,20\n');
    expect(rows).toEqual([
      { latitude: '1.5', longitude: '2.5', frp: '10' },
      { latitude: '3.5', longitude: '4.5', frp: '20' },
    ]);
  });

  it('returns nothing for an empty body instead of a phantom row', () => {
    expect(parseCsv('')).toEqual([]);
    expect(parseCsv('\n\n')).toEqual([]);
  });

  it('leaves short rows blank rather than shifting later columns into place', () => {
    // A truncated line must not silently move `frp` into `longitude`, which
    // would produce a plausible number in the wrong field.
    expect(parseCsv('latitude,longitude,frp\n1.5,2.5\n')).toEqual([{ latitude: '1.5', longitude: '2.5', frp: '' }]);
  });
});

describe('firmsRowTime', () => {
  it('combines FIRMS’s separate date and time columns', () => {
    expect(firmsRowTime({ acq_date: '2026-08-25', acq_time: '0146' })).toBe(Date.UTC(2026, 7, 25, 1, 46, 0));
  });

  it('pads a time FIRMS wrote without leading zeros', () => {
    expect(firmsRowTime({ acq_date: '2026-08-25', acq_time: '46' })).toBe(Date.UTC(2026, 7, 25, 0, 46, 0));
  });

  it('returns null when the columns that carry a time are not there', () => {
    expect(firmsRowTime({ latitude: '1' })).toBeNull();
    expect(firmsRowTime({ acq_date: '2026-08-25' })).toBeNull();
    expect(firmsRowTime({ acq_date: 'nonsense', acq_time: '0146' })).toBeNull();
  });
});

describe('shapeFirms', () => {
  it('reports the newest detection time and keeps untimed rows', () => {
    const shaped = shapeFirms(
      'latitude,longitude,acq_date,acq_time\n1,2,2026-08-25,0100\n3,4,2026-08-25,0300\n5,6,,\n',
    );
    expect(shaped.sourceTimestamp).toBe(Date.UTC(2026, 7, 25, 3, 0, 0));
    expect(shaped.count).toBe(3);
    const { detections } = shaped.data as { detections: Array<{ timeMs: number | null }> };
    expect(detections[2]?.timeMs).toBeNull();
  });
});

describe('the source registry', () => {
  it('resolves the routes the Worker serves', () => {
    expect(proxySourceById('gdelt-news')?.attribution).toBe('The GDELT Project');
    expect(proxySourceById('firms-fires')?.attribution).toBe('NASA FIRMS');
    expect(proxySourceById('not-a-feed')).toBeUndefined();
  });

  it('never puts a key in the URL it is willing to publish', () => {
    // `publicUrl` is echoed to every visitor. If a secret can reach it, the
    // "zero keys in the client bundle" criterion is satisfied and defeated at
    // the same time — the key just leaves through the response instead.
    for (const id of ['gdelt-news', 'firms-fires']) {
      expect(proxySourceById(id)?.publicUrl).not.toMatch(/[?/]([A-Za-z0-9]{20,})/);
    }
    expect(proxySourceById('firms-fires')?.publicUrl).toContain('<MAP_KEY>');
  });

  it('refuses to build a URL for a key-gated source when the key is absent', () => {
    const built = proxySourceById('firms-fires')?.buildUrl({});
    expect(built).toBeDefined();
    expect(built && 'missing' in built).toBe(true);
  });

  it('declares a cron for every source, so nothing is registered and never refreshed', () => {
    const crons = proxyCronExpressions();
    expect(crons.length).toBeGreaterThan(0);
    for (const id of ['gdelt-news', 'firms-fires']) {
      expect(crons).toContain(proxySourceById(id)?.cron);
    }
  });
});
