import type { DataModule, Lane, LatencyClass, Section, Transport } from '../core/types.js';
import { LATENCY_LABELS, SECTION_LABELS, SECTION_ORDER } from '../core/types.js';
import type { LifecycleManager } from '../core/lifecycle.js';
import { createCard, type CardHandle } from './card.js';
import { el, formatCount } from './dom.js';

/**
 * The catalog: four sections of cards, with filters and sort, a global pause
 * control, and the counter of events received across all modules since page
 * load.
 *
 * The counter is the site's argument, so it counts only what actually arrived:
 * it is the sum of every module's received-message count. Nothing estimated,
 * nothing extrapolated between ticks, and it does not move while the feeds are
 * paused — because when they are paused, nothing is arriving.
 */

type SortKey = 'section' | 'latency' | 'rate';

interface Filters {
  section: Section | 'all';
  transport: Transport | 'all';
  lane: Lane | 'all';
  latency: LatencyClass | 'all';
}

const LATENCY_RANK: Record<LatencyClass, number> = {
  live: 0,
  'near-real-time': 1,
  delayed: 2,
  snapshot: 3,
};

export interface CatalogHandle {
  root: HTMLElement;
  destroy(): void;
}

export function createCatalog(modules: DataModule[], lifecycle: LifecycleManager): CatalogHandle {
  const filters: Filters = { section: 'all', transport: 'all', lane: 'all', latency: 'all' };
  let sortKey: SortKey = 'section';

  const cards = new Map<string, CardHandle>();
  const counterValue = el('span', { class: 'counter__value' }, '0');
  const counterNote = el('span', { class: 'counter__note' }, 'across 0 connected feeds');

  const grid = el('div', { class: 'grid' });
  const emptyState = el('p', { class: 'empty' });

  const pauseButton = el('button', { class: 'control control--pause', type: 'button' }, 'Pause all');
  pauseButton.addEventListener('click', () => lifecycle.togglePaused());

  const root = el(
    'section',
    { class: 'catalog' },
    el(
      'div',
      { class: 'counter' },
      el('span', { class: 'counter__label' }, 'Events received since you opened this page'),
      counterValue,
      counterNote,
    ),
    el(
      'div',
      { class: 'controls' },
      selectControl('Section', 'all', [['all', 'All sections'], ...SECTION_ORDER.map((s) => [s, SECTION_LABELS[s]] as [string, string])], (v) => {
        filters.section = v as Section | 'all';
        applyFilters();
      }),
      selectControl(
        'Transport',
        'all',
        [
          ['all', 'All transports'],
          ['websocket', 'WebSocket'],
          ['sse', 'Server-Sent Events'],
          ['poll', 'Poll'],
          ['relay', 'Relay'],
          ['proxy-poll', 'Proxy poll'],
        ],
        (v) => {
          filters.transport = v as Transport | 'all';
          applyFilters();
        },
      ),
      selectControl(
        'Lane',
        'all',
        [
          ['all', 'All lanes'],
          ['A', 'A — direct'],
          ['B', 'B — worker proxy'],
          ['C', 'C — relay'],
        ],
        (v) => {
          filters.lane = v as Lane | 'all';
          applyFilters();
        },
      ),
      selectControl(
        'Latency',
        'all',
        [['all', 'All latencies'], ...(Object.keys(LATENCY_LABELS) as LatencyClass[]).map((l) => [l, LATENCY_LABELS[l]] as [string, string])],
        (v) => {
          filters.latency = v as LatencyClass | 'all';
          applyFilters();
        },
      ),
      selectControl(
        'Sort',
        'section',
        [
          ['section', 'By section'],
          ['latency', 'By latency'],
          ['rate', 'By messages received'],
        ],
        (v) => {
          sortKey = v as SortKey;
          applyFilters();
        },
      ),
      pauseButton,
    ),
    grid,
    emptyState,
  );

  for (const module of modules) {
    const card = createCard(module);
    cards.set(module.id, card);
    grid.append(card.root);
    lifecycle.register(module, card.root);
  }

  function applyFilters(): void {
    const visible = modules.filter(
      (m) =>
        (filters.section === 'all' || m.section === filters.section) &&
        (filters.transport === 'all' || m.transport === filters.transport) &&
        (filters.lane === 'all' || m.lane === filters.lane) &&
        (filters.latency === 'all' || m.latencyClass === filters.latency),
    );

    const sorted = [...visible].sort((a, b) => {
      if (sortKey === 'latency') return LATENCY_RANK[a.latencyClass] - LATENCY_RANK[b.latencyClass];
      if (sortKey === 'rate') return b.messageCount - a.messageCount;
      return SECTION_ORDER.indexOf(a.section) - SECTION_ORDER.indexOf(b.section);
    });

    const visibleIds = new Set(sorted.map((m) => m.id));
    for (const [id, card] of cards) card.root.toggleAttribute('hidden', !visibleIds.has(id));
    for (const module of sorted) {
      const card = cards.get(module.id);
      if (card) grid.append(card.root);
    }

    if (modules.length === 0) {
      emptyState.textContent =
        'No modules are registered yet. Feeds appear here only once they are wired to an endpoint verified to work — until then this site shows nothing rather than something invented.';
      emptyState.removeAttribute('hidden');
    } else if (sorted.length === 0) {
      emptyState.textContent = 'No modules match these filters.';
      emptyState.removeAttribute('hidden');
    } else {
      emptyState.setAttribute('hidden', '');
    }
  }

  // One tick a second drives every status strip. It is required regardless of
  // data arrival: the age of the last datum keeps growing while a feed is
  // silent, and that growing number is exactly how a stalled feed reveals
  // itself. It is a clock, not an animation — it interpolates nothing.
  let tick: ReturnType<typeof setInterval> | null = null;

  function refresh(): void {
    const now = Date.now();
    let total = 0;
    for (const module of modules) {
      total += module.messageCount;
      const card = cards.get(module.id);
      card?.update(now, lifecycle.isQueued(module.id));
    }
    counterValue.textContent = formatCount(total);

    const connected = lifecycle.connectedCount;
    counterNote.textContent = lifecycle.paused
      ? 'paused — nothing is arriving'
      : `across ${connected} connected feed${connected === 1 ? '' : 's'}`;

    pauseButton.textContent = lifecycle.paused ? 'Resume all' : 'Pause all';
    pauseButton.classList.toggle('control--active', lifecycle.paused);
  }

  function start(): void {
    if (tick === null) tick = setInterval(refresh, 1000);
    refresh();
  }

  function stop(): void {
    if (tick !== null) clearInterval(tick);
    tick = null;
  }

  // No point repainting a hidden tab, and the streams are paused anyway.
  const onVisibility = (): void => {
    if (document.visibilityState === 'hidden') stop();
    else start();
  };
  document.addEventListener('visibilitychange', onVisibility);

  const unsubscribe = lifecycle.onChange(refresh);

  applyFilters();
  start();

  return {
    root,
    destroy(): void {
      stop();
      unsubscribe();
      document.removeEventListener('visibilitychange', onVisibility);
    },
  };
}

function selectControl(
  label: string,
  initial: string,
  options: Array<[string, string]>,
  onChange: (value: string) => void,
): HTMLElement {
  const select = el('select', { class: 'control__select', 'aria-label': label });
  for (const [value, text] of options) {
    const option = el('option', { value }, text);
    if (value === initial) option.setAttribute('selected', '');
    select.append(option);
  }
  select.addEventListener('change', () => onChange(select.value));
  return el('label', { class: 'control' }, el('span', { class: 'control__label' }, label), select);
}
