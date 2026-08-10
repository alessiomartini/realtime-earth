import type { DataModule } from '../core/types.js';
import { LATENCY_LABELS, SECTION_LABELS, TRANSPORT_GLYPHS } from '../core/types.js';
import { el, formatAge, formatCount } from './dom.js';

/**
 * A feed's own page: the chart or map at full width, with everything needed to
 * judge what is on screen — health, counts, the age of the last datum by the
 * source's own clock, what the history covers, and the licence and attribution.
 *
 * The module mounts here once. The page repaints its readouts once a second,
 * which is required whether or not data arrives: the age of the last datum
 * keeps growing while a feed is silent, and that growing number is how a
 * stalled feed reveals itself.
 */

export interface ModulePageHandle {
  root: HTMLElement;
  refresh(): void;
  destroy(): void;
}

export function createModulePage(module: DataModule): ModulePageHandle {
  const mount = el('div', { class: 'module__mount' });
  const errorBox = el('p', { class: 'card__error', hidden: '' });

  const dot = el('span', { class: 'dot' });
  const healthText = el('span', {}, 'connecting');
  const liveCount = el('dd', {}, '0');
  const historyCount = el('dd', {}, '—');
  const ageValue = el('dd', {}, '—');
  const sourceTime = el('dd', {}, '—');

  const root = el(
    'article',
    { class: 'module' },
    el('a', { class: 'backlink', href: '/' }, '← All feeds'),
    el(
      'header',
      { class: 'module__head' },
      el('p', { class: 'module__section' }, SECTION_LABELS[module.section]),
      el('h1', { class: 'module__title' }, module.title),
      el('p', { class: 'module__oneliner' }, module.oneLiner),
      el(
        'div',
        { class: 'module__badges' },
        el('span', { class: `badge badge--${module.latencyClass}` }, LATENCY_LABELS[module.latencyClass]),
        el('span', { class: 'module__tag' }, `${TRANSPORT_GLYPHS[module.transport]} ${module.transport}`),
        el('span', { class: 'module__tag' }, `lane ${module.lane}`),
        el('span', { class: 'module__tag' }, `expected ${module.cadence}`),
        el('span', { class: 'module__healthgroup' }, dot, healthText),
      ),
    ),
    errorBox,
    mount,
    el(
      'dl',
      { class: 'readout' },
      el('div', {}, el('dt', {}, 'received live'), liveCount),
      el('div', {}, el('dt', {}, 'history loaded'), historyCount),
      el('div', {}, el('dt', {}, 'age of last datum'), ageValue),
      el('div', {}, el('dt', {}, 'source timestamp'), sourceTime),
    ),
    module.historyNote === null
      ? null
      : el('p', { class: 'module__history' }, module.historyNote),
    el('p', { class: 'module__why' }, module.why),
    el(
      'p',
      { class: 'card__provenance' },
      'Source: ',
      el('a', { href: module.source.url, rel: 'noopener noreferrer', target: '_blank' }, module.source.name),
      ' · ',
      module.source.license,
      ' · ',
      module.source.attribution,
    ),
  );

  // Mount immediately: on a dedicated page the visualization is the reason the
  // reader is here.
  module.mount(mount);

  let lastError: string | null = null;

  return {
    root,
    refresh(): void {
      const now = Date.now();
      dot.className = `dot dot--${module.health}`;
      healthText.textContent = module.health;

      liveCount.textContent = formatCount(module.messageCount);
      historyCount.textContent =
        module.backfillCount > 0 ? `${formatCount(module.backfillCount)} points` : 'none';

      // Age is measured from the SOURCE's timestamp. No source timestamp means
      // the age is genuinely unknown, and it says so instead of showing zero.
      if (module.lastSourceTimestamp === null) {
        ageValue.textContent = '—';
        ageValue.classList.add('is-absent');
        sourceTime.textContent = 'not reported';
        sourceTime.classList.add('is-absent');
      } else {
        ageValue.textContent = formatAge(now - module.lastSourceTimestamp);
        ageValue.classList.remove('is-absent');
        sourceTime.textContent = new Date(module.lastSourceTimestamp)
          .toISOString()
          .slice(0, 19)
          .replace('T', ' ');
        sourceTime.classList.remove('is-absent');
      }

      const reason = module.health === 'error' ? module.errorReason : null;
      if (reason !== lastError) {
        if (reason === null) {
          errorBox.setAttribute('hidden', '');
          errorBox.textContent = '';
        } else {
          errorBox.removeAttribute('hidden');
          errorBox.textContent = `This feed is not delivering data: ${reason}`;
        }
        lastError = reason;
      }
    },
    destroy(): void {
      // Give the module the chance to release its chart, canvas and observers
      // before the DOM under it disappears.
      module.unmount?.();
      mount.replaceChildren();
    },
  };
}
