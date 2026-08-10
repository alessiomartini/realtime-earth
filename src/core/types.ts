/**
 * The module contract. Everything on this site is a module implementing it.
 *
 * Three fields go beyond the original sketch of this interface — `messageCount`,
 * `lastSourceTimestamp` and `errorReason`. They are not additions in spirit:
 * the status strip is specified to show a message counter and the age of the
 * last datum, and an unavailable source is specified to show an honest error
 * with its reason. Those requirements cannot be met unless the contract exposes
 * them, so they are part of it.
 *
 * `lastSourceTimestamp` in particular carries the fifth founding principle: it
 * is the timestamp the SOURCE reported, never the moment we fetched. A module
 * with no source timestamp available must leave it null rather than substitute
 * its own clock — the age display then reads as unknown, which is the truth.
 */

export type LatencyClass = 'live' | 'near-real-time' | 'delayed' | 'snapshot';

export type Transport = 'websocket' | 'sse' | 'poll' | 'relay' | 'proxy-poll';

export type Lane = 'A' | 'B' | 'C';

export type Health = 'connecting' | 'ok' | 'stale' | 'error';

export type Section = 'markets' | 'infrastructure' | 'earth' | 'noosphere';

export interface SourceRef {
  /** Who publishes this data. */
  name: string;
  /** Where it comes from, linkable. */
  url: string;
  /** The licence it is published under. */
  license: string;
  /** The attribution string the licence requires us to display. */
  attribution: string;
}

export interface DataModule {
  id: string;
  section: Section;
  title: string;
  /** What this shows, in plain English. */
  oneLiner: string;
  /** Why this feed is remarkable (1–2 sentences). */
  why: string;
  transport: Transport;
  lane: Lane;
  latencyClass: LatencyClass;
  /** Human-readable expected rate: "~30 msg/s", "every 60s", "every 15 min". */
  cadence: string;
  source: SourceRef;

  mount(el: HTMLElement): void;
  connect(): void;
  /** MUST fully tear down: sockets closed, timers cleared, listeners removed. */
  disconnect(): void;

  health: Health;

  /** Messages actually received from the source since page load. */
  readonly messageCount: number;
  /** The source's own timestamp for the latest datum, in ms. Null if none. */
  readonly lastSourceTimestamp: number | null;
  /** Why this module is in the `error` state. Null when it is not. */
  readonly errorReason: string | null;
}

export const SECTION_LABELS: Record<Section, string> = {
  markets: 'Finance & Global Markets',
  infrastructure: 'Logistics & Physical Infrastructure',
  earth: 'Earth System & Energy',
  noosphere: 'Collective Information Flows',
};

export const SECTION_ORDER: readonly Section[] = ['markets', 'infrastructure', 'earth', 'noosphere'];

export const LATENCY_LABELS: Record<LatencyClass, string> = {
  live: 'LIVE',
  'near-real-time': 'NEAR-REAL-TIME',
  delayed: 'DELAYED',
  snapshot: 'SNAPSHOT',
};

export const TRANSPORT_GLYPHS: Record<Transport, string> = {
  websocket: '⇅',
  sse: '↓',
  poll: '⟳',
  relay: '⇄',
  'proxy-poll': '⟳',
};
