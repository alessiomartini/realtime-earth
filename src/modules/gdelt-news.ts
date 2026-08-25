import { ProxyModule, type ProxyEnvelope } from '../core/proxy-module.js';
import { RingBuffer } from '../core/ring-buffer.js';
import { register } from './registry.js';
import { el, formatAge } from './../ui/dom.js';

/**
 * The world's news, as GDELT indexes it. The first Lane B feed.
 *
 * Lane B for two independently verified reasons: the DOC API sends no
 * `access-control-allow-origin`, so a browser cannot read it at all; and it
 * documents one request every five seconds, which a public site polling
 * directly would breach with its third simultaneous visitor. The Worker fetches
 * it once every fifteen minutes and everyone reads that one copy.
 *
 * Both facts came out of verification, and so did a third worth recording: from
 * a GitHub runner every probe of GDELT returned 429, including the first
 * request of a run, while the same query from Cloudflare's egress returned 75
 * articles. The rate limit is per-origin and CI shares its address with
 * everything else on that runner. A source is not dead because it refused the
 * place you asked from.
 *
 * WHAT THE TIMESTAMPS MEAN HERE, because there are three of them and only one
 * is the data's own:
 *
 *   - `seendate` is GDELT's first-seen time for an article. That is the
 *     source's timestamp and the only one treated as data.
 *   - `fetchedAt` is when our Worker fetched the window. Shown, labelled as
 *     ours, never as the article's.
 *   - the poll that put it on screen is not shown at all, because it says
 *     nothing about the news.
 *
 * The opening payload is GDELT's last hour, which is real published history and
 * is counted as such: those articles existed before the page did, and folding
 * them into "arrived while you were watching" would inflate the one number the
 * whole site rests on.
 */

const TAPE_SIZE = 60;
/**
 * The Worker refreshes every 15 minutes; this only controls how fast a refresh
 * that already happened reaches the page. It costs GDELT nothing — every one of
 * these hits our own KV copy.
 */
const POLL_MS = 60_000;

interface Article {
  url: string | null;
  title: string | null;
  domain: string | null;
  language: string | null;
  country: string | null;
  /** GDELT's own first-seen time, in ms. Null when it published none we could read. */
  seenMs: number | null;
  /** True when it appeared after this page opened, rather than in the opening hour. */
  live: boolean;
}

interface GdeltPayload {
  articles: Array<{
    url: string | null;
    title: string | null;
    domain: string | null;
    language: string | null;
    country: string | null;
    seenMs: number | null;
  }>;
}

class GdeltNews extends ProxyModule<GdeltPayload> {
  #articles = new RingBuffer<Article>(400);
  #seen = new Set<string>();
  #opened = false;
  #liveCount = 0;
  #windowCount = 0;

  #summary: HTMLElement | null = null;
  #cacheLine: HTMLElement | null = null;
  #tape: HTMLElement | null = null;

  constructor() {
    super({
      id: 'gdelt-news',
      section: 'noosphere',
      title: 'The world’s news, being indexed',
      oneLiner: 'Every article GDELT has catalogued in the last hour, with the country and language it came from.',
      why: 'GDELT reads the world’s news media continuously and publishes what it has seen, in the open, every fifteen minutes. Watching the domains and source countries scroll past is the closest thing there is to a live readout of where the world is talking, and about how much.',
      transport: 'proxy-poll',
      lane: 'B',
      // Not "live", and the label is the point. GDELT publishes in quarter-hour
      // windows and we cache each one, so an article here is minutes old by
      // construction. Calling that live would be the exact lie this lane makes
      // easy.
      latencyClass: 'delayed',
      cadence: 'every 15 min',
      // Three refresh intervals. Long enough not to flap on one missed window,
      // short enough that a feed which quietly stopped updating says so.
      staleAfterMs: 45 * 60_000,
      historyNote:
        'Opens with the last hour of articles GDELT has already indexed — real published history, counted separately from what arrives afterwards.',
      pollMs: POLL_MS,
      source: {
        name: 'The GDELT Project — DOC 2.0 API',
        url: 'https://blog.gdeltproject.org/gdelt-doc-2-0-api-debuts/',
        license: 'Open data, free for any use with attribution',
        attribution: 'The GDELT Project',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    this.#summary = el('p', { class: 'module__summary' }, 'connecting…');
    // The cache age gets its own line rather than being tucked into the
    // summary. On a proxied feed it is the single most misreadable number on
    // the page, so it is given somewhere it cannot be skimmed past.
    this.#cacheLine = el('p', { class: 'module__latency' }, '');
    this.#tape = el('ol', { class: 'tape tape--news' });
    el_.append(this.#summary, this.#cacheLine, this.#tape);
    this.#render();
  }

  protected onPayload(data: GdeltPayload, _envelope: ProxyEnvelope<GdeltPayload>): void {
    const incoming = Array.isArray(data.articles) ? data.articles : [];
    this.#windowCount = incoming.length;

    let added = 0;
    for (const raw of incoming) {
      // The URL is the identity. An article with none cannot be deduplicated,
      // so it is skipped rather than risk showing the same story repeatedly on
      // every refresh.
      if (raw.url === null || this.#seen.has(raw.url)) continue;
      this.#seen.add(raw.url);
      this.#articles.push({ ...raw, live: this.#opened });
      added += 1;
      if (this.#opened) this.#liveCount += 1;
    }

    if (!this.#opened) {
      // The opening window is history: these were published before anyone
      // opened this page.
      this.markBackfilled(added);
      this.#opened = true;
    }

    // Bound the dedupe set. It exists to stop re-counting across refreshes and
    // must not grow for as long as the page is open.
    if (this.#seen.size > 1200) {
      this.#seen = new Set([...this.#articles].map((a) => a.url).filter((u): u is string => u !== null));
    }

    this.#render();
  }

  protected onPolled(): void {
    // Repainted on every poll even when nothing new arrived, so the cache age
    // keeps climbing. A snapshot whose age silently stops moving reads as
    // fresh, which is the failure this lane is most prone to.
    this.#render();
  }

  #render(): void {
    const now = Date.now();

    if (this.#summary !== null) {
      const countries = new Set(
        [...this.#articles].map((a) => a.country).filter((c): c is string => c !== null),
      );
      const byCountry = new Map<string, number>();
      for (const article of this.#articles) {
        if (article.country === null) continue;
        byCountry.set(article.country, (byCountry.get(article.country) ?? 0) + 1);
      }
      const busiest = [...byCountry.entries()].sort((a, b) => b[1] - a[1])[0];

      this.#summary.textContent =
        `${this.#windowCount} articles in GDELT’s current window · ` +
        `${countries.size} source countries · ` +
        (this.#liveCount > 0
          ? `${this.#liveCount} new since this page opened`
          : 'nothing new since this page opened') +
        (busiest ? ` · most represented: ${busiest[0]} (${busiest[1]})` : '');
    }

    if (this.#cacheLine !== null) {
      // Two clocks, both named. Neither is allowed to stand in for the other.
      const sourceAge =
        this.lastSourceTimestamp === null
          ? 'GDELT reported no timestamp for its newest article'
          : `newest article seen by GDELT ${formatAge(now - this.lastSourceTimestamp)} ago`;
      this.#cacheLine.textContent = `${sourceAge} · ${this.cacheLabel()}`;
    }

    if (this.#tape !== null) {
      const rows = [...this.#articles]
        // Unknown times sort last rather than being treated as ancient, which
        // sorting a null as zero would do.
        .sort((a, b) => (b.seenMs ?? -Infinity) - (a.seenMs ?? -Infinity))
        .slice(0, TAPE_SIZE);

      this.#tape.replaceChildren(
        ...rows.map((article) =>
          el(
            'li',
            { class: article.live ? 'tape__row tape__row--live' : 'tape__row' },
            el('span', { class: 'tape__wiki' }, article.country ?? '—'),
            article.url === null
              ? el('span', { class: 'tape__title' }, article.title ?? 'untitled')
              : el(
                  'a',
                  {
                    class: 'tape__title',
                    href: article.url,
                    rel: 'noopener noreferrer',
                    target: '_blank',
                  },
                  article.title ?? article.url,
                ),
            el('span', { class: 'tape__user' }, article.domain ?? '—'),
            el(
              'span',
              {
                class: article.seenMs === null ? 'tape__delta is-absent' : 'tape__delta',
                ...(article.seenMs === null ? {} : { title: new Date(article.seenMs).toISOString() }),
              },
              // "—" rather than a fabricated time. An article whose stamp we
              // could not read has an unknown time, and unknown is displayable.
              article.seenMs === null ? '—' : `${formatAge(now - article.seenMs)} ago`,
            ),
          ),
        ),
      );

      if (rows.length === 0) {
        this.#tape.replaceChildren(
          el('li', { class: 'tape__row' }, el('span', { class: 'tape__title' }, 'no articles in this window yet')),
        );
      }
    }
  }
}

register(new GdeltNews());
