import { BaseModule } from '../core/base-module.js';
import { RingBuffer } from '../core/ring-buffer.js';
import { register } from './registry.js';
import { TimeChart } from '../ui/chart.js';
import { el } from '../ui/dom.js';

/**
 * Bitcoin order flow — genuinely tick-by-tick, one point per executed trade.
 *
 * Host choice is evidence-driven: `stream.binance.com` answered HTTP 451,
 * "Service unavailable from a restricted location", from the verification
 * runner. `data-stream.binance.vision` (stream) and `data-api.binance.vision`
 * (history) are the market-data hosts and both were verified working, so those
 * are what the module uses. A visitor whose own country is restricted will
 * still see a connection error — which the card states rather than hides.
 *
 * The chart opens with the last three hours of 1-minute closes from Binance's
 * own klines endpoint, then every subsequent point is one real trade arriving
 * over the WebSocket. The line is stepped: a diagonal between two trades would
 * assert prices that were never traded.
 */

const WS_URL = 'wss://data-stream.binance.vision/stream?streams=btcusdt@aggTrade';
const KLINES_URL =
  'https://data-api.binance.vision/api/v3/klines?symbol=BTCUSDT&interval=1m&limit=180';

interface Tick {
  /** Binance's own trade time, in ms. */
  time: number;
  price: number;
  quantity: number;
  buyerIsMaker: boolean;
  live: boolean;
}

interface AggTrade {
  data?: { T?: unknown; p?: unknown; q?: unknown; m?: unknown };
}

class BinanceBtc extends BaseModule {
  #ticks = new RingBuffer<Tick>(4000);
  #socket: WebSocket | null = null;
  #chart: TimeChart | null = null;
  #tape: HTMLElement | null = null;
  #stats: HTMLElement | null = null;
  #flushTimer: ReturnType<typeof setInterval> | null = null;
  #dirty = false;
  #backfilled = false;

  constructor() {
    super({
      id: 'binance-btc',
      section: 'markets',
      title: 'Bitcoin trades, one by one',
      oneLiner: 'Every executed BTC/USDT trade on Binance, as it happens.',
      why: 'This is what real tick-by-tick looks like, and it is public: not a sampled price every second, but one point per trade, tens per second at busy moments. Equities have nothing like this for free — who owns real-time market data is part of the story this site tells.',
      transport: 'websocket',
      lane: 'A',
      latencyClass: 'live',
      cadence: '~10–50 trades/s',
      staleAfterMs: 30_000,
      historyNote:
        'Opens with the last 180 one-minute closes from Binance’s klines endpoint, then every point after that is a single trade.',
      source: {
        name: 'Binance market data',
        url: 'https://developers.binance.com/docs/binance-spot-api-docs/web-socket-streams',
        license: 'Public market data, free for non-commercial use per Binance terms',
        attribution: 'Binance',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    const chartBox = el('div', { class: 'chartbox' });
    this.#stats = el('p', { class: 'module__summary' }, 'connecting…');
    this.#tape = el('ol', { class: 'tape' });
    el_.append(chartBox, this.#stats, this.#tape);
    this.#chart = new TimeChart(chartBox, [{ label: 'BTC/USDT', stroke: '#54d6a0', precision: 2 }]);
    this.#render();
  }

  protected openStream(): void {
    if (!this.#backfilled) void this.#backfill();

    try {
      this.#socket = new WebSocket(WS_URL);
    } catch (error) {
      this.fail(error instanceof Error ? error.message : 'could not open the socket');
      return;
    }

    this.#socket.addEventListener('open', () => this.markOpen());
    this.#socket.addEventListener('message', (event) => this.#onMessage(event));
    this.#socket.addEventListener('error', () =>
      this.fail('the WebSocket connection failed — this venue may be unavailable from your location'),
    );
    this.#socket.addEventListener('close', (event) => {
      if (event.wasClean) return;
      this.fail(`the stream closed unexpectedly (code ${event.code})`);
    });

    // Ingest is decoupled from paint: trades land in the ring buffer as they
    // arrive, and the chart repaints four times a second. This batches PAINTS,
    // never values — no trade is averaged into another.
    this.#flushTimer = setInterval(() => {
      if (!this.#dirty) return;
      this.#dirty = false;
      this.#render();
    }, 250);
  }

  protected closeStream(): void {
    if (this.#flushTimer !== null) clearInterval(this.#flushTimer);
    this.#flushTimer = null;
    const socket = this.#socket;
    this.#socket = null;
    if (socket !== null && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      socket.close();
    }
  }

  unmount(): void {
    this.#chart?.destroy();
    this.#chart = null;
  }

  async #backfill(): Promise<void> {
    try {
      const response = await fetch(KLINES_URL);
      if (!response.ok) {
        // History failing is not fatal: the live stream can still run, and the
        // chart simply starts from now. The summary line says which happened.
        return;
      }
      const rows = (await response.json()) as unknown[];
      if (!Array.isArray(rows)) return;
      let added = 0;
      for (const row of rows) {
        if (!Array.isArray(row)) continue;
        const closeTime = Number(row[6]);
        const close = Number(row[4]);
        const volume = Number(row[5]);
        if (!Number.isFinite(closeTime) || !Number.isFinite(close)) continue;
        this.#ticks.push({
          time: closeTime,
          price: close,
          quantity: Number.isFinite(volume) ? volume : 0,
          buyerIsMaker: false,
          live: false,
        });
        added += 1;
      }
      this.markBackfilled(added);
      this.#backfilled = true;
      this.#render();
    } catch {
      // Silent here by design: the failure is visible as an empty history and
      // reported in the summary line, and it must not mark the live feed as
      // broken when the socket may be perfectly healthy.
    }
  }

  #onMessage(event: MessageEvent): void {
    let payload: AggTrade;
    try {
      payload = JSON.parse(event.data as string) as AggTrade;
    } catch {
      return;
    }
    const data = payload.data;
    const time = Number(data?.T);
    const price = Number(data?.p);
    const quantity = Number(data?.q);
    if (!Number.isFinite(time) || !Number.isFinite(price)) return;

    this.#ticks.push({
      time,
      price,
      quantity: Number.isFinite(quantity) ? quantity : 0,
      buyerIsMaker: data?.m === true,
      live: true,
    });
    // Binance's own trade timestamp, never our arrival time.
    this.markReceived(time);
    this.#dirty = true;
  }

  #render(): void {
    const ticks = [...this.#ticks];
    if (this.#chart !== null && ticks.length > 0) {
      const times = new Float64Array(ticks.length);
      const prices = new Float64Array(ticks.length);
      ticks.forEach((tick, index) => {
        times[index] = tick.time / 1000;
        prices[index] = tick.price;
      });
      this.#chart.setData([times, prices]);
    }

    const live = ticks.filter((t) => t.live);
    if (this.#stats !== null) {
      const last = ticks.at(-1);
      const history = this.backfillCount > 0 ? `${this.backfillCount} one-minute closes loaded` : 'history unavailable';
      this.#stats.textContent = last
        ? `${last.price.toFixed(2)} USDT · ${history} · ${live.length} live trades received`
        : `${history} · waiting for the first trade`;
    }

    if (this.#tape !== null) {
      // The tape shows the most recent trades only. When the buffer overwrites,
      // older trades are dropped whole — never merged into a summary bar.
      this.#tape.replaceChildren(
        ...live
          .slice(-14)
          .reverse()
          .map((tick) =>
            el(
              'li',
              { class: tick.buyerIsMaker ? 'tape__row tape__row--sell' : 'tape__row tape__row--buy' },
              el('span', { class: 'tape__price' }, tick.price.toFixed(2)),
              el('span', { class: 'tape__qty' }, tick.quantity.toFixed(5)),
              el('span', { class: 'tape__time' }, new Date(tick.time).toISOString().slice(11, 23)),
            ),
          ),
      );
    }
  }
}

register(new BinanceBtc());
