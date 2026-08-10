import './styles.css';
import { LifecycleManager } from './core/lifecycle.js';
import { createCatalog } from './ui/catalog.js';
import { allModules } from './modules/registry.js';
import { el } from './ui/dom.js';

/**
 * Entry point.
 *
 * Step 2 built the machinery: the module contract, the registry, the card
 * shell and status strip, and the lifecycle manager that decides which feeds
 * are allowed to be connected. No feeds are registered yet — step 3 adds the
 * three reference modules — so the catalog renders an explicit empty state.
 *
 * That empty state is the point. A scaffold that shipped demo cards to look
 * finished would break the third founding principle on its very first screen.
 */

const PRINCIPLES: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: 'Displayed values are received values',
    detail:
      'No interpolation, extrapolation, dead reckoning, smoothing or tweening. If data arrives in jumps, it is shown in jumps. The stutter is the signal.',
  },
  {
    title: 'Gaps are shown as gaps',
    detail:
      'Missing data is rendered as missing — never as a held last value, never as a projection.',
  },
  {
    title: 'Never fabricate',
    detail:
      'No mock feeds, no placeholder series, no demo mode. A source that is down or gated shows an honest error with the reason.',
  },
  {
    title: 'Provenance is visible',
    detail:
      'Every number traces to a named, licensed, attributed source, and carries that source’s own timestamp — never our fetch time.',
  },
];

function renderShell(): HTMLElement {
  return el(
    'div',
    { class: 'shell' },
    el(
      'header',
      { class: 'topbar' },
      el('p', { class: 'wordmark' }, 'The Real-Time Earth'),
      el('p', { class: 'topbar__meta' }, 'step 2 of 7 — catalog machinery, no feeds wired yet'),
    ),
    el(
      'section',
      { class: 'thesis' },
      el('h1', {}, 'Right now, the planet is broadcasting. ', el('em', {}, 'Unmodified.')),
      el(
        'p',
        {},
        'Humanity has an unprecedented amount of high-quality real-time data publicly available. This site shows a live sample of it — exactly as received, from named and licensed sources.',
      ),
    ),
    el(
      'section',
      { class: 'principles' },
      ...PRINCIPLES.map((p, i) =>
        el(
          'article',
          { class: 'principle' },
          el('span', { class: 'principle__n' }, String(i + 1).padStart(2, '0')),
          el('h2', { class: 'principle__t' }, p.title),
          el('p', { class: 'principle__d' }, p.detail),
        ),
      ),
    ),
  );
}

function main(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) throw new Error('#app mount point is missing from index.html');

  const shell = renderShell();
  app.append(shell);

  const lifecycle = new LifecycleManager({ maxConcurrentSockets: 4 });
  const catalog = createCatalog(allModules(), lifecycle);
  shell.append(catalog.root);

  shell.append(
    el(
      'footer',
      { class: 'footer' },
      'Single Cloudflare Worker · static assets + API + relay on one origin · zero keys in this bundle',
    ),
  );

  // Tear down cleanly on navigation away, so a bfcache restore does not leave
  // orphaned sockets and timers behind.
  window.addEventListener('pagehide', () => {
    catalog.destroy();
    lifecycle.destroy();
  });
}

main();
