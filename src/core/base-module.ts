import type { DataModule, Health, Lane, LatencyClass, Section, SourceRef, Transport } from './types.js';
import { Backoff, type BackoffOptions } from './backoff.js';

export interface BaseModuleConfig {
  id: string;
  section: Section;
  title: string;
  oneLiner: string;
  why: string;
  transport: Transport;
  lane: Lane;
  latencyClass: LatencyClass;
  cadence: string;
  source: SourceRef;
  /**
   * How long without a message before this module is `stale`, in ms. The rule
   * is 3x the expected cadence: long enough not to flap, short enough that a
   * dead feed is not presented as a live one.
   *
   * A snapshot module has no cadence to miss and passes `null`.
   */
  staleAfterMs: number | null;
  /** What the backfill covers, or why this feed has none. */
  historyNote?: string | null;
  backoff?: BackoffOptions;
}

/**
 * Shared machinery for every module: counters, health, the staleness watchdog
 * and reconnect scheduling.
 *
 * Subclasses implement only how their transport opens and closes. Everything
 * that must behave identically across the catalog — above all, how a feed going
 * quiet is reported — lives here so it cannot drift between modules.
 *
 * The honesty rules this class enforces:
 *   - `messageCount` counts messages RECEIVED, never messages rendered.
 *   - `lastSourceTimestamp` is whatever the source said. A module with no
 *     source timestamp passes null and the age reads unknown; it never falls
 *     back to our own clock, which would silently turn latency into freshness.
 *   - Going quiet is a state change (`stale`), never a held value. The module's
 *     own rendering must reflect that, and the status strip does so for free.
 */
export abstract class BaseModule implements DataModule {
  readonly id: string;
  readonly section: Section;
  readonly title: string;
  readonly oneLiner: string;
  readonly why: string;
  readonly transport: Transport;
  readonly lane: Lane;
  readonly latencyClass: LatencyClass;
  readonly cadence: string;
  readonly source: SourceRef;
  readonly staleAfterMs: number | null;
  readonly historyNote: string | null;

  health: Health = 'connecting';

  #messageCount = 0;
  #backfillCount = 0;
  #lastSourceTimestamp: number | null = null;
  /** Local clock reading of the last arrival — for the watchdog only, never displayed as data. */
  #lastArrivalAt: number | null = null;
  #errorReason: string | null = null;

  #connected = false;
  #staleTimer: ReturnType<typeof setTimeout> | null = null;
  #retryTimer: ReturnType<typeof setTimeout> | null = null;
  readonly #backoff: Backoff;

  protected element: HTMLElement | null = null;

  constructor(config: BaseModuleConfig) {
    this.id = config.id;
    this.section = config.section;
    this.title = config.title;
    this.oneLiner = config.oneLiner;
    this.why = config.why;
    this.transport = config.transport;
    this.lane = config.lane;
    this.latencyClass = config.latencyClass;
    this.cadence = config.cadence;
    this.source = config.source;
    this.staleAfterMs = config.staleAfterMs;
    this.historyNote = config.historyNote ?? null;
    this.#backoff = new Backoff(config.backoff ?? {});
  }

  get messageCount(): number {
    return this.#messageCount;
  }

  get backfillCount(): number {
    return this.#backfillCount;
  }

  get lastSourceTimestamp(): number | null {
    return this.#lastSourceTimestamp;
  }

  get errorReason(): string | null {
    return this.#errorReason;
  }

  get connected(): boolean {
    return this.#connected;
  }

  // --- subclass hooks ----------------------------------------------------

  /** Render the module's own chrome into `el`. Called once. */
  abstract mount(el: HTMLElement): void;

  /** Open the transport. Call `markReceived` per message and `fail` on error. */
  protected abstract openStream(): void;

  /** Close sockets, abort requests, clear timers owned by the subclass. */
  protected abstract closeStream(): void;

  // --- lifecycle ---------------------------------------------------------

  connect(): void {
    if (this.#connected) return;
    this.#connected = true;
    this.#errorReason = null;
    this.health = 'connecting';
    this.openStream();
  }

  disconnect(): void {
    if (!this.#connected && this.#staleTimer === null && this.#retryTimer === null) return;
    this.#connected = false;
    this.#clearTimer('stale');
    this.#clearTimer('retry');
    this.closeStream();
    // Health returns to `connecting` rather than staying `ok`: a disconnected
    // module is not receiving anything, and leaving it green would be a lie
    // told by omission.
    this.health = 'connecting';
  }

  // --- reporting, for subclasses -----------------------------------------

  /**
   * Record one message actually received from the source.
   *
   * @param sourceTimestamp The source's own timestamp in ms, or null when the
   *   payload carries none. Never pass `Date.now()` as a stand-in.
   */
  protected markReceived(sourceTimestamp: number | null): void {
    this.#messageCount += 1;
    this.#lastSourceTimestamp = sourceTimestamp;
    this.#lastArrivalAt = Date.now();
    this.#errorReason = null;
    this.health = 'ok';
    this.#backoff.reset();
    this.#armStaleTimer();
  }

  /**
   * Record historical points loaded from the source's own history endpoint.
   *
   * Kept out of `messageCount`, and out of the site's global counter, because
   * these are real data but not events that happened while you were watching.
   * They also must not set health to `ok`: a successful backfill says the
   * history endpoint answered, not that the live stream is delivering.
   */
  protected markBackfilled(count: number): void {
    this.#backfillCount += count;
  }

  /** Connection established, but no data has arrived yet. */
  protected markOpen(): void {
    if (this.health === 'connecting') this.#armStaleTimer();
    this.#backoff.reset();
  }

  /**
   * Report a failure with its reason. The reason is shown to the user: a source
   * that is down or gated says so, rather than rendering as empty.
   */
  protected fail(reason: string, { retry = true }: { retry?: boolean } = {}): void {
    this.#errorReason = reason;
    this.health = 'error';
    this.#clearTimer('stale');
    if (retry && this.#connected) this.#scheduleRetry();
  }

  // --- internals ---------------------------------------------------------

  #armStaleTimer(): void {
    this.#clearTimer('stale');
    if (this.staleAfterMs === null) return;
    this.#staleTimer = setTimeout(() => {
      // Nothing arrived within the expected window. Say so. The last value is
      // still on screen, but it is now labelled as old rather than current.
      if (this.health === 'ok' || this.health === 'connecting') this.health = 'stale';
    }, this.staleAfterMs);
  }

  #scheduleRetry(): void {
    this.#clearTimer('retry');
    const delay = this.#backoff.next();
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (!this.#connected) return;
      this.closeStream();
      this.health = 'connecting';
      this.openStream();
    }, delay);
  }

  #clearTimer(which: 'stale' | 'retry'): void {
    const timer = which === 'stale' ? this.#staleTimer : this.#retryTimer;
    if (timer !== null) clearTimeout(timer);
    if (which === 'stale') this.#staleTimer = null;
    else this.#retryTimer = null;
  }

  /** Milliseconds since the last message arrived, by our clock. Watchdog use only. */
  protected get msSinceArrival(): number | null {
    return this.#lastArrivalAt === null ? null : Date.now() - this.#lastArrivalAt;
  }
}
