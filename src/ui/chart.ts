import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

/**
 * uPlot wrapper for time series of received values.
 *
 * Two decisions here carry the first founding principle into the chart itself:
 *
 * 1. **Stepped paths, not lines.** A straight line drawn between two received
 *    points asserts a value at every pixel in between — values the source never
 *    sent. A step says "it was this until the next reading arrived", which is
 *    the only thing we actually know. On a trade tape or a 1-minute poll, the
 *    difference is the difference between showing data and drawing a guess.
 *
 * 2. **Gaps stay gaps.** `spanGaps` is off, so a null reading leaves a hole in
 *    the line instead of a segment bridging the silence.
 *
 * There is no animation and no transition. The chart repaints when data
 * arrives, and the repaint is instant.
 */

export interface ChartSeries {
  label: string;
  stroke: string;
  fill?: string;
  /** Decimal places for the readout. */
  precision?: number;
}

/**
 * Built once. uPlot exposes `paths.stepped` as optional in its typings, and a
 * missing builder must not be handed to the series config as `undefined`.
 */
const steppedPath = uPlot.paths.stepped?.({ align: 1 });

export class TimeChart {
  #plot: uPlot | null = null;
  #container: HTMLElement;
  #series: ChartSeries[];
  #resizeObserver: ResizeObserver | null = null;
  #height: number;

  constructor(container: HTMLElement, series: ChartSeries[], { height = 260 } = {}) {
    this.#container = container;
    this.#series = series;
    this.#height = height;

    if (typeof ResizeObserver !== 'undefined') {
      this.#resizeObserver = new ResizeObserver(() => this.#fit());
      this.#resizeObserver.observe(container);
    }
  }

  #options(width: number): uPlot.Options {
    return {
      width,
      height: this.#height,
      // No cursor animation, no drag-zoom easing: the chart is an instrument
      // readout, not a toy.
      cursor: { drag: { x: false, y: false } },
      legend: { live: true },
      axes: [
        {
          stroke: '#5d6874',
          grid: { stroke: '#1b222a', width: 1 },
          ticks: { stroke: '#1b222a' },
          font: '11px ui-monospace, monospace',
        },
        {
          stroke: '#5d6874',
          grid: { stroke: '#1b222a', width: 1 },
          ticks: { stroke: '#1b222a' },
          font: '11px ui-monospace, monospace',
          size: 56,
        },
      ],
      series: [
        { label: 'time' },
        ...this.#series.map((s) => ({
          label: s.label,
          stroke: s.stroke,
          ...(s.fill === undefined ? {} : { fill: s.fill }),
          width: 1.5,
          // The step is the honesty: the value held until the next one arrived.
          // `stepped` is optional in uPlot's typings, so fall back to the
          // default path builder rather than passing undefined through.
          ...(steppedPath === undefined ? {} : { paths: steppedPath }),
          spanGaps: false,
          points: { show: false },
          value: (_self: uPlot, raw: number | null) =>
            raw === null ? '—' : raw.toFixed(s.precision ?? 2),
        })),
      ],
    };
  }

  #fit(): void {
    const width = Math.floor(this.#container.getBoundingClientRect().width);
    if (width <= 0) return;
    this.#plot?.setSize({ width, height: this.#height });
  }

  setData(data: uPlot.AlignedData): void {
    if (this.#plot === null) {
      const width = Math.max(240, Math.floor(this.#container.getBoundingClientRect().width) || 640);
      this.#plot = new uPlot(this.#options(width), data, this.#container);
      return;
    }
    this.#plot.setData(data);
  }

  destroy(): void {
    this.#resizeObserver?.disconnect();
    this.#resizeObserver = null;
    this.#plot?.destroy();
    this.#plot = null;
  }
}
