import { BaseModule, type BaseModuleConfig } from './base-module.js';

/**
 * The client half of Lane B.
 *
 * A Lane A module reads its source directly, so "when did this arrive" and
 * "how old is it" are the same question. A proxied module has two clocks: the
 * source's, and the Worker's fetch of it. This class exists so that difference
 * is handled once, identically, for every proxied feed — because the way to get
 * it wrong is not to lie deliberately, it is to forget there were two clocks.
 *
 * Three rules it enforces:
 *
 * 1. **A re-served cache entry is not an arrival.** The Worker answers every
 *    poll, and between refreshes it answers with the same bytes. Counting those
 *    as messages received would inflate the one number this whole site rests
 *    on — so a payload whose fetch time has not changed is recognised as the
 *    same payload and counted as nothing.
 *
 * 2. **The age shown is the cache's age, labelled as such.** `cacheAgeSeconds`
 *    is how long ago the WORKER fetched from upstream. It is displayed next to,
 *    never instead of, the source's own timestamp.
 *
 * 3. **A refresh failure is shown even when there is data.** The Worker keeps
 *    serving the last good payload with its real fetch time when upstream
 *    fails. That is honest only if the failure travels with it, so a reported
 *    `refreshError` puts the module into the error state with the source's own
 *    reason, while whatever was last received stays on screen — ageing, and
 *    labelled as ageing.
 */

/** The envelope every `/api/<module-id>` route returns. See worker/proxy.ts. */
export interface ProxyEnvelope<T> {
  ok: boolean;
  module: string;
  lane: 'B';
  attribution?: string;
  upstream?: string;
  /** ISO. When the WORKER fetched this from upstream. Not when we received it. */
  fetchedAt?: string;
  fetchAgeSeconds?: number | null;
  cached?: boolean;
  refreshEverySeconds?: number;
  /** The source's own newest timestamp, in ms. Null when it publishes none. */
  sourceTimestamp?: number | null;
  count?: number;
  refreshError?: { at: string; reason: string } | null;
  data?: T;
  error?: string;
  message?: string;
}

export interface ProxyModuleConfig extends BaseModuleConfig {
  /**
   * How often to ask the Worker. This is not how often the source is read —
   * the Worker's cron decides that — it is only how quickly a refresh that has
   * already happened reaches the page.
   */
  pollMs: number;
}

export abstract class ProxyModule<T> extends BaseModule {
  readonly #pollMs: number;
  #timer: ReturnType<typeof setInterval> | null = null;
  #abort: AbortController | null = null;

  /** The Worker's fetch time for the payload last accepted, for dedupe. */
  #lastFetchedAt: string | null = null;

  /** How long ago the Worker fetched the payload now on screen. */
  protected cacheAgeSeconds: number | null = null;
  /** Whether the payload on screen came out of the Worker's cache. */
  protected servedFromCache = false;
  /** The Worker's stated refresh interval, for the cadence readout. */
  protected refreshEverySeconds: number | null = null;
  /** Set when the Worker's last refresh attempt failed. */
  protected refreshError: string | null = null;

  constructor(config: ProxyModuleConfig) {
    super(config);
    this.#pollMs = config.pollMs;
  }

  /** Called once per genuinely new payload. Not called for a re-served cache entry. */
  protected abstract onPayload(data: T, envelope: ProxyEnvelope<T>): void;

  /**
   * Called after every poll, new payload or not, so the view can keep the
   * cache age ticking upward. A snapshot that silently stops ageing reads as
   * fresh, which is the failure this lane is most prone to.
   */
  protected abstract onPolled(): void;

  protected openStream(): void {
    this.#abort = new AbortController();
    void this.#poll();
    this.#timer = setInterval(() => void this.#poll(), this.#pollMs);
  }

  protected closeStream(): void {
    if (this.#timer !== null) clearInterval(this.#timer);
    this.#timer = null;
    this.#abort?.abort();
    this.#abort = null;
  }

  async #poll(): Promise<void> {
    try {
      const response = await fetch(`/api/${this.id}`, { signal: this.#abort?.signal ?? null });
      const envelope = (await response.json()) as ProxyEnvelope<T>;

      if (!envelope.ok) {
        // The Worker's own explanation, verbatim. It knows why — whether the
        // source refused, timed out, or needs a key we do not have — and
        // replacing that with a generic "unavailable" would throw away the only
        // part a reader can act on.
        //
        // No retry scheduled: this module already polls on its own timer, and a
        // second retry loop on top would just ask more often the worse things
        // got.
        this.fail(envelope.message ?? `the proxy returned HTTP ${response.status}`, { retry: false });
        this.onPolled();
        return;
      }

      this.cacheAgeSeconds = envelope.fetchAgeSeconds ?? null;
      this.servedFromCache = envelope.cached ?? true;
      this.refreshEverySeconds = envelope.refreshEverySeconds ?? null;
      this.refreshError = envelope.refreshError?.reason ?? null;

      const fetchedAt = envelope.fetchedAt ?? null;
      const isNewPayload = fetchedAt !== null && fetchedAt !== this.#lastFetchedAt;

      if (isNewPayload && envelope.data !== undefined) {
        this.#lastFetchedAt = fetchedAt;
        this.onPayload(envelope.data, envelope);
        // The SOURCE's timestamp, never the Worker's fetch time. A proxied feed
        // whose source publishes no timestamp has an unknown age, and unknown
        // is what gets displayed.
        this.markReceived(envelope.sourceTimestamp ?? null);
      } else {
        // Same bytes as last time: the Worker answered, nothing new has been
        // fetched upstream yet. A successful poll, not a message.
        this.markOpen();
      }

      // Reported after the payload, so the error state is what survives: the
      // data on screen is real and stays, but it is no longer being refreshed
      // and the page has to say why.
      if (this.refreshError !== null) {
        this.fail(this.refreshError, { retry: false });
      }

      this.onPolled();
    } catch (error) {
      if ((error as Error).name === 'AbortError') return;
      this.fail(error instanceof Error ? error.message : 'the request failed', { retry: false });
      this.onPolled();
    }
  }

  /**
   * How the cache age should be described on the page. Never "live": a value
   * this Worker fetched four minutes ago is four minutes old, however fast it
   * reached the browser.
   */
  protected cacheLabel(): string {
    if (this.cacheAgeSeconds === null) return 'age of this fetch unknown';
    const age = this.cacheAgeSeconds;
    const when = age < 60 ? `${age}s` : age < 3600 ? `${Math.round(age / 60)}m` : `${Math.round(age / 3600)}h`;
    const cadence =
      this.refreshEverySeconds === null
        ? ''
        : `, refreshed every ${
            this.refreshEverySeconds < 3600
              ? `${Math.round(this.refreshEverySeconds / 60)} min`
              : `${Math.round(this.refreshEverySeconds / 3600)}h`
          }`;
    return this.servedFromCache
      ? `fetched by our Worker ${when} ago${cadence}`
      : `fetched by our Worker just now${cadence}`;
  }
}
