/**
 * Fixed-capacity ring buffer.
 *
 * Every incoming message stream on this site writes into one of these. The
 * point is the hard bound: a live feed left open for an hour must not grow the
 * heap, so the buffer overwrites its oldest entry instead of appending. There
 * is deliberately no "grow" path.
 *
 * Overwriting is a display bound, not a data transformation. Values that fall
 * out of the window are dropped whole — never averaged, decimated into a
 * summary, or resampled. A dropped message is one we no longer show; it is
 * never folded into one we do.
 */
export class RingBuffer<T> {
  readonly capacity: number;
  #items: Array<T | undefined>;
  #head = 0;
  #size = 0;
  /** Total ever written, including entries since overwritten. */
  #written = 0;

  constructor(capacity: number) {
    if (!Number.isInteger(capacity) || capacity < 1) {
      throw new RangeError(`RingBuffer capacity must be a positive integer, got ${capacity}`);
    }
    this.capacity = capacity;
    this.#items = new Array<T | undefined>(capacity);
  }

  get size(): number {
    return this.#size;
  }

  get written(): number {
    return this.#written;
  }

  /** True once the buffer has begun overwriting, i.e. entries have been lost. */
  get overwriting(): boolean {
    return this.#written > this.capacity;
  }

  push(item: T): void {
    this.#items[this.#head] = item;
    this.#head = (this.#head + 1) % this.capacity;
    if (this.#size < this.capacity) this.#size += 1;
    this.#written += 1;
  }

  /** The most recently written item, or undefined if nothing has been written. */
  get last(): T | undefined {
    if (this.#size === 0) return undefined;
    return this.#items[(this.#head - 1 + this.capacity) % this.capacity];
  }

  /** Oldest to newest. Allocates; call it at paint time, not per message. */
  toArray(): T[] {
    const out: T[] = [];
    const start = (this.#head - this.#size + this.capacity) % this.capacity;
    for (let i = 0; i < this.#size; i += 1) {
      const item = this.#items[(start + i) % this.capacity];
      if (item !== undefined) out.push(item);
    }
    return out;
  }

  /**
   * Iterate oldest to newest without allocating an array. Preferred on the
   * render path for high-rate feeds.
   */
  *[Symbol.iterator](): Iterator<T> {
    const start = (this.#head - this.#size + this.capacity) % this.capacity;
    for (let i = 0; i < this.#size; i += 1) {
      const item = this.#items[(start + i) % this.capacity];
      if (item !== undefined) yield item;
    }
  }

  clear(): void {
    // Drop references so buffered payloads can be collected on disconnect.
    this.#items = new Array<T | undefined>(this.capacity);
    this.#head = 0;
    this.#size = 0;
    // `written` is deliberately NOT reset: it is a record of what arrived.
  }
}
