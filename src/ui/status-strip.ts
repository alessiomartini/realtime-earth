import type { DataModule } from '../core/types.js';
import { LATENCY_LABELS, TRANSPORT_GLYPHS } from '../core/types.js';
import { el, formatAge, formatCount } from './dom.js';

/**
 * The status strip every card carries: transport, lane, latency badge, health
 * dot, message counter, and the age of the last datum.
 *
 * This is where the site's honesty is most visible, so two rules govern it:
 *
 *   - The age is computed from the SOURCE's timestamp. A module that reports no
 *     source timestamp shows "—". It never falls back to time-since-fetch,
 *     which would present our own latency as the data's freshness.
 *   - Health has four distinct states and they never collapse into each other.
 *     In particular "queued for a connection slot" is shown as its own thing,
 *     because a feed waiting its turn must not look like a feed that is broken.
 */

export interface StatusStripHandle {
  root: HTMLElement;
  update(now: number, queued: boolean): void;
}

export function createStatusStrip(module: DataModule): StatusStripHandle {
  const dot = el('span', { class: 'dot', 'aria-hidden': 'true' });
  const healthText = el('span', { class: 'strip__health' }, 'connecting');
  const counter = el('span', { class: 'strip__count' }, '0');
  const age = el('span', { class: 'strip__age' }, '—');

  const root = el(
    'div',
    { class: 'strip', role: 'status' },
    el(
      'span',
      { class: 'strip__transport', title: `${module.transport} · lane ${module.lane}` },
      `${TRANSPORT_GLYPHS[module.transport]} ${module.transport}`,
    ),
    el('span', { class: 'strip__lane', title: `Lane ${module.lane}` }, `lane ${module.lane}`),
    el('span', { class: `badge badge--${module.latencyClass}` }, LATENCY_LABELS[module.latencyClass]),
    el('span', { class: 'strip__spacer' }),
    el('span', { class: 'strip__metric', title: 'messages received since page load' }, counter, el('span', { class: 'strip__unit' }, 'msg')),
    el('span', { class: 'strip__metric', title: 'age of the last datum, by the source’s own timestamp' }, age, el('span', { class: 'strip__unit' }, 'old')),
    el('span', { class: 'strip__healthgroup' }, dot, healthText),
  );

  let lastHealthClass = '';
  let lastHealthLabel = '';
  let lastCount = -1;
  let lastAge = '';

  function update(now: number, queued: boolean): void {
    // "queued" is a manager-level fact, not a module health state: the module
    // is fine, it just has not been given a connection slot yet.
    const label = queued ? 'queued' : module.health;
    const healthClass = queued ? 'dot--queued' : `dot--${module.health}`;

    if (healthClass !== lastHealthClass) {
      dot.className = `dot ${healthClass}`;
      lastHealthClass = healthClass;
    }

    // An error is worth its reason. Truncated here; the card body shows it in full.
    const text =
      module.health === 'error' && !queued && module.errorReason !== null
        ? `error — ${module.errorReason}`
        : label;
    if (text !== lastHealthLabel) {
      healthText.textContent = text;
      lastHealthLabel = text;
    }

    if (module.messageCount !== lastCount) {
      counter.textContent = formatCount(module.messageCount);
      lastCount = module.messageCount;
    }

    const ageText =
      module.lastSourceTimestamp === null ? '—' : formatAge(now - module.lastSourceTimestamp);
    if (ageText !== lastAge) {
      age.textContent = ageText;
      lastAge = ageText;
    }
  }

  return { root, update };
}
