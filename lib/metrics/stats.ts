/**
 * Distribution and concentration statistics: the p10–p90 band drawn behind the
 * named series (§8.2), and the decentralisation metrics on /network.
 *
 * Every function ignores `null` entries — in a per-era column that means the
 * operator was not in the active set, which is not zero and must not be
 * averaged in.
 */

/** Strips nulls and non-finite values, returning a sorted ascending copy. */
function cleanSorted(values: readonly (number | null)[]): number[] {
  const out: number[] = [];
  for (const v of values) {
    if (v != null && Number.isFinite(v)) out.push(v);
  }
  return out.sort((a, b) => a - b);
}

/**
 * Linear-interpolated quantile, matching the R-7 / NumPy default. `q` is in
 * [0,1]. Null rather than NaN for an empty sample, so callers must handle "no
 * data" explicitly instead of rendering NaN into a chart.
 */
export function quantileSorted(sorted: readonly number[], q: number): number | null {
  if (sorted.length === 0) return null;
  if (sorted.length === 1) return sorted[0]!;

  const pos = (sorted.length - 1) * Math.min(1, Math.max(0, q));
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  if (lower === upper) return sorted[lower]!;
  return sorted[lower]! + (pos - lower) * (sorted[upper]! - sorted[lower]!);
}

export function quantile(values: readonly (number | null)[], q: number): number | null {
  return quantileSorted(cleanSorted(values), q);
}

export interface Band {
  p10: number | null;
  p50: number | null;
  p90: number | null;
}

/**
 * The distribution band drawn behind the named series. One pass and one sort,
 * because this runs per era across the whole visible range.
 */
export function distributionBand(values: readonly (number | null)[]): Band {
  const sorted = cleanSorted(values);
  return {
    p10: quantileSorted(sorted, 0.1),
    p50: quantileSorted(sorted, 0.5),
    p90: quantileSorted(sorted, 0.9),
  };
}

export function mean(values: readonly (number | null)[]): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v != null && Number.isFinite(v)) {
      sum += v;
      n += 1;
    }
  }
  return n > 0 ? sum / n : null;
}

/**
 * Median — the typical era rather than the average one, and what the summary
 * columns use instead of `mean`. A validator's first era in the set is exposed
 * on its own bond with no nominators and takes a full share of points, so it
 * pays a multiple of everything after (measured: 2,474% in one era of ninety,
 * dragging a 18–25% operator's mean to 48.59%). That is a different regime, not
 * an outlier, as is the first era after rejoining; the median ignores both
 * without needing to tell them apart.
 */
export function median(values: readonly (number | null)[]): number | null {
  return quantile(values, 0.5);
}

/**
 * Robust spread: the median absolute deviation, scaled to compare with a
 * standard deviation. The partner to `median`, for the same reason — `stdDev`
 * squares every deviation, so one first-era spike reports a steady operator as
 * wildly erratic. The 1.4826 factor makes this an unbiased estimator of σ for
 * normal data, so the two are in the same units.
 */
const MAD_TO_SIGMA = 1.4826;

export function robustSpread(values: readonly (number | null)[]): number | null {
  const clean = cleanSorted(values);
  if (clean.length < 2) return null;

  const centre = quantileSorted(clean, 0.5);
  if (centre == null) return null;

  const deviations = clean.map((v) => Math.abs(v - centre)).sort((a, b) => a - b);
  const mad = quantileSorted(deviations, 0.5);
  return mad == null ? null : mad * MAD_TO_SIGMA;
}

/** Sample standard deviation (n-1). Returns null for fewer than two values. */
export function stdDev(values: readonly (number | null)[]): number | null {
  const clean = cleanSorted(values);
  if (clean.length < 2) return null;
  const m = clean.reduce((a, b) => a + b, 0) / clean.length;
  const variance = clean.reduce((acc, v) => acc + (v - m) ** 2, 0) / (clean.length - 1);
  return Math.sqrt(variance);
}

/**
 * Cumulative percentage deviation from a per-era reference: how far above or
 * below the network an operator ran, accumulated over the window. Answers
 * "consistently better, or one lucky era?", which a per-era chart cannot.
 *
 * Null on either side contributes nothing without breaking the running total,
 * so an operator that leaves the set and returns keeps a continuous line.
 */
export function cumulativeDeviation(
  series: readonly (number | null)[],
  reference: readonly (number | null)[],
): (number | null)[] {
  const out: (number | null)[] = [];
  let running = 0;
  let seenAny = false;

  for (const [i, value] of series.entries()) {
    const ref = reference[i];
    if (value != null && ref != null && Number.isFinite(ref) && ref !== 0) {
      running += (value - ref) / ref;
      seenAny = true;
    }
    out.push(seenAny ? running : null);
  }

  return out;
}

// ---------------------------------------------------------------------------
// Concentration — how decentralised is the stake?
// ---------------------------------------------------------------------------

/**
 * Nakamoto coefficient: the fewest entities whose combined stake exceeds
 * `threshold` of the total — 4 means four operators colluding could reach it.
 * Defaults to one third, the Byzantine-fault bound for halting a chain, rather
 * than the one half needed to control it.
 */
export function nakamotoCoefficient(stakes: readonly number[], threshold = 1 / 3): number {
  const positive = stakes.filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => b - a);
  const total = positive.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;

  let cumulative = 0;
  for (const [i, stake] of positive.entries()) {
    cumulative += stake;
    if (cumulative / total > threshold) return i + 1;
  }
  return positive.length;
}

/**
 * Herfindahl–Hirschman Index on stake shares, normalised to [0,1] — 0 perfectly
 * even, 1 a single operator holding everything. Shown alongside the Nakamoto
 * coefficient because it responds to every share, not just the largest.
 */
export function herfindahlIndex(stakes: readonly number[]): number {
  const positive = stakes.filter((s) => Number.isFinite(s) && s > 0);
  const total = positive.reduce((a, b) => a + b, 0);
  if (total <= 0 || positive.length === 0) return 0;

  const hhi = positive.reduce((acc, s) => acc + (s / total) ** 2, 0);
  const n = positive.length;
  if (n === 1) return 1;

  // Normalise so the floor (perfectly even, 1/n) maps to 0.
  return Math.max(0, (hhi - 1 / n) / (1 - 1 / n));
}

/** Combined share held by the largest `n` entities, as a ratio in [0,1]. */
export function topNShare(stakes: readonly number[], n: number): number {
  const positive = stakes.filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => b - a);
  const total = positive.reduce((a, b) => a + b, 0);
  if (total <= 0) return 0;
  return positive.slice(0, n).reduce((a, b) => a + b, 0) / total;
}

/**
 * Lorenz curve points for a stake distribution: cumulative population share
 * against cumulative stake share, ascending. Always starts at (0,0). Plotted
 * against the diagonal, the gap between the two is the inequality.
 */
export function lorenzCurve(stakes: readonly number[]): { x: number; y: number }[] {
  const positive = stakes.filter((s) => Number.isFinite(s) && s > 0).sort((a, b) => a - b);
  const total = positive.reduce((a, b) => a + b, 0);
  if (total <= 0 || positive.length === 0) return [{ x: 0, y: 0 }];

  const points = [{ x: 0, y: 0 }];
  let cumulative = 0;
  for (const [i, stake] of positive.entries()) {
    cumulative += stake;
    points.push({ x: (i + 1) / positive.length, y: cumulative / total });
  }
  return points;
}

/**
 * Gini coefficient, derived from the Lorenz curve by trapezoidal integration.
 * 0 is perfect equality, 1 is maximal concentration.
 */
export function giniCoefficient(stakes: readonly number[]): number {
  const curve = lorenzCurve(stakes);
  if (curve.length < 2) return 0;

  let areaUnder = 0;
  for (let i = 1; i < curve.length; i += 1) {
    const prev = curve[i - 1]!;
    const cur = curve[i]!;
    areaUnder += ((cur.x - prev.x) * (cur.y + prev.y)) / 2;
  }
  // Area between the diagonal (0.5) and the curve, scaled to [0,1].
  return Math.max(0, Math.min(1, (0.5 - areaUnder) / 0.5));
}
