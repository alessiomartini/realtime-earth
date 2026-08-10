/**
 * Exponential backoff with full jitter.
 *
 * Used by every reconnecting transport. Jitter matters more than it looks: a
 * dozen modules that all lost their connection to the same upstream would
 * otherwise retry in lockstep and hammer the source at the exact moment it is
 * least able to answer.
 */

export interface BackoffOptions {
  /** Delay for the first retry, before any growth. */
  baseMs?: number;
  /** Ceiling the delay never exceeds. */
  maxMs?: number;
  /** Growth factor per consecutive failure. */
  factor?: number;
}

export class Backoff {
  readonly #baseMs: number;
  readonly #maxMs: number;
  readonly #factor: number;
  #attempt = 0;

  constructor({ baseMs = 1_000, maxMs = 60_000, factor = 2 }: BackoffOptions = {}) {
    this.#baseMs = baseMs;
    this.#maxMs = maxMs;
    this.#factor = factor;
  }

  get attempt(): number {
    return this.#attempt;
  }

  /**
   * Delay for the next retry, in ms. "Full jitter": a uniform random point in
   * [0, cap], which spreads a thundering herd far better than a fixed delay
   * with a small random nudge.
   */
  next(): number {
    const cap = Math.min(this.#maxMs, this.#baseMs * this.#factor ** this.#attempt);
    this.#attempt += 1;
    return Math.random() * cap;
  }

  /** Call on a successful connection so the next failure starts over. */
  reset(): void {
    this.#attempt = 0;
  }
}
