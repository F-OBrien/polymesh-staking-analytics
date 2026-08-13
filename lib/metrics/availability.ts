import { interiorGaps } from '@/lib/charts/geometry';

/**
 * How much of its own history an operator was actually producing for — the
 * charts show *when* it dropped out, this says *how often*.
 *
 * On a permissioned chain the absence rate is a reliability signal rather than
 * a measure of competition: mainnet runs fewer validators than it has slots,
 * with nobody waiting, so an operator outside the active set was chilled or had
 * its node stop, not outbid.
 *
 * Measured over the operator's own record, not the selected range: one that
 * joined three eras ago has not "missed" the preceding year. The window runs
 * from its first era with data to its last — the same interior-only rule the
 * gap marks use, so the tile and the plot cannot disagree. It is still bounded
 * by the range on screen, so `fromEra`/`toEra` come back for the caller to say
 * which.
 */

export interface AbsenceRun {
  fromEra: number;
  toEra: number;
  /** Inclusive length, in eras. */
  eras: number;
}

export interface Availability {
  /** First era of the operator's own record within the range. */
  fromEra: number;
  toEra: number;
  /** `toEra - fromEra + 1`. */
  window: number;
  /** Eras in the window it was in the active set. */
  inSet: number;
  /** Eras in the window it was absent from the active set. */
  missed: number;
  /**
   * Eras it was in the set and earned nothing — an elected validator whose node
   * is down still appears in every column with zero points, leaving no gap in
   * the line and no mark on the chart. Counted separately from `missed`, since
   * elected and silent is a different failure from not being elected.
   */
  blank: number;
  /** `inSet / window`, in [0,1]. */
  rate: number;
  /** Contiguous absences, longest first. */
  runs: AbsenceRun[];
}

export interface AvailabilityInput {
  /** Era axis, contiguous — see `StitchedSeries.eras`. */
  eras: readonly number[];
  /** The operator's points column: null means "not in the set". */
  points: readonly (number | null)[];
}

export function summariseAvailability({ eras, points }: AvailabilityInput): Availability | null {
  const defined = (i: number) => {
    const value = points[i];
    return value != null && Number.isFinite(value);
  };

  let first = 0;
  while (first < points.length && !defined(first)) first += 1;
  let last = points.length - 1;
  while (last >= 0 && !defined(last)) last -= 1;

  // No record at all in this range. Null rather than a zeroed summary — "0
  // eras missed of 0" reads as a clean sheet.
  if (first > last) return null;

  const fromEra = eras[first];
  const toEra = eras[last];
  if (fromEra == null || toEra == null) return null;

  let inSet = 0;
  let blank = 0;
  for (let i = first; i <= last; i += 1) {
    if (!defined(i)) continue;
    inSet += 1;
    if (points[i] === 0) blank += 1;
  }

  const window = last - first + 1;
  const runs = interiorGaps(points)
    .map((run) => ({
      fromEra: eras[run.from] as number,
      toEra: eras[run.to] as number,
      eras: run.to - run.from + 1,
    }))
    .sort((a, b) => b.eras - a.eras || a.fromEra - b.fromEra);

  return {
    fromEra,
    toEra,
    window,
    inSet,
    missed: window - inSet,
    blank,
    rate: window > 0 ? inSet / window : 0,
    runs,
  };
}
