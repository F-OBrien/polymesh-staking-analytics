/**
 * Staking metric derivations. Three conventions hold throughout:
 *
 *  1. Ratios, not percentages — everything in [0,1]. Formatting is the UI's job.
 *  2. Pure functions, so all of it is testable.
 *  3. Exact integer apportionment where the chain uses integer division, so a
 *     per-operator reward matches what was actually paid.
 *
 * Called by both the pipeline and the client, so nothing here may reference
 * chain objects, React, or the DOM.
 */

const MS_PER_YEAR = 365 * 24 * 60 * 60 * 1000;

/** On-chain `Perbill`: a ratio scaled by 1e9. */
const PERBILL = 1_000_000_000;

// ---------------------------------------------------------------------------
// Era timing
// ---------------------------------------------------------------------------

export interface EraTimingConsts {
  /** Target block time in milliseconds. */
  expectedBlockTimeMs: number;
  /** Blocks per epoch (session). */
  epochDurationBlocks: number;
  /** Epochs per era. */
  sessionsPerEra: number;
}

/**
 * Eras per year, derived from chain constants rather than assumed to be 365.
 * On Polymesh mainnet an era is 24 hours so this lands at ~365, but the
 * constants are what the reward maths is defined against and testnets differ.
 */
export function erasPerYear({
  expectedBlockTimeMs,
  epochDurationBlocks,
  sessionsPerEra,
}: EraTimingConsts): number {
  const eraMs = expectedBlockTimeMs * epochDurationBlocks * sessionsPerEra;
  if (eraMs <= 0) throw new RangeError('era duration must be positive');
  return MS_PER_YEAR / eraMs;
}

/** Era duration in milliseconds. */
export function eraDurationMs({
  expectedBlockTimeMs,
  epochDurationBlocks,
  sessionsPerEra,
}: EraTimingConsts): number {
  return expectedBlockTimeMs * epochDurationBlocks * sessionsPerEra;
}

/**
 * Fraction of the active era elapsed, clamped to [0,1]. The client calls this
 * against its own clock using anchors from `latest.json` (§6.6a), so a ticking
 * countdown costs no network traffic.
 */
export function eraProgress(
  eraStartSeconds: number,
  nowSeconds: number,
  consts: EraTimingConsts,
): number {
  const durationSeconds = eraDurationMs(consts) / 1000;
  if (durationSeconds <= 0) return 0;
  return clamp01((nowSeconds - eraStartSeconds) / durationSeconds);
}

// ---------------------------------------------------------------------------
// Commission
// ---------------------------------------------------------------------------

/** Converts an on-chain Perbill commission to a ratio in [0,1]. */
export function perbillToRatio(perbill: number | bigint): number {
  return Number(perbill) / PERBILL;
}

/** The share of a reward left for nominators after commission. */
export function portionAfterCommission(commission: number): number {
  return 1 - commission;
}

// ---------------------------------------------------------------------------
// Rewards
// ---------------------------------------------------------------------------

/**
 * An operator's gross share of the era reward, apportioned by reward points.
 * Integer truncating division, mirroring the chain — floats drift from the
 * amount actually paid, and these are summed across ~1,700 eras. Returns 0 on a
 * stalled era that scored no points.
 */
export function apportionReward(
  eraReward: bigint,
  operatorPoints: bigint,
  totalPoints: bigint,
): bigint {
  if (totalPoints <= 0n) return 0n;
  return (eraReward * operatorPoints) / totalPoints;
}

/**
 * Annualised return for one operator in one era, as a ratio. `net` deducts
 * commission and is what a nominator earns; `gross` reflects node performance
 * rather than the deal on offer. Zeroes when nothing is staked against the
 * operator — an APR on zero stake is undefined, not infinite.
 */
export function operatorApr(params: {
  eraReward: bigint;
  operatorPoints: bigint;
  totalPoints: bigint;
  operatorTotalStake: bigint;
  commission: number;
  erasPerYear: number;
}): { gross: number; net: number } {
  const { eraReward, operatorPoints, totalPoints, operatorTotalStake, commission } = params;
  if (operatorTotalStake <= 0n) return { gross: 0, net: 0 };

  const nodeReward = apportionReward(eraReward, operatorPoints, totalPoints);
  const gross = (Number(nodeReward) / Number(operatorTotalStake)) * params.erasPerYear;

  return { gross, net: gross * portionAfterCommission(commission) };
}

/**
 * Compounds a per-era rate into an annual one. APR treats rewards as withdrawn,
 * APY as re-staked every era; on Polymesh that is a user choice, so both are
 * shown.
 */
export function aprToApy(apr: number, erasPerYear: number): number {
  if (erasPerYear <= 0) return 0;
  return (1 + apr / erasPerYear) ** erasPerYear - 1;
}

// ---------------------------------------------------------------------------
// Network aggregates
// ---------------------------------------------------------------------------

export interface OperatorEraInput {
  address: string;
  points: bigint;
  totalStake: bigint;
  commission: number;
}

/**
 * Points-weighted mean commission for an era. Weighted rather than plain, so a
 * tiny operator charging 100% does not move the average like a large one
 * charging 5%.
 *
 * Normalised over the weight actually accounted for, because an account can
 * score reward points in an era without having a preferences entry.
 */
export function weightedAverageCommission(
  operators: readonly OperatorEraInput[],
  totalPoints: bigint,
): number {
  if (totalPoints <= 0n) return 0;

  let accountedWeight = 0;
  let weighted = 0;

  for (const op of operators) {
    const weight = Number(op.points) / Number(totalPoints);
    accountedWeight += weight;
    weighted += weight * op.commission;
  }

  return accountedWeight > 0 ? weighted / accountedWeight : 0;
}

/**
 * Stake-weighted mean APR after commission across an era. Summed rewards over
 * summed stake, not a mean of per-operator APRs — that would weight a
 * 1,000-POLYX operator like a 5,000,000-POLYX one.
 */
export function networkAverageApr(params: {
  operators: readonly OperatorEraInput[];
  eraReward: bigint;
  totalPoints: bigint;
  erasPerYear: number;
}): number {
  const { operators, eraReward, totalPoints, erasPerYear: epy } = params;

  let stakeSum = 0n;
  let nominatorRewardSum = 0;

  for (const op of operators) {
    if (op.totalStake <= 0n) continue;
    const nodeReward = apportionReward(eraReward, op.points, totalPoints);
    nominatorRewardSum += Number(nodeReward) * portionAfterCommission(op.commission);
    stakeSum += op.totalStake;
  }

  if (stakeSum <= 0n) return 0;
  return (nominatorRewardSum / Number(stakeSum)) * epy;
}

// ---------------------------------------------------------------------------
// Inflation and the reward curve
// ---------------------------------------------------------------------------

/**
 * Polymesh's inflation curve parameters.
 *
 *   Inflation(x) = I0 + (I_ideal - I0) * x / x_ideal                for x <= x_ideal
 *                = I0 + (I_ideal - I0) * 2^((x_ideal - x) / decay)  for x >  x_ideal
 *
 * where x is the fraction of supply staked: below the ideal inflation rises to
 * attract stake, above it decays to discourage over-staking.
 */
export const REWARD_CURVE = {
  /** Inflation at 0% staked. */
  i0: 0.025,
  /** Staking ratio the curve targets. */
  xIdeal: 0.7,
  /** Inflation at the ideal ratio — the curve's maximum. */
  iIdeal: 0.14,
  /** Decay constant above the ideal ratio. */
  decay: 0.05,
} as const;

/** Uncapped annual inflation at a given staking ratio. */
export function curveInflation(stakingRatio: number): number {
  const { i0, xIdeal, iIdeal, decay } = REWARD_CURVE;
  const x = Math.max(0, stakingRatio);
  return x <= xIdeal
    ? i0 + (iIdeal - i0) * (x / xIdeal)
    : i0 + (iIdeal - i0) * 2 ** ((xIdeal - x) / decay);
}

/**
 * Realised inflation and returns at a staking ratio. Polymesh caps annual
 * issuance at `fixedYearlyReward`, so inflation is the lesser of the curve and
 * that cap — and the cap binds in the regime the network is actually in, so
 * reading the curve alone overstates APR.
 */
export function stakingReturns(params: {
  stakingRatio: number;
  totalIssuance: bigint;
  fixedYearlyReward: bigint;
  erasPerYear: number;
}): { inflation: number; apr: number; apy: number } {
  const { stakingRatio, totalIssuance, fixedYearlyReward, erasPerYear: epy } = params;

  if (stakingRatio <= 0 || totalIssuance <= 0n) return { inflation: 0, apr: 0, apy: 0 };

  const maxInflation = Number(fixedYearlyReward) / Number(totalIssuance);
  const inflation = Math.min(curveInflation(stakingRatio), maxInflation);
  const apr = inflation / stakingRatio;

  return { inflation, apr, apy: aprToApy(apr, epy) };
}

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

export function clamp01(value: number): number {
  if (Number.isNaN(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * Base units to POLYX. Call at the boundary where exact balances become chart
 * values, never mid-calculation.
 */
export function toPolyx(baseUnits: bigint, tokenDecimals: number): number {
  const divisor = 10 ** tokenDecimals;
  return Number(baseUnits) / divisor;
}
