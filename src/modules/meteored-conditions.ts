import { ProxyModule, type ProxyEnvelope } from '../core/proxy-module.js';
import { register } from './registry.js';
import { el } from '../ui/dom.js';

/**
 * Meteored — current conditions for one locality. Lane B.
 *
 * WHY THIS FEED IS SMALL, WHEN MOST OF MENTORED'S PRODUCT IS NOT. Meteored's
 * API returns a multi-day forecast for a named town. This module shows only the
 * CURRENT observed values from that response and deliberately does not plot the
 * forecast days.
 *
 * That is not an oversight and it is not laziness. This site shows what has been
 * measured. A forecast is a statement about a future that has not happened, made
 * by a model — honest work by a real forecasting outfit, and a different kind of
 * thing from every other number on this site. Putting predicted temperatures on
 * the same page as received earthquake times, under the same "as received"
 * banner, would quietly redefine what the banner means. So they are left out,
 * and the page says they were left out rather than pretending the response did
 * not contain them.
 *
 * WHY THE FIELDS ARE NAMED THE WAY THEY ARE. Meteored refuses every request
 * without a registered, activated account, so its exact element names have never
 * been observed from here. The Worker therefore tries several candidate names
 * per field and reports which one actually matched, plus a census of every
 * element the response contained. This page shows both. If a field is missing,
 * you see the names that WERE present rather than an empty panel — which is the
 * difference between "no reading" and "we were looking for the wrong word".
 */

const POLL_MS = 60_000;

interface Reading {
  key: string;
  label: string;
  unit: string;
  value: string;
  /** Which element name carried it, so a guessed schema corrects itself. */
  matchedElement: string;
}

interface MeteoredPayload {
  readings?: Reading[];
  missing?: string[];
  census?: Record<string, number>;
  timestampElement?: string | null;
  timestampRaw?: string | null;
  /** Meteored reports its own refusals inside a 200 response. */
  error?: string;
  body?: string;
}

class MeteoredConditions extends ProxyModule<MeteoredPayload> {
  #payload: MeteoredPayload | null = null;

  #summary: HTMLElement | null = null;
  #cacheLine: HTMLElement | null = null;
  #readings: HTMLElement | null = null;
  #schema: HTMLElement | null = null;

  constructor() {
    super({
      id: 'meteored-conditions',
      section: 'earth',
      title: 'Meteored, one locality',
      oneLiner: 'Current conditions for a single town, from Meteored’s own observation feed.',
      why: 'Meteored runs its own forecasting operation and publishes locality data through a registered API. It is a deliberately narrow feed on a site of global ones — one town, measured now — and it is here because it is a second, independent opinion about the same atmosphere the field map models.',
      transport: 'proxy-poll',
      lane: 'B',
      latencyClass: 'delayed',
      cadence: 'every 30 min',
      staleAfterMs: 95 * 60_000,
      historyNote:
        'No history, and no forecast. Meteored’s response also contains a multi-day forecast; it is deliberately not shown, because this site shows what has been measured rather than what is expected.',
      pollMs: POLL_MS,
      source: {
        name: 'Meteored — api.tiempo.com',
        url: 'https://www.meteored.com/',
        license: 'Requires a registered, activated account; used under their API terms',
        attribution: 'Meteored / tiempo.com',
      },
    });
  }

  mount(el_: HTMLElement): void {
    this.element = el_;
    this.#summary = el('p', { class: 'module__summary' }, 'connecting…');
    this.#cacheLine = el('p', { class: 'module__latency' }, '');
    this.#readings = el('dl', { class: 'readout readout--wide' });
    this.#schema = el('p', { class: 'module__caveat' }, '');
    el_.append(this.#summary, this.#cacheLine, this.#readings, this.#schema);
    this.#render();
  }

  protected onPayload(data: MeteoredPayload, _envelope: ProxyEnvelope<MeteoredPayload>): void {
    this.#payload = data;
    this.#render();
  }

  protected onPolled(): void {
    this.#render();
  }

  #render(): void {
    const payload = this.#payload;

    if (this.#cacheLine !== null) {
      this.#cacheLine.textContent = this.cacheLabel();
    }

    // Meteored answers its own refusals with HTTP 200 and an <error> element,
    // so a successful fetch can still carry a refusal. It is shown verbatim —
    // "your account is not activated" is actionable in a way "no data" is not.
    if (payload?.error !== undefined) {
      if (this.#summary !== null) this.#summary.textContent = `Meteored replied: ${payload.error}`;
      this.#readings?.replaceChildren();
      if (this.#schema !== null) this.#schema.textContent = '';
      return;
    }

    const readings = payload?.readings ?? [];
    if (this.#summary !== null) {
      this.#summary.textContent =
        readings.length === 0
          ? this.health === 'error'
            ? 'no readings'
            : 'waiting for the first response…'
          : `${readings.length} current values${payload?.timestampRaw ? ` · Meteored’s own timestamp: ${payload.timestampRaw}` : ' · Meteored reported no timestamp'}`;
    }

    if (this.#readings !== null) {
      this.#readings.replaceChildren(
        ...readings.map((reading) =>
          el(
            'div',
            {},
            el('dt', {}, reading.label),
            el(
              'dd',
              { title: `from the <${reading.matchedElement}> element` },
              reading.unit === '' ? reading.value : `${reading.value} ${reading.unit}`,
            ),
          ),
        ),
      );
    }

    if (this.#schema !== null) {
      const missing = payload?.missing ?? [];
      const census = payload?.census ?? {};
      const names = Object.keys(census);
      if (readings.length === 0 && names.length > 0) {
        // The whole point of carrying the census: an unrecognised response
        // describes itself instead of reading as an empty one.
        this.#schema.textContent =
          `None of the fields this page looks for were found. The response did contain: ${names.slice(0, 24).join(', ')}. ` +
          'That is a naming mismatch to be corrected from this evidence, not an absence of data.';
      } else if (missing.length > 0) {
        this.#schema.textContent = `Not present in this response: ${missing.join(', ')}. Meteored’s forecast days are in the response and are deliberately not shown.`;
      } else {
        this.#schema.textContent =
          'Meteored’s forecast days are in the response and are deliberately not shown: this site shows what has been measured, not what is expected.';
      }
    }
  }
}

register(new MeteoredConditions());
