import { BaseModule } from '../core/base-module.js';
import { RingBuffer } from '../core/ring-buffer.js';
import { register } from './registry.js';
import { el } from '../ui/dom.js';

/**
 * Wikipedia edits, live. Server-Sent Events — NOT a WebSocket, a detail worth
 * stating because the endpoint is routinely mistaken for one.
 *
 * This feed has no history endpoint we can open with, so it opens empty and
 * says so. Fabricating a plausible backlog would be exactly the invention the
 * third principle rules out, and there is no honest alternative: the stream
 * begins when you start listening.
 *
 * The rate is high enough that rendering every edit would cost more than it
 * conveys, so the tape shows a sample and states the sampling ratio. Dropping
 * is honest; averaging would not be. Nothing shown is a blend of several edits.
 */

const STREAM_URL = 'https://stream.wikimedia.org/v2/stream/recentchange';
const TAPE_SIZE = 18;

interface Edit {
  wiki: string;
  title: string;
  user: string;
  bot: boolean;
  delta: number | null;
  /** The wiki's own edit timestamp, in ms. */
  time: number;
}

interface RecentChange {
  wiki?: unknown;
  title?: unknown;
  user?: unknown;
  bot?: unknown;
  type?: unknown;
  timestamp?: unknown;
  length?: { old?: unknown; new?: unknown };
}

class WikipediaChanges extends BaseModule {
  #tapeBuffer = new RingBuffer<Edit>(TAPE_SIZE);
  #source: EventSource | null = null;
  #tape: HTMLElement | null = null;
  #stats: HTMLElement | null = null;
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  #dirty = false;

  #received = 0;
  #shown = 0;
  #bots = 0;
  #humans = 0;
  /** Arrival times, for a rate measured from real arrivals rather than assumed. */
  #recentArrivals = new RingBuffer<number>(400);
  #byWiki = new Map<string, number>();

  constructor() {
    super({
      id: 'wikipedia-changes',
      section: 'noosphere',
      title: 'Wikipedia, being written',
      oneLiner: 'Every edit to every Wikimedia wiki, the moment it is saved.',
      why: 'A continuous, public record of an encyclopedia being written by the world — several edits every second, across hundreds of languages, with bots and humans plainly distinguishable. Few things make the scale of collective knowledge work this legible.',
      transport: 'sse',
      lane: 'A',
      latencyClass: 'live',
      cadence: '~3–10 edits/s',
      staleAfterMs: 30_000,
      historyNote:
        'No history: this stream has no backfill endpoint, so it starts empty and fills from the moment you open it.',
      source: {
        name: 'Wikimedia EventStreams',
        url: 'https://stream.wikimedia.org/?doc',
        license: 'CC0 1.0',
        attribution: 'Wikimedia Foundation',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    this.#stats = el('p', { class: 'module__summary' }, 'connecting…');
    this.#tape = el('ol', { class: 'tape tape--wide' });
    el_.append(this.#stats, this.#tape);
    this.#render();
  }

  protected openStream(): void {
    try {
      this.#source = new EventSource(STREAM_URL);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'could not open the stream');
      return;
    }

    this.#source.addEventListener('open', () => this.markOpen());
    this.#source.addEventListener('message', (event) => this.#onMessage(event));
    this.#source.addEventListener('error', () => {
      // EventSource reconnects on its own, so this is reported without our own
      // retry on top — two reconnect loops racing would hammer the source.
      this.fail('the event stream dropped; the browser is retrying', { retry: false });
    });

    this.#flushTimer = setInterval(() => {
      if (!this.#dirty) return;
      this.#dirty = false;
      this.#render();
    }, 400);
  }

  protected closeStream(): void {
    if (this.#flushTimer !== null) clearInterval(this.#flushTimer);
    this.#flushTimer = null;
    this.#source?.close();
    this.#source = null;
  }

  #onMessage(event: MessageEvent): void {
    let change: RecentChange;
    try {
      change = JSON.parse(event.data as string) as RecentChange;
    } catch {
      return;
    }
    if (change.type !== 'edit' && change.type !== 'new') return;

    const timestamp = change.timestamp;
    const time = typeof timestamp === 'number' ? timestamp * 1000 : Number.NaN;
    const oldLength = change.length?.old;
    const newLength = change.length?.new;
    const delta =
      typeof oldLength === 'number' && typeof newLength === 'number' ? newLength - oldLength : null;

    const edit: Edit = {
      wiki: typeof change.wiki === 'string' ? change.wiki : '—',
      title: typeof change.title === 'string' ? change.title : '—',
      user: typeof change.user === 'string' ? change.user : '—',
      bot: change.bot === true,
      delta,
      time: Number.isFinite(time) ? time : 0,
    };

    this.#received += 1;
    if (edit.bot) this.#bots += 1;
    else this.#humans += 1;
    this.#recentArrivals.push(Date.now());
    this.#byWiki.set(edit.wiki, (this.#byWiki.get(edit.wiki) ?? 0) + 1);
    // The wiki's own timestamp. Zero means the payload carried none, and null
    // is passed so the age reads unknown rather than 1970.
    this.markReceived(edit.time > 0 ? edit.time : null);

    // Show one in N. Dropping is honest and stated; averaging edits together
    // would produce a row describing an edit that never happened.
    if (this.#received % this.#sampleEvery() === 0) {
      this.#tapeBuffer.push(edit);
      this.#shown += 1;
      this.#dirty = true;
    }

    if (this.#received % 10 === 0) this.#dirty = true;
  }

  /** Sample harder as the rate rises, so the tape stays readable. */
  #sampleEvery(): number {
    const rate = this.#ratePerMinute();
    if (rate > 600) return 8;
    if (rate > 300) return 4;
    if (rate > 120) return 2;
    return 1;
  }

  #ratePerMinute(): number {
    const arrivals = [...this.#recentArrivals];
    if (arrivals.length < 2) return 0;
    const first = arrivals[0];
    const last = arrivals.at(-1);
    if (first === undefined || last === undefined || last === first) return 0;
    return (arrivals.length / (last - first)) * 60_000;
  }

  #render(): void {
    if (this.#stats !== null) {
      const rate = this.#ratePerMinute();
      const sample = this.#sampleEvery();
      const topWiki = [...this.#byWiki.entries()].sort((a, b) => b[1] - a[1])[0];
      this.#stats.textContent =
        `${this.#received} edits received · ${rate > 0 ? `${Math.round(rate)}/min observed` : 'measuring rate'} · ` +
        `${this.#humans} human / ${this.#bots} bot · ` +
        (sample > 1 ? `tape showing 1 in ${sample}` : 'tape showing every edit') +
        (topWiki ? ` · busiest: ${topWiki[0]} (${topWiki[1]})` : '');
    }

    if (this.#tape !== null) {
      this.#tape.replaceChildren(
        ...[...this.#tapeBuffer].reverse().map((edit) =>
          el(
            'li',
            { class: edit.bot ? 'tape__row tape__row--bot' : 'tape__row' },
            el('span', { class: 'tape__wiki' }, edit.wiki),
            el('span', { class: 'tape__title' }, edit.title),
            el(
              'span',
              {
                class:
                  edit.delta === null
                    ? 'tape__delta'
                    : edit.delta >= 0
                      ? 'tape__delta tape__delta--pos'
                      : 'tape__delta tape__delta--neg',
              },
              edit.delta === null ? '—' : `${edit.delta >= 0 ? '+' : ''}${edit.delta}`,
            ),
            el('span', { class: 'tape__user' }, edit.user),
          ),
        ),
      );
    }
  }
}

register(new WikipediaChanges());
