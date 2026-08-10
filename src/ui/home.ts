import type { DataModule, Lane, LatencyClass, Section, Transport } from '../core/types.js';
import { LATENCY_LABELS, SECTION_LABELS, SECTION_ORDER, TRANSPORT_GLYPHS } from '../core/types.js';
import type { LifecycleManager } from '../core/lifecycle.js';
import { el, formatAge, formatCount } from './dom.js';

/**
 * The home page: a grid of tiles, one per feed, each linking to its own page.
 *
 * The tiles are live, not static links. A tile connects when it scrolls into
 * view and shows its real health, count and data age, so the grid is itself an
 * instrument panel — and the global counter above it is real. Opening a tile
 * gives the feed its full page, with the chart or map.
 *
 * The counter sums live messages only. Backfilled history is real data but not
 * events that arrived while you were watching, and folding it in would inflate
 * the one number the whole thesis rests on.
 */

interface Filters {
  section: Section | 'all';
  transport: Transport | 'all';
  lane: Lane | 'all';
  latency: LatencyClass | 'all';
}

export interface HomeHandle {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export function createHome(modules: DataModule[], lifecycle: LifecycleManager): HomeHandle {
  const filters: Filters = { section: 'all', transport: 'all', lane: 'all', latency: 'all' };

  const counterValue = el('span', { class: 'counter__value' }, '0');
  const counterNote = el('span', { class: 'counter__note' }, '');
  const grid = el('div', { class: 'grid' });
  const emptyState = el('p', { class: 'empty', hidden: '' });

  const pauseButton = el('button', { class: 'control control--pause', type: 'button' }, 'Pause all');
  pauseButton.addEventListener('click', () => lifecycle.togglePaused());

  const tiles = new Map<string, { root: HTMLElement; update(now: number): void }>();

  for (const module of modules) {
    const tile = createTile(module, lifecycle);
    tiles.set(module.id, tile);
    grid.append(tile.root);
    lifecycle.register(module, tile.root);
  }

  function applyFilters(): void {
    const visible = modules.filter(
      (m) =>
        (filters.section === 'all' || m.section === filters.section) &&
        (filters.transport === 'all' || m.transport === filters.transport) &&
        (filters.lane === 'all' || m.lane === filters.lane) &&
        (filters.latency === 'all' || m.latencyClass === filters.latency),
    );
    const visibleIds = new Set(visible.map((m) => m.id));
    for (const [id, tile] of tiles) tile.root.toggleAttribute('hidden', !visibleIds.has(id));

    if (visible.length === 0) {
      emptyState.textContent =
        modules.length === 0
          ? 'No feeds are wired yet. A feed appears here only once its endpoint has been verified to work.'
          : 'No feeds match these filters.';
      emptyState.removeAttribute('hidden');
    } else {
      emptyState.setAttribute('hidden', '');
    }
  }

  const root = el(
    'section',
    { class: 'home' },
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
      select('Section', [['all', 'All sections'], ...SECTION_ORDER.map((s) => [s, SECTION_LABELS[s]] as [string, string])], (v) => {
        filters.section = v as Section | 'all';
        applyFilters();
      }),
      select(
        'Transport',
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
      select(
        'Lane',
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
      select(
        'Latency',
        [['all', 'All latencies'], ...(Object.keys(LATENCY_LABELS) as LatencyClass[]).map((l) => [l, LATENCY_LABELS[l]] as [string, string])],
        (v) => {
          filters.latency = v as LatencyClass | 'all';
          applyFilters();
        },
      ),
      pauseButton,
    ),
    grid,
    emptyState,
  );

  applyFilters();

  return {
    root,
    refresh(): void {
      const now = Date.now();
      let live = 0;
      for (const module of modules) {
        live += module.messageCount;
        tiles.get(module.id)?.update(now);
      }
      counterValue.textContent = formatCount(live);
      const connected = lifecycle.connectedCount;
      counterNote.textContent = lifecycle.paused
        ? 'paused — nothing is arriving'
        : `across ${connected} connected feed${connected === 1 ? '' : 's'} · historical points loaded on open are counted separately, per feed`;
      pauseButton.textContent = lifecycle.paused ? 'Resume all' : 'Pause all';
      pauseButton.classList.toggle('control--active', lifecycle.paused);
    },
    destroy(): void {
      tiles.clear();
    },
  };
}

function createTile(module: DataModule, lifecycle: LifecycleManager) {
  const dot = el('span', { class: 'dot' });
  const health = el('span', { class: 'tile__health' }, 'connecting');
  const count = el('span', { class: 'tile__count' }, '0');
  const age = el('span', { class: 'tile__age' }, '—');

  const root = el(
    'a',
    { class: 'tile', href: `/m/${module.id}`, 'data-section': module.section },
    el(
      'span',
      { class: 'tile__top' },
      el('span', { class: `badge badge--${module.latencyClass}` }, LATENCY_LABELS[module.latencyClass]),
      el('span', { class: 'tile__transport' }, `${TRANSPORT_GLYPHS[module.transport]} ${module.transport} · lane ${module.lane}`),
    ),
    el('span', { class: 'tile__title' }, module.title),
    el('span', { class: 'tile__oneliner' }, module.oneLiner),
    el(
      'span',
      { class: 'tile__strip' },
      el('span', { class: 'tile__metric' }, count, el('span', { class: 'tile__unit' }, 'msg')),
      el('span', { class: 'tile__metric' }, age, el('span', { class: 'tile__unit' }, 'old')),
      el('span', { class: 'tile__healthgroup' }, dot, health),
    ),
    el('span', { class: 'tile__open' }, 'Open →'),
  );

  let lastHealth = '';
  let lastCount = -1;
  let lastAge = '';

  return {
    root,
    update(now: number): void {
      const queued = lifecycle.isQueued(module.id);
      const state = queued ? 'queued' : module.health;
      if (state !== lastHealth) {
        dot.className = `dot dot--${queued ? 'queued' : module.health}`;
        health.textContent = state;
        lastHealth = state;
      }
      if (module.messageCount !== lastCount) {
        count.textContent = formatCount(module.messageCount);
        lastCount = module.messageCount;
      }
      const ageText = module.lastSourceTimestamp === null ? '—' : formatAge(now - module.lastSourceTimestamp);
      if (ageText !== lastAge) {
        age.textContent = ageText;
        lastAge = ageText;
      }
    },
  };
}

function select(label: string, options: Array<[string, string]>, onChange: (value: string) => void): HTMLElement {
  const node = el('select', { class: 'control__select', 'aria-label': label });
  for (const [value, text] of options) node.append(el('option', { value }, text));
  node.addEventListener('change', () => onChange(node.value));
  return el('label', { class: 'control' }, el('span', { class: 'control__label' }, label), node);
}
