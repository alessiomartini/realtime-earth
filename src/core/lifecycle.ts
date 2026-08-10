import type { DataModule, Transport } from './types.js';

/**
 * Lifecycle manager: decides which modules are allowed to be connected.
 *
 * Opening a dozen live streams at once freezes the tab, so connection is a
 * managed resource rather than something each module decides for itself. A
 * module is connected only when all of these hold:
 *
 *   1. its card is on screen (IntersectionObserver);
 *   2. the document is visible;
 *   3. the global pause is off;
 *   4. for socket transports, it fits under the concurrency cap.
 *
 * When any of them stops holding, the module is disconnected — really
 * disconnected, sockets closed and timers cleared, not merely ignored. A
 * paused feed that keeps its socket open would still be consuming the source's
 * bandwidth and our memory while showing the user nothing.
 */

/** Transports that hold an open connection and therefore consume the budget. */
const SOCKET_TRANSPORTS: ReadonlySet<Transport> = new Set<Transport>(['websocket', 'relay', 'sse']);

export interface LifecycleOptions {
  /** Maximum simultaneously open socket-like connections. */
  maxConcurrentSockets?: number;
  /**
   * How much of a card must be visible before it connects. A low threshold
   * means a card connects as it scrolls into view rather than after it lands.
   */
  visibilityThreshold?: number;
  /**
   * How far outside the viewport a card still counts as visible.
   *
   * Without this the home grid's feeds only wake once the tiles are physically
   * on screen, so the counter above them reads 0 for as long as the reader is
   * still on the thesis. A margin connects them just before they arrive, which
   * is what makes the headline number mean anything on landing.
   */
  rootMargin?: string;
}

interface Entry {
  module: DataModule;
  element: HTMLElement;
  visible: boolean;
  /** Order in which visibility was gained — used to resolve the socket budget. */
  visibleSince: number;
  connected: boolean;
}

export class LifecycleManager {
  readonly #entries = new Map<string, Entry>();
  readonly #maxSockets: number;
  readonly #observer: IntersectionObserver | null;
  readonly #listeners = new Set<() => void>();

  #paused = false;
  #documentHidden = false;
  #visibilityCounter = 0;
  #onVisibilityChange: (() => void) | null = null;

  constructor({
    maxConcurrentSockets = 4,
    visibilityThreshold = 0.01,
    rootMargin = '400px 0px',
  }: LifecycleOptions = {}) {
    this.#maxSockets = maxConcurrentSockets;

    this.#observer =
      typeof IntersectionObserver === 'undefined'
        ? null
        : new IntersectionObserver(
            (records) => {
              for (const record of records) {
                const id = (record.target as HTMLElement).dataset['moduleId'];
                if (id === undefined) continue;
                const entry = this.#entries.get(id);
                if (entry === undefined) continue;
                if (entry.visible !== record.isIntersecting) {
                  entry.visible = record.isIntersecting;
                  if (record.isIntersecting) {
                    this.#visibilityCounter += 1;
                    entry.visibleSince = this.#visibilityCounter;
                  }
                }
              }
              this.#reconcile();
            },
            { threshold: visibilityThreshold, rootMargin },
          );

    if (typeof document !== 'undefined') {
      this.#documentHidden = document.visibilityState === 'hidden';
      this.#onVisibilityChange = () => {
        this.#documentHidden = document.visibilityState === 'hidden';
        this.#reconcile();
      };
      document.addEventListener('visibilitychange', this.#onVisibilityChange);
    }
  }

  get paused(): boolean {
    return this.#paused;
  }

  get documentHidden(): boolean {
    return this.#documentHidden;
  }

  get maxConcurrentSockets(): number {
    return this.#maxSockets;
  }

  /** Modules currently holding an open connection. */
  get connectedCount(): number {
    let count = 0;
    for (const entry of this.#entries.values()) if (entry.connected) count += 1;
    return count;
  }

  /**
   * True when this module wants to be connected but the socket budget is full.
   * The card says so, because "waiting for a connection slot" and "this feed is
   * broken" must not look the same.
   */
  isQueued(id: string): boolean {
    const entry = this.#entries.get(id);
    if (entry === undefined) return false;
    return !entry.connected && entry.visible && !this.#paused && !this.#documentHidden;
  }

  register(module: DataModule, element: HTMLElement): void {
    element.dataset['moduleId'] = module.id;
    this.#entries.set(module.id, {
      module,
      element,
      visible: false,
      visibleSince: 0,
      connected: false,
    });
    this.#observer?.observe(element);
  }

  setPaused(paused: boolean): void {
    if (this.#paused === paused) return;
    this.#paused = paused;
    this.#reconcile();
    this.#emit();
  }

  togglePaused(): void {
    this.setPaused(!this.#paused);
  }

  /** Subscribe to manager-level state changes (pause, connection set). */
  onChange(listener: () => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Disconnect everything and release observers. */
  destroy(): void {
    for (const entry of this.#entries.values()) {
      if (entry.connected) {
        entry.module.disconnect();
        entry.connected = false;
      }
    }
    this.#observer?.disconnect();
    if (this.#onVisibilityChange !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', this.#onVisibilityChange);
    }
    this.#entries.clear();
    this.#listeners.clear();
  }

  #reconcile(): void {
    const globallyAllowed = !this.#paused && !this.#documentHidden;

    // Split by whether the module consumes the socket budget. Poll-based
    // modules are cheap and are limited only by visibility.
    const wanted: Entry[] = [];
    for (const entry of this.#entries.values()) {
      const wants = globallyAllowed && entry.visible;
      if (!wants) {
        if (entry.connected) {
          entry.module.disconnect();
          entry.connected = false;
        }
        continue;
      }
      wanted.push(entry);
    }

    // Award socket slots to the modules that became visible first, so scrolling
    // does not repeatedly evict a module the user is actually looking at.
    let socketsUsed = 0;
    const ordered = wanted.sort((a, b) => a.visibleSince - b.visibleSince);

    for (const entry of ordered) {
      const needsSocket = SOCKET_TRANSPORTS.has(entry.module.transport);
      if (needsSocket) {
        if (socketsUsed >= this.#maxSockets) {
          if (entry.connected) {
            entry.module.disconnect();
            entry.connected = false;
          }
          continue;
        }
        socketsUsed += 1;
      }
      if (!entry.connected) {
        entry.module.connect();
        entry.connected = true;
      }
    }

    this.#emit();
  }

  #emit(): void {
    for (const listener of this.#listeners) listener();
  }
}
