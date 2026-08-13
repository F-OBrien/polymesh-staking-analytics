import type { OperatorSeries } from '@/lib/schemas/data';
import type { NullableNetwork } from './derive';

/**
 * Block production measured against what the authorship lottery predicts.
 *
 * A single era's points cannot rank operators: measured on mainnet, the
 * observed spread across the field is no larger than pure chance would produce
 * (era 1674, 90 operators: 8.1% observed against 7.9% predicted). So this
 * accumulates over the whole selected range, where the noise averages down, and
 * reports the ratio to expected alongside its uncertainty — which is what
 * separates "better than expected" from "lucky".
 *
 * The signal that remains is real but small: over eras 1664–1749 the field
 * spreads ±1.38%, of which ±0.85% is the lottery. Over seven eras it is ±0.57%
 * against ±2.90% of noise. Callers are handed the split rather than left to
 * assume any of the spread is meaningful.
 *
 * Expected is uniform, not stake-weighted: slots are drawn per validator, and
 * Polymesh's election equalises exposure anyway (points/stake correlation 0.07).
 * So an era's expected points is its total over the active operator count.
 */

/**
 * Points awarded per authored block, recovered as the GCD of the point totals
 * rather than hardcoded to Substrate's 20 — it is a runtime constant Polymesh
 * could change, and a wrong value scales every standard error by its root.
 *
 * Needs variety in the input: the GCD of a few identical totals is that total,
 * which would report one block each and inflate the error. Real input cannot be
 * that uniform, but since that is a property of the data,
 * `summariseProduction` accepts an override.
 */
export function pointsPerBlock(values: Iterable<number>): number {
  let divisor = 0;
  for (const value of values) {
    if (!Number.isFinite(value) || value <= 0) continue;
    divisor = gcd(divisor, Math.round(value));
  }
  return divisor > 0 ? divisor : 1;
}

function gcd(a: number, b: number): number {
  let x = a;
  let y = b;
  while (y !== 0) {
    [x, y] = [y, x % y];
  }
  return x;
}

export interface ProductionRecord {
  address: string;
  /** Eras in which this operator was in the active set. */
  eras: number;
  /** Points actually earned across those eras. */
  points: number;
  /** Points the authorship lottery predicts over the same eras. */
  expected: number;
  /** `points / expected`. One means exactly as predicted. */
  ratio: number;
  /**
   * One standard error on `ratio`, from the lottery alone. Authorship is a draw
   * of `N` slots among `n` validators, so a block count is Binomial(N, 1/n) —
   * variance `λ(1 − 1/n)`, not Poisson's `λ`.
   */
  standardError: number;
  /** Signed distance from expected, in standard errors. */
  z: number;
}

export interface ProductionSummary {
  records: ProductionRecord[];
  /** Eras the calculation actually covered. */
  eras: number;
  /**
   * Spread of `ratio` across the field, as a standard deviation. Compare
   * against `luckSpread` — if they are equal, the whole chart is noise.
   */
  observedSpread: number;
  /** The spread the lottery alone would produce, as a standard deviation. */
  luckSpread: number;
  /**
   * Dispersion left once the lottery is subtracted, or null when the observed
   * spread does not exceed it — which is the honest answer for a short range.
   */
  excessSpread: number | null;
}

export interface ProductionInput {
  eras: readonly number[];
  network: NullableNetwork<'totalPoints' | 'activeOperators'>;
  operators: Readonly<Record<string, Pick<OperatorSeries, 'points'>>>;
  /**
   * Drop operators present for less than this fraction of the range, capped at
   * `minEras`. An operator elected for three eras of ninety has an enormous
   * standard error and would dominate both ends of a sorted chart.
   */
  minCoverage?: number;
  /**
   * The absolute floor, and the one that binds on a long range. A fraction
   * alone is the wrong shape: half of 1,750 eras drops most operators currently
   * running in favour of long-dead ones that were there at the start. The error
   * falls as 1/√blocks regardless of how long the chain has run, so the
   * requirement is a count of eras, not a share of them.
   */
  minEras?: number;
  /** Overrides the GCD-derived award per block. See `pointsPerBlock`. */
  awardPerBlock?: number;
}

const DEFAULT_MIN_COVERAGE = 0.5;

/** About six weeks — enough blocks for the lottery's error to settle. */
const DEFAULT_MIN_ERAS = 30;

export function summariseProduction({
  eras,
  network,
  operators,
  minCoverage = DEFAULT_MIN_COVERAGE,
  minEras = DEFAULT_MIN_ERAS,
  awardPerBlock,
}: ProductionInput): ProductionSummary {
  const empty: ProductionSummary = {
    records: [],
    eras: 0,
    observedSpread: 0,
    luckSpread: 0,
    excessSpread: null,
  };
  if (eras.length === 0) return empty;

  const perBlock =
    awardPerBlock ??
    pointsPerBlock(
      Object.values(operators).flatMap((operator) =>
        operator.points.filter((p): p is number => p != null),
      ),
    );

  // Eras with a usable denominator. A chunk still being written can carry an
  // era whose totals have not landed.
  const usable: number[] = [];
  for (let i = 0; i < eras.length; i += 1) {
    const total = network.totalPoints[i];
    const active = network.activeOperators[i];
    if (total != null && total > 0 && active != null && active > 0) usable.push(i);
  }
  if (usable.length === 0) return empty;

  const records: ProductionRecord[] = [];

  for (const [address, operator] of Object.entries(operators)) {
    let points = 0;
    let expected = 0;
    let count = 0;
    // In blocks, era by era: the number of validators sharing the slots
    // changes as the set changes.
    let variance = 0;

    for (const i of usable) {
      const scored = operator.points[i];
      // Null is "not in the active set that era" — the ingest writes null, not
      // zero. A genuine zero is an elected operator that produced nothing,
      // which counts.
      if (scored == null) continue;

      const active = network.activeOperators[i] as number;
      const eraExpected = (network.totalPoints[i] as number) / active;

      points += scored;
      expected += eraExpected;
      count += 1;
      variance += (eraExpected / perBlock) * (1 - 1 / active);
    }

    // The fraction for a short range, the absolute floor for a long one.
    if (count < Math.min(usable.length * minCoverage, minEras) || expected <= 0) continue;

    const expectedBlocks = expected / perBlock;
    records.push({
      address,
      eras: count,
      points,
      expected,
      ratio: points / expected,
      // Variance is in blocks; dividing by expected blocks makes it a relative
      // error on the ratio.
      standardError: Math.sqrt(variance) / expectedBlocks,
      z: 0,
    });
  }

  for (const record of records) {
    record.z = record.standardError > 0 ? (record.ratio - 1) / record.standardError : 0;
  }

  records.sort((a, b) => b.ratio - a.ratio);

  const observedSpread = standardDeviation(records.map((r) => r.ratio));
  const luckSpread = rootMeanSquare(records.map((r) => r.standardError));

  return {
    records,
    eras: usable.length,
    observedSpread,
    luckSpread,
    // Variances subtract, standard deviations do not.
    excessSpread:
      observedSpread > luckSpread
        ? Math.sqrt(observedSpread * observedSpread - luckSpread * luckSpread)
        : null,
  };
}

function standardDeviation(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return Math.sqrt(values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length);
}

function rootMeanSquare(values: readonly number[]): number {
  if (values.length === 0) return 0;
  return Math.sqrt(values.reduce((a, b) => a + b * b, 0) / values.length);
}
