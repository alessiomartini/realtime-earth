import type { DataModule } from '../core/types.js';
import { el } from './dom.js';
import { createStatusStrip, type StatusStripHandle } from './status-strip.js';

/**
 * A module's card: collapsed preview by default, expands to a full panel.
 *
 * The module's own `mount` is called once, lazily, the first time the card is
 * expanded — so a collapsed card costs nothing beyond its chrome. Connection is
 * a separate concern handled by the lifecycle manager, which watches this
 * card's visibility.
 */

export interface CardHandle {
  root: HTMLElement;
  /** Where the module renders. Passed to `module.mount`. */
  body: HTMLElement;
  update(now: number, queued: boolean): void;
  readonly expanded: boolean;
}

export function createCard(module: DataModule): CardHandle {
  const strip: StatusStripHandle = createStatusStrip(module);
  const body = el('div', { class: 'card__mount' });
  const errorBox = el('p', { class: 'card__error', hidden: '' });

  const toggle = el(
    'button',
    { class: 'card__toggle', type: 'button', 'aria-expanded': 'false' },
    el('span', { class: 'card__title' }, module.title),
    el('span', { class: 'card__chevron', 'aria-hidden': 'true' }, '▸'),
  );

  const detail = el(
    'div',
    { class: 'card__detail', hidden: '' },
    body,
    errorBox,
    el('p', { class: 'card__why' }, module.why),
    el(
      'p',
      { class: 'card__provenance' },
      'Source: ',
      el('a', { href: module.source.url, rel: 'noopener noreferrer', target: '_blank' }, module.source.name),
      ' · ',
      module.source.license,
      ' · ',
      module.source.attribution,
      ' · expected cadence ',
      module.cadence,
    ),
  );

  const root = el(
    'article',
    { class: 'card', 'data-section': module.section, 'data-lane': module.lane, id: `module-${module.id}` },
    el('header', { class: 'card__head' }, toggle),
    el('p', { class: 'card__oneliner' }, module.oneLiner),
    strip.root,
    detail,
  );

  let expanded = false;
  let mounted = false;

  toggle.addEventListener('click', () => {
    expanded = !expanded;
    toggle.setAttribute('aria-expanded', String(expanded));
    detail.toggleAttribute('hidden', !expanded);
    root.classList.toggle('card--expanded', expanded);
    if (expanded && !mounted) {
      // Mount on first expand: a collapsed card should not pay for a chart or a
      // map it is not showing.
      module.mount(body);
      mounted = true;
    }
  });

  let lastError: string | null = null;

  function update(now: number, queued: boolean): void {
    strip.update(now, queued);

    // Principle 3: a source that is down or gated states the reason, in place,
    // instead of rendering as an empty panel that reads like "no events".
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
  }

  return {
    root,
    body,
    update,
    get expanded() {
      return expanded;
    },
  };
}
