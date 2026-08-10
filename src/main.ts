import './styles.css';

/**
 * Step 1 — scaffold only.
 *
 * This page exists to prove one thing: that a single Cloudflare Worker serves
 * both the static bundle and a Worker route from one origin. The only live
 * value on it is the response from `/api/health`, which is a deployment probe,
 * not a data feed — it is labelled as such so it is never mistaken for one.
 *
 * The module contract, registry and catalog land in step 2.
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

const STEPS: ReadonlyArray<{ tag: string; done: boolean; text: string }> = [
  { tag: 'Step 1', done: true, text: 'Scaffold: Vite + TypeScript, one Worker serving assets and routes, CI deploy.' },
  { tag: 'Step 2', done: false, text: 'Module contract, registry, card shell, status strip, lifecycle manager.' },
  { tag: 'Step 3', done: false, text: 'Reference modules: USGS (poll), Wikipedia (SSE), Binance (WebSocket).' },
  { tag: 'Step 4', done: false, text: 'Lane B: Worker proxy route, scheduled handler, KV storage.' },
  { tag: 'Step 5', done: false, text: 'Lane C: AIS Durable Object relay and its map module.' },
  { tag: 'Step 6', done: false, text: 'Remaining modules, section by section.' },
];

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<string, string> = {},
  ...children: Array<Node | string>
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) node.setAttribute(key, value);
  node.append(...children);
  return node;
}

/** A readout cell. `value === null` renders as absent, never as a filled blank. */
function cell(label: string, value: string | null): HTMLElement {
  const dd = el('dd', value === null ? { class: 'is-absent' } : {}, value ?? 'not reported');
  return el('div', {}, el('dt', {}, label), dd);
}

function render(): void {
  const app = document.querySelector<HTMLDivElement>('#app');
  if (!app) throw new Error('#app mount point is missing from index.html');

  const health = el('div', { class: 'status', id: 'health' }, el('span', { class: 'dot dot--connecting' }), 'probing…');
  const readout = el(
    'dl',
    { class: 'readout', id: 'health-readout' },
    cell('worker time', null),
    cell('runtime', null),
    cell('colo', null),
    cell('probe', null),
  );

  app.append(
    el(
      'div',
      { class: 'shell' },
      el(
        'header',
        { class: 'topbar' },
        el('p', { class: 'wordmark' }, 'The Real-Time Earth ', el('span', {}, '/ scaffold')),
        el('p', { class: 'topbar__meta' }, 'step 1 of 7 — no feeds connected yet'),
      ),

      el(
        'section',
        { class: 'thesis' },
        el('h1', {}, 'Right now, the planet is broadcasting. ', el('em', {}, 'Unmodified.')),
        el(
          'p',
          {},
          'Humanity has an unprecedented amount of high-quality real-time data publicly available. This site will show a live sample of it — exactly as received, from named and licensed sources.',
        ),
        el(
          'p',
          {},
          'Nothing on this page is a data feed yet. The catalog is built in the steps below, and until a feed is wired to a verified endpoint it is not shown at all.',
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

      el(
        'section',
        { class: 'panel' },
        el(
          'div',
          { class: 'panel__head' },
          el('h2', { class: 'panel__title' }, 'Deployment probe — /api/health'),
          health,
        ),
        el(
          'div',
          { class: 'panel__body' },
          readout,
          el(
            'p',
            { class: 'note' },
            'This is a smoke test for the hosting model, not a data module: it confirms that one Worker is serving both this bundle and its own API route on one origin. Every value shown is observed by that Worker at request time; anything it cannot observe reads “not reported” rather than being filled in.',
          ),
        ),
      ),

      el(
        'section',
        { class: 'panel' },
        el('div', { class: 'panel__head' }, el('h2', { class: 'panel__title' }, 'Order of work')),
        el(
          'div',
          { class: 'panel__body' },
          el(
            'ul',
            { class: 'steps' },
            ...STEPS.map((s) =>
              el(
                'li',
                {},
                el('span', { class: s.done ? 'tag tag--done' : 'tag' }, s.done ? `${s.tag} ✓` : s.tag),
                el('span', {}, s.text),
              ),
            ),
          ),
        ),
      ),

      el(
        'footer',
        { class: 'footer' },
        'Single Cloudflare Worker · static assets + API + relay on one origin · zero keys in this bundle',
      ),
    ),
  );
}

async function probeHealth(): Promise<void> {
  const status = document.querySelector('#health');
  const readout = document.querySelector('#health-readout');
  if (!status || !readout) return;

  const show = (dotClass: string, text: string, cells: HTMLElement[]): void => {
    status.replaceChildren(el('span', { class: `dot ${dotClass}` }), text);
    readout.replaceChildren(...cells);
  };

  try {
    const response = await fetch('/api/health', { headers: { accept: 'application/json' } });
    if (!response.ok) {
      // An HTTP error is reported as an error with its reason. It is never
      // downgraded into an empty-but-successful state.
      show('dot--error', `error — HTTP ${response.status}`, [
        cell('worker time', null),
        cell('runtime', null),
        cell('colo', null),
        cell('probe', `HTTP ${response.status}`),
      ]);
      return;
    }

    const body = (await response.json()) as {
      workerTime?: string;
      runtime?: string;
      colo?: string | null;
    };
    show('dot--ok', 'ok', [
      cell('worker time', body.workerTime ?? null),
      cell('runtime', body.runtime ?? null),
      // Absent on local dev by design: the local runtime's `cf` object is a
      // placeholder, so there is no observed colo to show.
      cell('colo', body.colo ?? null),
      cell('probe', 'reached the Worker'),
    ]);
  } catch (error) {
    const reason = error instanceof Error ? error.message : 'unknown failure';
    show('dot--error', 'error', [
      cell('worker time', null),
      cell('runtime', null),
      cell('colo', null),
      cell('probe', reason),
    ]);
  }
}

render();
void probeHealth();
