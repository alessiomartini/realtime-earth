import './styles.css';
import { LifecycleManager } from './core/lifecycle.js';
import { Router, type Route } from './core/router.js';
import { createHome } from './ui/home.js';
import { createModulePage } from './ui/module-page.js';
import { allModules, moduleById } from './modules/all.js';
import { createNotebook } from './ui/notebook.js';
import { el } from './ui/dom.js';

/**
 * Entry point.
 *
 * Two views: the home grid of feeds, and one page per feed at `/m/<id>`.
 *
 * The lifecycle manager owns connections across both. On the home grid, tiles
 * connect as they scroll into view, under the socket cap, so the counter is
 * real. On a feed's own page only that feed is registered, so it gets the
 * connection and the rest are torn down.
 */

const PRINCIPLES: ReadonlyArray<{ title: string; detail: string }> = [
  {
    title: 'Displayed values are received values',
    detail:
      'No interpolation, extrapolation, smoothing or tweening. Charts step rather than slope, because a diagonal between two readings asserts values nobody sent.',
  },
  {
    title: 'Gaps are shown as gaps',
    detail: 'Missing data leaves a hole — never a held last value, never a projection.',
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

function header(): HTMLElement {
  return el(
    'header',
    { class: 'topbar' },
    el('a', { class: 'wordmark', href: '/' }, 'The Real-Time Earth'),
    el('p', { class: 'topbar__meta' }, `${allModules().length} feeds · every value as received`),
  );
}

function homeIntro(): HTMLElement {
  // The principles sit OUTSIDE the thesis block: `.thesis` is deliberately
  // narrow for reading, and nesting the four-column grid inside it collapsed
  // them into one cramped column.
  return el(
    'div',
    { class: 'home-intro' },
    el(
      'section',
      { class: 'thesis' },
      el('h1', {}, 'Right now, the planet is broadcasting. ', el('em', {}, 'Unmodified.')),
      el(
        'p',
        {},
        'Humanity has an unprecedented amount of high-quality real-time data publicly available. Each tile below is one live feed, shown exactly as received. Open one for the full chart or map.',
      ),
    ),
    el(
      'div',
      { class: 'principles principles--compact' },
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

function notFound(id: string): HTMLElement {
  return el(
    'section',
    { class: 'module' },
    el('a', { class: 'backlink', href: '/' }, '← All feeds'),
    el('h1', { class: 'module__title' }, 'No such feed'),
    el(
      'p',
      { class: 'module__oneliner' },
      `There is no feed with the id “${id}”. It may have been removed because its source stopped working — feeds are not kept on the site once they cannot deliver real data.`,
    ),
  );
}

function main(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) throw new Error('#app mount point is missing from index.html');

  const shell = el('div', { class: 'shell' });
  const view = el('main', { class: 'view' });
  shell.append(header(), view);
  app.append(shell);

  const footer = el(
    'footer',
    { class: 'footer' },
    'Single Cloudflare Worker · static assets + API + relay on one origin · zero keys in this bundle',
  );

  const modules = allModules();
  let lifecycle = new LifecycleManager({ maxConcurrentSockets: 4 });
  let current: { refresh(): void; destroy(): void } | null = null;

  function render(route: Route): void {
    current?.destroy();
    current = null;
    // A fresh manager per view guarantees the previous view's feeds are really
    // disconnected — sockets closed, timers cleared — rather than merely
    // hidden. Leaving a stream running behind a page you left would burn the
    // source's bandwidth to show nobody anything.
    lifecycle.destroy();
    lifecycle = new LifecycleManager({ maxConcurrentSockets: 4 });
    view.replaceChildren();

    if (route.name === 'module') {
      const module = moduleById(route.id);
      if (module === undefined) {
        view.append(notFound(route.id), footer);
        document.title = 'Not found — The Real-Time Earth';
        return;
      }
      const page = createModulePage(module);
      view.append(page.root, footer);
      // The page is the whole view, so this feed connects immediately rather
      // than waiting to be scrolled into sight.
      lifecycle.register(module, page.root);
      module.connect();
      page.refresh();
      current = {
        refresh: () => page.refresh(),
        destroy: () => {
          module.disconnect();
          page.destroy();
        },
      };
      document.title = `${module.title} — The Real-Time Earth`;
      return;
    }

    const home = createHome(modules, lifecycle);
    view.append(homeIntro(), home.root, footer);
    home.refresh();
    current = home;
    document.title = 'The Real-Time Earth';
  }

  const router = new Router(render);
  router.bindLinks(app);
  render(router.current);

  // The notebook sits outside the view, so it survives navigation: a thought
  // half-typed on one page is not thrown away by clicking through to another.
  const notebook = createNotebook(() => window.location.pathname);
  app.append(notebook.root);

  // One tick a second drives every readout. Required regardless of arrivals:
  // the age of the last datum grows while a feed is silent, and that growing
  // number is exactly how a stalled feed reveals itself. A clock, not an
  // animation — it interpolates nothing.
  let tick: ReturnType<typeof setInterval> | null = setInterval(() => current?.refresh(), 1000);

  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'hidden') {
      if (tick !== null) clearInterval(tick);
      tick = null;
    } else if (tick === null) {
      tick = setInterval(() => current?.refresh(), 1000);
      current?.refresh();
    }
  });

  window.addEventListener('pagehide', () => {
    if (tick !== null) clearInterval(tick);
    current?.destroy();
    lifecycle.destroy();
    router.destroy();
    notebook.destroy();
  });
}

main();
