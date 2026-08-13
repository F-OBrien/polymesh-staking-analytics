import { scaleLinear, scaleLog, scaleUtc } from 'd3-scale';
import { line as d3Line, area as d3Area, curveMonotoneX } from 'd3-shape';

/**
 * Chart geometry: scales, paths, and the plot box. Pure functions over plain
 * numbers — no React, no DOM — which keeps the maths testable and the chart
 * components thin.
 *
 * Import d3 as submodules, never the `d3` meta-package (~600 KB). A lint rule
 * enforces this.
 */

/** Space around the plot area, for axes and labels. */
export interface Margin {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Default margins. The right margin holds the direct labels. */
export const DEFAULT_MARGIN: Margin = { top: 8, right: 96, bottom: 28, left: 52 };

export interface PlotBox {
  width: number;
  height: number;
  margin: Margin;
  /** Inner dimensions, i.e. the drawable area. */
  innerWidth: number;
  innerHeight: number;
}

export function plotBox(width: number, height: number, margin: Margin = DEFAULT_MARGIN): PlotBox {
  return {
    width,
    height,
    margin,
    // Clamped: a container can measure smaller than its margins mid-layout,
    // and a negative range makes d3 emit NaN paths.
    innerWidth: Math.max(0, width - margin.left - margin.right),
    innerHeight: Math.max(0, height - margin.top - margin.bottom),
  };
}

// ---------------------------------------------------------------------------
// Scales
// ---------------------------------------------------------------------------

export type LinearScale = ReturnType<typeof scaleLinear<number, number>>;
export type LogScale = ReturnType<typeof scaleLog<number, number>>;
export type TimeScale = ReturnType<typeof scaleUtc<number, number>>;

/**
 * Either kind of value axis. Grid and `YAxis` need only `ticks`, `domain` and
 * the call signature, so the chrome need not know which it is drawing.
 */
export type ValueScale = LinearScale | LogScale;

/**
 * The x scale: time, not era index. An era is a day, so dates are primary and
 * the era index is secondary, shown in the tooltip. UTC, so an era boundary
 * does not appear to drift across a timezone change.
 */
const ERA_SECONDS = 86_400;

export function timeScale(eraStartSeconds: readonly number[], innerWidth: number): TimeScale {
  const first = eraStartSeconds[0] ?? 0;
  const rawLast = eraStartSeconds.at(-1) ?? first;

  // A degenerate domain maps every datum to the same x, drawing the series as
  // a vertical line. Widen by one era instead.
  const last = rawLast > first ? rawLast : first + ERA_SECONDS;

  return scaleUtc<number, number>()
    .domain([new Date(first * 1000), new Date(last * 1000)])
    .range([0, innerWidth]);
}

/**
 * A linear x scale, for charts whose x axis is a quantity rather than a date —
 * the `/slashing` penalty curves, indexed by simultaneous offenders.
 */
export function numericScale(values: readonly number[], innerWidth: number): LinearScale {
  const first = values[0] ?? 0;
  const rawLast = values.at(-1) ?? first;
  // As `timeScale`: a degenerate domain would map every point to one x.
  const last = rawLast > first ? rawLast : first + 1;

  return scaleLinear<number, number>().domain([first, last]).range([0, innerWidth]);
}

export interface ValueScaleOptions {
  /** Force the axis to include zero. Right for magnitudes, wrong for rates. */
  includeZero?: boolean;
  /** Fractional padding above and below the data. */
  padding?: number;
  /** Hard floor, e.g. 0 for a quantity that cannot be negative. */
  min?: number;
  /**
   * Hard ceiling, for a series whose outlier would otherwise own the axis —
   * the chain's first week paid 12,564% APR, which flattens every week since
   * onto the floor. Marks above it are clipped, not dropped, and callers that
   * set it must say so in the UI.
   */
  max?: number;
}

/**
 * The y scale, fitted to the data actually present. Nulls are excluded rather
 * than treated as zero, and an all-null series yields a benign 0..1 domain.
 *
 * `includeZero` defaults to false because most series here are rates: forcing
 * zero onto an APR chart ranging 19–22% flattens every real difference.
 */
export function valueScale(
  series: readonly (readonly (number | null)[])[],
  innerHeight: number,
  { includeZero = false, padding = 0.08, min, max }: ValueScaleOptions = {},
): LinearScale {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;

  for (const column of series) {
    for (const value of column) {
      if (value == null || !Number.isFinite(value)) continue;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 0;
    hi = 1;
  }

  // Captured before padding and the flat-series nudge, both of which can push
  // the domain below a floor the data never crosses — an 8% pad on a 3..108
  // operator count asks for an axis starting at -5.4. Series that genuinely go
  // negative are unaffected.
  const neverNegative = lo >= 0;

  if (includeZero) {
    lo = Math.min(lo, 0);
    hi = Math.max(hi, 0);
  }

  // A flat series has zero extent; give it room off the axis itself.
  if (lo === hi) {
    const nudge = Math.abs(lo) > 0 ? Math.abs(lo) * 0.1 : 1;
    lo -= nudge;
    hi += nudge;
  }

  // Clamp before padding, or the pad is computed from the outlier's extent and
  // the ceiling ends up nowhere near where the caller asked for it.
  const cappedHi = max != null ? Math.min(hi, max) : hi;
  const pad = (cappedHi - lo) * padding;
  let domainMin = lo - pad;
  let domainMax = cappedHi + pad;
  if (neverNegative) domainMin = Math.max(domainMin, 0);
  if (min != null) domainMin = Math.max(domainMin, min);
  if (max != null) domainMax = Math.min(domainMax, max);

  return scaleLinear<number, number>()
    .domain([domainMin, domainMax])
    .range([innerHeight, 0])
    .nice();
}

/**
 * A logarithmic value axis, for series that span orders of magnitude — a
 * validator's first era pays a huge multiple (exposed on its own bond with no
 * nominators) and 20–26% every era after. Log shows both the spike and what
 * followed; linear shows one or the other.
 *
 * Non-positive values are gaps, not points: they have no log, so the caller
 * must drop them via `positiveOrNull`. A broken line is correct — an era with
 * no score is an era with no return.
 */
export function logValueScale(
  series: readonly (readonly (number | null)[])[],
  innerHeight: number,
  { padding = 0.08, max }: { padding?: number; max?: number } = {},
): LogScale {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;

  for (const column of series) {
    for (const value of column) {
      // Only positive values define a log domain; the rest are gaps.
      if (value == null || !Number.isFinite(value) || value <= 0) continue;
      if (value < lo) lo = value;
      if (value > hi) hi = value;
    }
  }

  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    lo = 1;
    hi = 10;
  }
  // A ceiling still applies: log absorbs a lot, but a 1%–38,000% series puts
  // four and a half decades on the plot and squashes the settled range.
  if (max != null) hi = Math.min(hi, max);
  if (!(hi > lo)) hi = lo * 2;

  if (lo === hi) {
    lo /= 2;
    hi *= 2;
  }

  // Multiplicative: on a log axis equal distances are equal ratios.
  const factor = (hi / lo) ** padding;

  return scaleLog<number, number>()
    .domain([lo / factor, max != null ? Math.min(hi * factor, max) : hi * factor])
    .range([innerHeight, 0]);
}

/** A value a log axis can plot, or null for the gap it has to become. */
export function positiveOrNull(value: number | null | undefined): number | null {
  return value != null && Number.isFinite(value) && value > 0 ? value : null;
}

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

export interface PathPoint {
  x: number;
  y: number | null;
}

/**
 * A line path that breaks at gaps rather than bridging them: joining across a
 * missing era would imply continuity the operator did not have.
 *
 * `curveMonotoneX` smooths without overshooting — a cardinal curve can swing an
 * APR line below zero between two positive points.
 */
export function linePath(points: readonly PathPoint[]): string {
  const generator = d3Line<PathPoint>()
    .defined((d) => d.y != null && Number.isFinite(d.y))
    .x((d) => d.x)
    .y((d) => d.y ?? 0)
    .curve(curveMonotoneX);

  return generator(points) ?? '';
}

/** An inclusive index range. */
export interface Run {
  from: number;
  to: number;
}

/**
 * Runs of missing values *inside* a series, as inclusive index ranges. A run
 * reaching either end is not a gap in the record — it is the operator not
 * existing yet, or having left — and tinting those covers most of a long chart.
 *
 * `firstSeenEra` is not consulted: the series already says where it starts, and
 * a lookup could only disagree with what is drawn.
 */
export function interiorGaps(values: readonly (number | null)[]): Run[] {
  const defined = (i: number) => {
    const value = values[i];
    return value != null && Number.isFinite(value);
  };

  let first = 0;
  while (first < values.length && !defined(first)) first += 1;
  let last = values.length - 1;
  while (last >= 0 && !defined(last)) last -= 1;

  const runs: Run[] = [];
  let start: number | null = null;
  for (let i = first; i <= last; i += 1) {
    if (!defined(i)) {
      start ??= i;
      continue;
    }
    if (start != null) {
      runs.push({ from: start, to: i - 1 });
      start = null;
    }
  }
  return runs;
}

export interface BandPoint {
  x: number;
  lo: number | null;
  hi: number | null;
}

/** The p10–p90 ribbon behind the named series. Breaks at gaps, as lines do. */
export function bandPath(points: readonly BandPoint[]): string {
  const generator = d3Area<BandPoint>()
    .defined((d) => d.lo != null && d.hi != null)
    .x((d) => d.x)
    .y0((d) => d.lo ?? 0)
    .y1((d) => d.hi ?? 0)
    .curve(curveMonotoneX);

  return generator(points) ?? '';
}

// ---------------------------------------------------------------------------
// Ticks
// ---------------------------------------------------------------------------

/**
 * Tick count scaled to available space. Chart text does not reflow, so a count
 * that reads well at 1200px overlaps at 360px.
 */
export function tickCount(pixels: number, pixelsPerTick = 80): number {
  return Math.max(2, Math.min(10, Math.floor(pixels / pixelsPerTick)));
}

/**
 * The datum nearest a pointer x, for the crosshair. Nearest-index rather than
 * hit-testing each mark, so the tooltip never flickers out between points.
 */
export function nearestIndex(xs: readonly number[], pointerX: number): number {
  if (xs.length === 0) return -1;

  let best = 0;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const [i, x] of xs.entries()) {
    const distance = Math.abs(x - pointerX);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Responsive layout
// ---------------------------------------------------------------------------

/**
 * Width below which direct labels are dropped. They need ~96px of right margin,
 * which is a quarter of a phone-width chart; the legend and table view carry
 * series identity there instead.
 */
export const DIRECT_LABEL_MIN_WIDTH = 560;

/**
 * Margins scaled to the available width. Charts are drawn at real pixel
 * dimensions (see `useMeasuredWidth`), so margins adapt rather than scale.
 */
export function responsiveMargin(width: number): Margin {
  const showsDirectLabels = width >= DIRECT_LABEL_MIN_WIDTH;
  return {
    // Headroom for the unit caption and the topmost tick label.
    top: 18,
    right: showsDirectLabels ? 96 : 12,
    bottom: 28,
    // Narrower gutter on small screens; tick labels are abbreviated to match.
    left: width < 420 ? 40 : 52,
  };
}

/**
 * Left gutter wide enough for the widest tick label it has to hold. The fixed
 * 52px from `responsiveMargin` fits "20%" but clips "10,000%" to "0,000%",
 * which reads as a different number — routine on a log axis.
 *
 * Estimated from character count, not measured: tick labels are tabular figures
 * at a known size, so measuring would cost a layout pass per render.
 */
export function gutterFor(
  ticks: readonly number[],
  format: (value: number) => string,
  fallback: number,
): number {
  let longest = 0;
  for (const tick of ticks) longest = Math.max(longest, format(tick).length);
  // 6.8px a character at the 11px tabular figures `YAxis` uses, plus the label
  // offset and slack. Errs wide on purpose — a tight gutter clips digits.
  return Math.max(fallback, Math.ceil(longest * 6.8) + 14);
}

export interface LabelPlacement {
  index: number;
  y: number;
}

/**
 * Nudges direct labels apart so they do not overprint each other. A greedy
 * downward pass in value order keeps labels in the same vertical order as their
 * series, which is what makes them matchable to the lines.
 *
 * @param ys desired y for each label, in the caller's series order
 * @param minGap minimum vertical separation in pixels
 * @param bounds plot area the labels must stay inside
 */
export function spreadLabels(
  ys: readonly (number | null)[],
  minGap: number,
  bounds: { top: number; bottom: number },
): LabelPlacement[] {
  const placed = ys
    .map((y, index) => ({ index, y }))
    .filter((entry): entry is LabelPlacement => entry.y != null)
    .sort((a, b) => a.y - b.y);

  // Forward pass: push each label down until it clears the previous one.
  let previous = Number.NEGATIVE_INFINITY;
  for (const entry of placed) {
    entry.y = Math.max(entry.y, previous + minGap);
    previous = entry.y;
  }

  // Shift the whole run rather than clamping individually, to keep the order.
  const overflow = (placed.at(-1)?.y ?? 0) - bounds.bottom;
  if (overflow > 0) {
    for (const entry of placed) entry.y -= overflow;
  }

  // Clamp into the plot, accepting overlap when there is no room — better a
  // crowded label than one drawn outside the chart.
  for (const entry of placed) {
    entry.y = Math.min(Math.max(entry.y, bounds.top), bounds.bottom);
  }

  return placed;
}
