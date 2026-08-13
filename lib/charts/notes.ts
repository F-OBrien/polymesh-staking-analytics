/**
 * Coverage notes that keep a truncated axis honest.
 *
 * Several network series barely move as a fraction of their magnitude — reward
 * points vary by under 1% of their maximum — so a zero-based axis draws a flat
 * line and hides the only thing the chart is for. Scaling to the data fixes
 * that and introduces the opposite hazard, a small wobble looking like a
 * crisis, so these state the real range in words.
 *
 * Bars are exempt and must stay zero-based: a bar encodes value as area, so
 * cutting the axis rescales the comparison itself rather than just the view.
 */

/**
 * "Between X and Y over this range — the axis is scaled to that, not to zero."
 * Null when there is nothing worth saying: no data, or a series that never
 * moves, where the note would confuse more than the flat line it describes.
 */
export function axisRangeNote(
  values: readonly (number | null | undefined)[],
  format: (value: number) => string,
): string | null {
  let lo = Number.POSITIVE_INFINITY;
  let hi = Number.NEGATIVE_INFINITY;

  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    if (value < lo) lo = value;
    if (value > hi) hi = value;
  }

  if (!Number.isFinite(lo) || lo === hi) return null;

  // Terse on purpose: this sits in a one-line coverage strip beside the
  // frame's controls, and a longer sentence wraps the header and shifts the
  // buttons down the card.
  return `Axis spans ${format(lo)}–${format(hi)}, not zero.`;
}

/**
 * A y-axis ceiling that a handful of extreme points cannot own, plus the note
 * that must accompany it. The case it exists for is a series whose bootstrap
 * era pays orders of magnitude more than everything since, which otherwise
 * flattens the rest of the chart onto the floor.
 *
 * Capping is only honest if the reader is told, so the note comes back with the
 * cap and the caller must render both. Clipped points keep their real values in
 * the table view; nothing is dropped.
 *
 * Null when no cap is warranted, which is the normal case.
 */
export function outlierCap(
  values: readonly (number | null | undefined)[],
  format: (value: number) => string,
  {
    /** How many times the median a point may reach before it is an outlier. */
    tolerance = 4,
    /**
     * Why the outliers are there, as a clause following "peaking at X".
     * Caller-supplied because the reason differs by chart — the chain's first
     * weeks on a network chart, a validator's own first era on an operator
     * page — and a wrong reason is worse than none.
     */
    because = '',
  }: { tolerance?: number; because?: string } = {},
): { max: number; note: string } | null {
  const finite = values.filter((v): v is number => v != null && Number.isFinite(v));
  if (finite.length < 4) return null;

  const sorted = [...finite].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)] as number;
  if (median <= 0) return null;

  const limit = median * tolerance;
  const above = finite.filter((v) => v > limit);
  // Only worth capping for a genuine few: if a fifth of the series is above
  // the line, that is the shape of the data.
  if (above.length === 0 || above.length > finite.length * 0.05) return null;

  // The cap sits just above the highest point that is *not* an outlier, so the
  // legitimate range fills the plot.
  const highestKept = Math.max(...finite.filter((v) => v <= limit));
  const max = highestKept * 1.05;
  const peak = Math.max(...above);

  return {
    max,
    // One clause, for the same reason as `axisRangeNote`.
    note: `${above.length} above ${format(max)} clipped, peaking at ${format(peak)} ${because}.`,
  };
}
