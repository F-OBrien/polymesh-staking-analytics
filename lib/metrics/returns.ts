import type { OperatorSeries } from '@/lib/schemas/data';
import type { NullableNetwork } from './derive';
import { pointsPerBlock } from './production';

/**
 * What a nominator actually earned from each operator, and what explains it.
 * Where `production.ts` covers only block authorship, this adds the other two
 * things that move a nominator's return — commission, and how many ways the
 * (points-fixed, stake-independent) reward gets split.
 *
 * The per-unit return decomposes exactly:
 *
 *     netAPR      points        ⎛              ⎞   averageStake
 *     ──────  =  ─────────── × ⎜ 1 − commission ⎟ × ────────────
 *     refAPR     expected       ⎝              ⎠    totalStake
 *
 *                production        commission          stake
 *
 * where `refAPR` is the gross return per unit staked the field earned over the
 * same eras. Every input is already in the chunk files.
 *
 * Eras the operator was not elected are excluded, not counted as zero: the
 * election moves a nominator's stake to their other nominations rather than
 * idling it, so charging the operator books a loss the nominator never took.
 * Elected and scoring nothing stays in — that zero is theirs. `eras` reports
 * how often an operator was elected, so a caller can show it separately.
 *
 * The factors differ sharply in how well they persist (measured over eras
 * 1600–1750, first half against second): commission r = 0.997, production
 * r = 0.618, stake r = 0.288 with near-total mean reversion. So a ranking on
 * realised return alone sorts mostly on the least durable term; `durable`
 * exists so a ranking can be built on the factors that hold.
 */

/** One operator's realised return over a range, with its causes. */
export interface ReturnRecord {
  address: string;
  /** Eras in which this operator was in the active set and fully recorded. */
  eras: number;
  /**
   * The field's gross return per unit staked over *this operator's* eras. Per
   * operator, not one figure for the range: otherwise the decomposition fails
   * to add up by however much the network drifted in the eras they missed.
   */
  referenceApr: number;
  /** Realised return per unit staked, after commission, annualised. */
  netApr: number;
  /** The same before commission — node performance, not the deal on offer. */
  grossApr: number;
  /** Points earned against points the authorship lottery predicts. */
  production: number;
  /** Mean share of the reward left after commission, `1 − commission`. */
  keep: number;
  /**
   * Field-average stake divided by this operator's, so above 1 means each unit
   * of stake captured more of the reward than the field average.
   *
   * Computed as the residual that makes the identity hold exactly over a
   * multi-era range, so it also carries the inter-factor interaction (measured
   * at most 0.31% relative, and mostly stake reacting to performance). Pure
   * factors would instead leave a gap between the waterfall and the return it
   * is meant to explain.
   */
  stakeAdvantage: number;
  /**
   * `production × keep`: the part of the return that was still there a
   * half-range later. What a ranking should be built on.
   */
  durable: number;
  /** Additive attribution, in APR, summing exactly to `netApr − referenceApr`. */
  contribution: ReturnContribution;
  /**
   * One standard error on `netApr`, in APR, from the authorship lottery.
   * Commission and stake are known exactly, so all uncertainty enters through
   * points: the relative error on the return is the relative error on
   * production.
   */
  standardError: number;
  /** Distance from the field median, in standard errors. */
  z: number;
}

/**
 * Each factor's effect on the return, in APR rather than as a ratio. A
 * logarithmic-mean (LMDI) attribution, the standard way to split a
 * multiplicative identity into terms that add; these sum to
 * `netApr − referenceApr` exactly, where `refApr × (factor − 1)` would leave a
 * residual needing its own mystery bar.
 */
export interface ReturnContribution {
  production: number;
  /** Always negative — commission is a deduction. */
  commission: number;
  stake: number;
}

export interface ReturnsSummary {
  records: ReturnRecord[];
  /** Eras the calculation actually covered. */
  eras: number;
  /**
   * Gross return per unit staked across the field, over the whole range — for
   * stating what the field earned. A record's decomposition adds up against its
   * own `referenceApr`, not this.
   */
  referenceApr: number;
  /** Median realised net return. The deviation chart's baseline. */
  medianNetApr: number;
  /** Spread of realised net return across the field, as a standard deviation. */
  observedSpread: number;
  /** The spread the authorship lottery alone would produce. */
  luckSpread: number;
  /** Dispersion left once the lottery is subtracted; null when it does not exceed it. */
  excessSpread: number | null;
}

export interface ReturnsInput {
  eras: readonly number[];
  network: NullableNetwork<'validatorReward' | 'totalPoints' | 'activeOperators' | 'totalStaked'>;
  operators: Readonly<
    Record<string, Pick<OperatorSeries, 'points' | 'commission' | 'totalStake' | 'ownStake'>>
  >;
  erasPerYear: number;
  /**
   * Drop operators present for less than this fraction of the range, capped at
   * `minEras`. An operator elected for three eras of ninety has an enormous
   * standard error and would dominate both ends of a sorted chart.
   */
  minCoverage?: number;
  /**
   * The absolute floor, and the one that binds on a long range. A fraction
   * alone is the wrong shape: half of 1,750 eras drops most operators currently
   * running in favour of long-dead ones that were there at the start. What
   * matters is enough eras to measure, and the lottery's error falls as
   * 1/√blocks regardless of how long the chain has run.
   */
  minEras?: number;
  /** Overrides the GCD-derived award per block. See `pointsPerBlock`. */
  awardPerBlock?: number;
}

const DEFAULT_MIN_COVERAGE = 0.5;

/** About six weeks — enough blocks for the lottery's error to settle. */
const DEFAULT_MIN_ERAS = 30;

const EMPTY: ReturnsSummary = {
  records: [],
  eras: 0,
  referenceApr: 0,
  medianNetApr: 0,
  observedSpread: 0,
  luckSpread: 0,
  excessSpread: null,
};

export function summariseReturns({
  eras,
  network,
  operators,
  erasPerYear,
  minCoverage = DEFAULT_MIN_COVERAGE,
  minEras = DEFAULT_MIN_ERAS,
  awardPerBlock,
}: ReturnsInput): ReturnsSummary {
  if (eras.length === 0 || !Number.isFinite(erasPerYear) || erasPerYear <= 0) return EMPTY;

  const perBlock =
    awardPerBlock ??
    pointsPerBlock(
      Object.values(operators).flatMap((operator) =>
        operator.points.filter((p): p is number => p != null),
      ),
    );

  // Eras with a usable denominator on every term. `totalStaked` equals the
  // active set's exposure (verified across every chunk from era 512 to 1750),
  // so the reference needs no per-operator pass.
  const usable: number[] = [];
  for (let i = 0; i < eras.length; i += 1) {
    const reward = network.validatorReward[i];
    const points = network.totalPoints[i];
    const active = network.activeOperators[i];
    const staked = network.totalStaked[i];
    if (
      reward != null &&
      points != null &&
      points > 0 &&
      active != null &&
      active > 0 &&
      staked != null &&
      staked > 0
    ) {
      usable.push(i);
    }
  }
  if (usable.length === 0) return EMPTY;

  const records: ReturnRecord[] = [];

  for (const [address, operator] of Object.entries(operators)) {
    let points = 0;
    let expectedPoints = 0;
    let netPerUnit = 0;
    let grossPerUnit = 0;
    let keepSum = 0;
    let refPerUnit = 0;
    let count = 0;
    // In blocks, era by era: the number of validators sharing the slots
    // changes as the set changes.
    let variance = 0;

    for (const i of usable) {
      const scored = operator.points[i];
      const stake = operator.totalStake[i];
      const commission = operator.commission[i];
      // Null points means "not in the active set" — the ingest writes null, not
      // zero. Missing commission is withheld rather than read as zero, which
      // would overstate what the nominator received.
      if (scored == null || stake == null || stake <= 0 || commission == null) continue;

      // Eras with no nominator stake are not eras a nominator earned in. A
      // newly elected operator is exposed for its own bond alone until the next
      // election, and a full era's blocks over a bare bond is an enormous
      // per-unit return (measured: 2,662% annualised, 20.8% the era after).
      const own = operator.ownStake[i];
      if (own != null && own >= stake) continue;

      const reward = network.validatorReward[i] as number;
      const totalPoints = network.totalPoints[i] as number;
      const active = network.activeOperators[i] as number;
      const staked = network.totalStaked[i] as number;

      const eraExpected = totalPoints / active;
      const earned = (reward * scored) / totalPoints;

      points += scored;
      expectedPoints += eraExpected;
      grossPerUnit += earned / stake;
      netPerUnit += (earned * (1 - commission)) / stake;
      // Over the same eras as the operator's own return, so the two stay
      // comparable for an operator not elected throughout.
      refPerUnit += reward / staked;
      keepSum += 1 - commission;
      count += 1;
      variance += (eraExpected / perBlock) * (1 - 1 / active);
    }

    // The fraction for a short range, the absolute floor for a long one.
    const required = Math.min(usable.length * minCoverage, minEras);
    if (count < required || expectedPoints <= 0 || refPerUnit <= 0) continue;

    const netApr = (netPerUnit / count) * erasPerYear;
    const recordReference = (refPerUnit / count) * erasPerYear;
    const production = points / expectedPoints;
    const keep = keepSum / count;

    records.push({
      address,
      eras: count,
      referenceApr: recordReference,
      netApr,
      grossApr: (grossPerUnit / count) * erasPerYear,
      production,
      keep,
      // The residual, so the factors reproduce the realised return exactly.
      stakeAdvantage:
        recordReference > 0 && production > 0 && keep > 0
          ? netApr / (recordReference * production * keep)
          : 1,
      durable: production * keep,
      contribution: { production: 0, commission: 0, stake: 0 },
      // Variance is in blocks; dividing by expected blocks makes it a relative
      // error, which then scales the return.
      standardError: (Math.sqrt(variance) / (expectedPoints / perBlock)) * netApr,
      z: 0,
    });
  }

  const referenceApr = averageReference(network, usable, erasPerYear);
  if (records.length === 0) return { ...EMPTY, eras: usable.length, referenceApr };

  const medianNetApr = medianOf(records.map((r) => r.netApr));

  for (const record of records) {
    record.contribution = attribute(record, record.referenceApr);
    record.z = record.standardError > 0 ? (record.netApr - medianNetApr) / record.standardError : 0;
  }

  records.sort((a, b) => b.netApr - a.netApr);

  const observedSpread = standardDeviation(records.map((r) => r.netApr));
  const luckSpread = rootMeanSquare(records.map((r) => r.standardError));

  return {
    records,
    eras: usable.length,
    referenceApr,
    medianNetApr,
    observedSpread,
    luckSpread,
    // Variances subtract; standard deviations do not.
    excessSpread:
      observedSpread > luckSpread
        ? Math.sqrt(observedSpread * observedSpread - luckSpread * luckSpread)
        : null,
  };
}

function averageReference(
  network: ReturnsInput['network'],
  usable: readonly number[],
  erasPerYear: number,
): number {
  let sum = 0;
  for (const i of usable) {
    sum += (network.validatorReward[i] as number) / (network.totalStaked[i] as number);
  }
  return (sum / usable.length) * erasPerYear;
}

/**
 * Splits `netApr − referenceApr` across the three factors so the parts add up.
 * The logarithmic mean `L(a,b) = (a−b) / (ln a − ln b)` makes it exact: each
 * share is `L × ln(factor)`, and those sum to `L × ln(ratio)`.
 */
function attribute(record: ReturnRecord, referenceApr: number): ReturnContribution {
  const { netApr, production, keep, stakeAdvantage } = record;
  if (referenceApr <= 0 || netApr <= 0) {
    return { production: 0, commission: 0, stake: 0 };
  }

  // `L` is 0/0 when an operator matches the field, and testing equality is not
  // enough of a guard: a difference of one float ulp still takes the log
  // difference to zero, giving `Infinity × ln(1)` = NaN. The limit of `L` as
  // the two converge is the value itself.
  const denominator = Math.log(netApr) - Math.log(referenceApr);
  const L = Math.abs(denominator) < 1e-12 ? netApr : (netApr - referenceApr) / denominator;

  const share = (factor: number) => {
    const value = L * Math.log(factor);
    // A factor of zero (elected, scored nothing all range) takes the log to
    // −Infinity. No attribution beats a bar of infinite length.
    return Number.isFinite(value) ? value : 0;
  };

  return {
    production: share(production),
    commission: share(keep),
    stake: share(stakeAdvantage),
  };
}

function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2
    : (sorted[mid] as number);
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
