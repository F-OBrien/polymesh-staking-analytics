import type { Chunk, NetworkSeries, OperatorSeries } from '@/lib/schemas/data';

/**
 * Network columns as a stitched range supplies them. A stored chunk always has
 * a value for every era it lists, but a stitched range can span an era no chunk
 * covers, which must carry null rather than be dropped — see
 * `StitchedSeries.eras`.
 */
export type NullableNetwork<K extends keyof NetworkSeries> = {
  [P in K]: readonly (number | null)[];
};
import { aprToApy, apportionReward, portionAfterCommission } from './staking';

/**
 * Derivations over chunk data. Chunks store chain facts only (see
 * `OperatorSeriesSchema`); everything a chart plots — reward, APR gross and net
 * — is computed here, so the pipeline's aggregates and the client's series
 * share one definition of each formula.
 *
 * All pure, index-aligned, and null wherever the inputs are absent, so a result
 * can go straight to a chart without checking for gaps.
 */

/** Balances arrive as POLYX; scaling to integers keeps apportionment exact. */
const REWARD_SCALE = 1_000_000n;

function toScaledBigInt(polyx: number): bigint {
  return BigInt(Math.round(polyx * Number(REWARD_SCALE)));
}

/**
 * An operator's gross reward per era, in POLYX. Apportioned with the same
 * truncating integer division the chain uses, so a total summed across many
 * eras matches what was paid rather than accumulating drift.
 */
export function deriveOperatorRewards(
  operator: Pick<OperatorSeries, 'points'>,
  network: NullableNetwork<'validatorReward' | 'totalPoints'>,
): (number | null)[] {
  return operator.points.map((points, i) => {
    const eraReward = network.validatorReward[i];
    const totalPoints = network.totalPoints[i];
    if (points == null || eraReward == null || totalPoints == null || totalPoints <= 0) {
      return null;
    }
    const scaled = apportionReward(
      toScaledBigInt(eraReward),
      BigInt(Math.round(points)),
      BigInt(Math.round(totalPoints)),
    );
    return Number(scaled) / Number(REWARD_SCALE);
  });
}

export interface DerivedApr {
  /** Before commission — reflects node performance, not the deal on offer. */
  gross: (number | null)[];
  /** After commission — what a nominator actually earns. */
  net: (number | null)[];
}

/** Annualised return per era for one operator, as ratios. */
export function deriveOperatorApr(
  operator: OperatorSeries,
  network: NullableNetwork<'validatorReward' | 'totalPoints'>,
  erasPerYear: number,
): DerivedApr {
  const rewards = deriveOperatorRewards(operator, network);

  const gross: (number | null)[] = [];
  const net: (number | null)[] = [];

  for (const [i, reward] of rewards.entries()) {
    const stake = operator.totalStake[i];
    const commission = operator.commission[i];

    if (reward == null || stake == null || stake <= 0) {
      gross.push(null);
      net.push(null);
      continue;
    }

    const g = (reward / stake) * erasPerYear;
    gross.push(g);
    // Missing commission means points scored without a preferences record for
    // that era. Withheld rather than zeroed, which would overstate the return.
    net.push(commission == null ? null : g * portionAfterCommission(commission));
  }

  return { gross, net };
}

/** A single return figure on both commission bases. */
export interface AprPoint {
  /** Before commission — node performance, not the deal on offer. */
  gross: number | null;
  /** After commission — what a nominator actually earns. */
  net: number | null;
}

export const NO_APR: AprPoint = { gross: null, net: null };

export interface EraEstimateInput {
  /** Points this operator has scored so far in the era now running. */
  points: number | null;
  /** Points scored so far this era across every operator. */
  totalPoints: number | null;
  /** This operator's total exposure this era, in POLYX. */
  totalStake: number | null;
  /** 0–1, or null when the preferences record is missing. */
  commission: number | null;
  /** Annual inflation as a ratio, from the reward curve. */
  inflation: number;
  /** Total issuance, in POLYX. */
  totalIssuance: number;
}

/**
 * Forward-looking return for the era now in progress — every other return
 * figure on the site looks backwards.
 *
 * Works because a *share* of points is meaningful long before the era ends:
 * points accrue roughly uniformly, so an operator holding 1.2% of them at hour
 * six likely holds about 1.2% at hour twenty-four. The absolute count is
 * useless mid-era; the ratio is not.
 *
 *     era pot  = inflation × issuance ÷ erasPerYear
 *     share    = points ÷ totalPoints
 *     gross    = (pot × share ÷ stake) × erasPerYear
 *              = inflation × issuance × points ÷ (totalPoints × stake)
 *
 * `erasPerYear` cancels, so the estimate does not depend on the era length. It
 * reconciles with `stakingReturns`: equal shares of points and stake return
 * `inflation ÷ ratio`, the network APR, exactly.
 *
 * Nulls rather than zero when the era has produced no points yet — zero reads
 * as "earning nothing" rather than "the era just started".
 */
export function deriveEstimatedEraApr({
  points,
  totalPoints,
  totalStake,
  commission,
  inflation,
  totalIssuance,
}: EraEstimateInput): AprPoint {
  if (
    points == null ||
    totalPoints == null ||
    totalPoints <= 0 ||
    totalStake == null ||
    totalStake <= 0 ||
    !Number.isFinite(inflation) ||
    totalIssuance <= 0
  ) {
    return NO_APR;
  }

  const gross = (inflation * totalIssuance * points) / (totalPoints * totalStake);

  // Missing commission withheld, not zeroed — as in `deriveOperatorApr`.
  return { gross, net: commission == null ? null : gross * portionAfterCommission(commission) };
}

/** The most recent non-null entry of a series, with the index it sits at. */
export function lastDefinedAt(
  values: readonly (number | null)[],
): { value: number; index: number } | null {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (value != null && Number.isFinite(value)) return { value, index: i };
  }
  return null;
}

/** Compounds a derived APR series into APY, preserving gaps. */
export function deriveApy(apr: readonly (number | null)[], erasPerYear: number): (number | null)[] {
  return apr.map((value) => (value == null ? null : aprToApy(value, erasPerYear)));
}

/** Self-stake as a share of total stake — a proxy for skin in the game. */
export function deriveSelfStakeRatio(operator: OperatorSeries): (number | null)[] {
  return operator.ownStake.map((own, i) => {
    const total = operator.totalStake[i];
    if (own == null || total == null || total <= 0) return null;
    return own / total;
  });
}

/**
 * Share of the era's reward points. The comparable measure of block production
 * — raw points depend on how many operators were active that era.
 */
export function derivePointsShare(
  operator: Pick<OperatorSeries, 'points'>,
  network: NullableNetwork<'totalPoints'>,
): (number | null)[] {
  return operator.points.map((points, i) => {
    const total = network.totalPoints[i];
    if (points == null || total == null || total <= 0) return null;
    return points / total;
  });
}

/**
 * Every derived series for one operator in one chunk. Null when the operator
 * has no columns there — normal for one that joined later.
 */
export function deriveOperatorSeries(chunk: Chunk, address: string, erasPerYear: number) {
  const operator = chunk.operators[address];
  if (!operator) return null;

  const apr = deriveOperatorApr(operator, chunk.network, erasPerYear);

  return {
    eras: chunk.eras,
    reward: deriveOperatorRewards(operator, chunk.network),
    aprGross: apr.gross,
    aprNet: apr.net,
    pointsShare: derivePointsShare(operator, chunk.network),
    selfStakeRatio: deriveSelfStakeRatio(operator),
  };
}
