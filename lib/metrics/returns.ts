import type { OperatorSeries } from '@/lib/schemas/data';
import type { NullableNetwork } from './derive';
import { pointsPerBlock } from './production';

/**
 * What a nominator actually earned from each operator, and what explains it.
 *
 * `production.ts` answers "who is filling their authorship slots?", which is
 * the largest *single* thing an operator controls but not the whole of what a
 * nominator receives. Two operators producing identically pay differently if
 * one charges more commission, and differently again if one carries more stake
 * — the reward is fixed by points, so extra stake does not grow the pot, it
 * only splits it more ways.
 *
 * Written out, the per-unit return decomposes exactly:
 *
 *     netAPR      points        ⎛              ⎞   averageStake
 *     ──────  =  ─────────── × ⎜ 1 − commission ⎟ × ────────────
 *     refAPR     expected       ⎝              ⎠    totalStake
 *
 *                production        commission          stake
 *
 * where `refAPR` is the gross return per unit staked the field earned over the
 * same eras. Every input is already in the chunk files; nothing here needs new
 * ingestion.
 *
 * **Eras the operator was not elected are excluded, not counted as zero.** This
 * was the other way round for one revision, on the reasoning that a nominator's
 * stake earns nothing in an era its operator sits out. That is wrong on the
 * mechanics: the election distributes a nominator's stake across whichever of
 * *their* nominations were elected, so an operator dropping out moves that
 * stake to the others rather than idling it. Charging the operator for the era
 * counts a loss the nominator did not take. It also compounds — the longer an
 * operator is out, the more eras of someone else's earnings get booked against
 * it, which is how three Elseware nodes came to read 13.6% against a 19.8%
 * field while producing blocks at exactly the expected rate.
 *
 * Elected and scoring nothing is the opposite case and stays in: the stake was
 * committed, the era was theirs, and the zero is theirs. `eras` reports how
 * many eras an operator was actually elected for, so a caller can show how
 * often they are in the set without it distorting the return.
 *
 * **The factors are not equally worth knowing, and the difference is
 * measurable.** Splitting eras 1600–1750 in half and correlating each
 * operator's first-half factor against its second-half value:
 *
 * | factor     | spread across field | persistence |
 * | ---------- | ------------------- | ----------- |
 * | production | ±1.37%              | r = 0.618   |
 * | commission | ±0.82%              | r = 0.997   |
 * | stake      | ±1.83%              | r = 0.288   |
 *
 * So the *largest* contributor to the spread in realised returns is also the
 * one that barely survives contact with the future. Worse than uninformative:
 * regressing each operator's early stake advantage against how that advantage
 * then changed gives **r = −0.973**, near-total mean reversion. An operator is
 * under-staked only until the election rebalances or nominators notice, and a
 * nominator who arrives to collect the advantage is themselves part of what
 * erases it.
 *
 * A chart that ranked operators on realised return alone would therefore sort
 * mostly on the least durable term — the same failure as the mean-return column
 * that once reported a Huobi node at 48.59%, reached by a different route. Both
 * the total and the split are returned so a caller can show which is which, and
 * `durable` exists so a ranking can be built on the factors that persist.
 */

/** One operator's realised return over a range, with its causes. */
export interface ReturnRecord {
  address: string;
  /** Eras in which this operator was in the active set and fully recorded. */
  eras: number;
  /**
   * The field's gross return per unit staked over *this operator's* eras.
   *
   * Per operator rather than one figure for the range, because an operator
   * elected for 58 of 87 eras must be compared against what the field earned in
   * those 58. A single reference would leave the decomposition failing to add
   * up by the amount the network drifted in the eras they missed.
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
   * of stake here captured more of the reward than the field average.
   *
   * Carries the interaction between the factors as well as the stake effect
   * itself, because it is computed as the residual that makes the identity hold
   * exactly over a multi-era range — where a sum of products is not the product
   * of sums. Measured over eras 1664–1750 the interaction is at most 0.31%
   * relative, and it is mostly stake reacting to performance, so the stake term
   * is where it belongs. The alternative — pure factors whose product misses
   * the realised return — would put a visible gap between the waterfall and the
   * number it is supposed to explain.
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
   *
   * Commission and stake are known exactly, so all of the uncertainty enters
   * through points and carries through multiplicatively: the relative error on
   * the return is the relative error on production.
   */
  standardError: number;
  /** Distance from the field median, in standard errors. */
  z: number;
}

/**
 * Each factor's effect on the return, in APR rather than as a ratio.
 *
 * A logarithmic-mean (LMDI) attribution, which is the standard way to split a
 * *multiplicative* identity into terms that *add*. The naive alternative —
 * `refApr × (factor − 1)` for each — leaves a residual that grows with the
 * factors and would have to be either hidden or drawn as an extra mystery bar.
 * These sum to `netApr − referenceApr` exactly.
 */
export interface ReturnContribution {
  production: number;
  /** Always negative: commission is a deduction, and naming it as one is the point. */
  commission: number;
  stake: number;
}

export interface ReturnsSummary {
  records: ReturnRecord[];
  /** Eras the calculation actually covered. */
  eras: number;
  /**
   * Gross return per unit staked across the field, over the whole range.
   *
   * For stating what the field earned. Each record carries its own
   * `referenceApr` over its own eras, which is what its decomposition adds up
   * against.
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
   * Drop operators present for less than this fraction of the range — up to
   * `minEras`, which is the real requirement.
   *
   * An operator that joined for the last three eras of a ninety-era window has
   * an enormous standard error and would dominate both ends of a sorted chart.
   */
  minCoverage?: number;
  /**
   * The absolute floor, and the one that binds on a long range.
   *
   * A fraction alone is the wrong shape of threshold. Half of ninety eras is a
   * reasonable ask; half of 1,750 is 875, and over the chain's whole history
   * that silently dropped **49 of the 86 operators currently running** while
   * keeping long-dead ones that happened to be there at the start — the exact
   * inverse of what a reader picking an operator needs. What actually matters
   * is having enough eras to measure, and that is an absolute count: the
   * authorship lottery's error falls as 1/√blocks and does not care how long
   * the chain has been going.
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

  /**
   * Eras with a usable denominator on every term.
   *
   * `totalStaked` is the sum of the active set's exposure — verified equal to
   * it, to the last decimal, across every chunk from era 512 to 1750 — so the
   * reference needs no per-operator pass.
   */
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
    // Accumulated in *blocks*, era by era: the number of validators sharing the
    // slots changes as the set changes.
    let variance = 0;

    for (const i of usable) {
      const scored = operator.points[i];
      const stake = operator.totalStake[i];
      const commission = operator.commission[i];
      // Null points means "not in the active set" — the ingest writes null, not
      // zero. A missing commission is withheld rather than read as zero, which
      // would overstate what the nominator received.
      if (scored == null || stake == null || stake <= 0 || commission == null) continue;

      /**
       * Eras with no nominator stake are not eras a nominator earned in.
       *
       * A newly elected operator is exposed for its own bond alone until the
       * next election allocates nominations to it, and a full era's blocks
       * divided by a bond is an enormous per-unit return: all three Huobi nodes
       * entered at era 1660 with 50,000–62,360 POLYX, zero nominators, and
       * scored 2,662% annualised. The following era their stake was 6.3M and
       * they returned 20.8%, where they have stayed.
       *
       * Averaged in, that single era added 29 points to a 91-era mean and put
       * them at the top of a chart titled "what a nominator earned" — for a
       * return no nominator could have received, since none was there. The same
       * spike, through a mean, is what once reported a Huobi node at 48.59% in
       * the operator table. It happens in 159 of 103,541 operator-eras.
       */
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
      // Accumulated over the same eras as the operator's own return, so the two
      // are comparable for an operator that was not elected throughout.
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
      // See the note on `stakeAdvantage`.
      stakeAdvantage:
        recordReference > 0 && production > 0 && keep > 0
          ? netApr / (recordReference * production * keep)
          : 1,
      durable: production * keep,
      contribution: { production: 0, commission: 0, stake: 0 },
      // Blocks are the unit the variance is defined in; dividing by expected
      // blocks turns it into a relative error, which then scales the return.
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
 *
 * The logarithmic mean `L(a,b) = (a−b) / (ln a − ln b)` is what makes it exact:
 * each factor's share is `L × ln(factor)`, and those sum to `L × ln(ratio)`,
 * which is `netApr − referenceApr` by the definition of `L`. Degenerate when
 * the two are equal, where `L` is just the value itself.
 */
function attribute(record: ReturnRecord, referenceApr: number): ReturnContribution {
  const { netApr, production, keep, stakeAdvantage } = record;
  if (referenceApr <= 0 || netApr <= 0) {
    return { production: 0, commission: 0, stake: 0 };
  }

  /**
   * The logarithmic mean, which is what makes the split exact — and which is
   * `0/0` when an operator matches the field.
   *
   * Testing `netApr === referenceApr` is not enough of a guard: an operator can
   * land a single float ulp away, where the difference is non-zero but the
   * difference of the logs rounds to zero. That gives `L = Infinity`, and
   * `Infinity × ln(1)` is `NaN` — so the operator most exactly average is the
   * one whose bars disappear. The limit of `L` as the two converge is the value
   * itself, so that is what the near case returns.
   */
  const denominator = Math.log(netApr) - Math.log(referenceApr);
  const L = Math.abs(denominator) < 1e-12 ? netApr : (netApr - referenceApr) / denominator;

  const share = (factor: number) => {
    const value = L * Math.log(factor);
    // A factor of zero — an elected operator that scored nothing all range —
    // takes the log to −Infinity. Report no attribution rather than a bar of
    // infinite length.
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
