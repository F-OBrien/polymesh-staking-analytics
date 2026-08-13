import type { RewardSplit } from '@/lib/metrics/rewards';
import type { NetworkSeries, Rollup } from '@/lib/schemas/data';
import type { StitchedSeries } from './series';

/**
 * The weekly rollup, in the shape the charts already take. One file of a few
 * tens of kilobytes stands in for dozens of chunks over the chain's whole life.
 *
 * A shape change, not a computation: everything is already aggregated by
 * `scripts/ingest/rollup.ts` from the chunks on disk, so a weekly chart and a
 * daily one over the same span are the same numbers at two resolutions.
 *
 * Network only. The rollup has no per-operator columns and should not — the
 * point is to answer "what has the network done over five years" without
 * loading a hundred operators across every era. Operator comparison stays on
 * the chunks, and the range control caps it accordingly.
 */

/** Weeks, not eras — the caller must label the axis accordingly. */
export interface RollupSeries extends StitchedSeries {
  /** Always `week` here. Charts state resolution rather than implying it. */
  resolution: 'week';
  /**
   * How each week's reward was divided, carried rather than derived. The one
   * exception to "network only": it is the composition of a network total
   * rather than a per-operator series, and three numbers a week against the
   * whole operator set that deriving it would cost.
   */
  rewardSplit: RewardSplit;
}

/**
 * Buckets whose era span overlaps `[fromEra, toEra]`, as a `StitchedSeries`.
 *
 * Returns null when the rollup is absent or the range selects nothing, so a
 * caller falls back to chunks rather than drawing an empty chart.
 */
export function rollupToSeries(
  rollup: Rollup | undefined,
  range: { fromEra: number; toEra: number } | null | undefined,
): RollupSeries | null {
  if (!rollup || !range) return null;

  const keep: number[] = [];
  for (let i = 0; i < rollup.eraFrom.length; i += 1) {
    const from = rollup.eraFrom[i] as number;
    const to = rollup.eraTo[i] as number;
    // Overlap, not containment: the range's endpoints rarely align with week
    // boundaries, and dropping a partly-covered bucket lops a week off each
    // end of every chart.
    if (to >= range.fromEra && from <= range.toEra) keep.push(i);
  }
  if (keep.length === 0) return null;

  const pick = (column: readonly number[]): number[] => keep.map((i) => column[i] as number);

  const network: NetworkSeries = {
    totalStaked: pick(rollup.totalStaked),
    totalIssuance: pick(rollup.totalIssuance),
    validatorReward: pick(rollup.validatorReward),
    totalPoints: pick(rollup.totalPoints),
    activeOperators: pick(rollup.activeOperators),
    nominatorCount: pick(rollup.nominatorCount),
    avgCommission: pick(rollup.avgCommission),
    avgApr: pick(rollup.avgApr),
    aprP10: pick(rollup.aprP10),
    aprP50: pick(rollup.aprP50),
    aprP90: pick(rollup.aprP90),
  };

  return {
    // The bucket's *last* era identifies it, matching how a weekly figure is
    // normally dated — the week ending on that era.
    eras: keep.map((i) => rollup.eraTo[i] as number),
    eraStart: keep.map((i) => rollup.weekStart[i] as number),
    network,
    // Deliberately empty: no per-operator data exists here, and fabricating it
    // from the network average would be a chart of nothing.
    operators: {},
    resolution: 'week',
    rewardSplit: {
      gross: pick(rollup.validatorReward),
      commission: pick(rollup.commissionPaid),
      ownStake: pick(rollup.selfStakePaid),
      // The remainder, so the parts sum to the reward exactly — the same rule
      // the per-era derivation follows.
      nominators: keep.map(
        (i) =>
          (rollup.validatorReward[i] as number) -
          (rollup.commissionPaid[i] as number) -
          (rollup.selfStakePaid[i] as number),
      ),
    },
  };
}

/**
 * Above this many eras, a range is served from the rollup. A year is the
 * longest range that stays inside the chunk budget (~12 chunks); beyond it the
 * chunk count grows without bound while the questions get coarser.
 */
export const WEEKLY_ABOVE_ERAS = 365;

/** Whether a range should be drawn from the rollup rather than the chunks. */
export function prefersRollup(
  range: { fromEra: number; toEra: number } | null | undefined,
): boolean {
  if (!range) return false;
  return range.toEra - range.fromEra + 1 > WEEKLY_ABOVE_ERAS;
}
