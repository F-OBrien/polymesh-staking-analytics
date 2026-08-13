import type { OperatorSeries } from '@/lib/schemas/data';
import type { NullableNetwork } from './derive';
import { deriveOperatorRewards } from './derive';

/**
 * Where an era's rewards actually went, in POLYX.
 *
 * Everything else on this site is a rate, and rates hide magnitudes: a
 * nominator reading "19.9% after a 10% commission" has no sense of whether the
 * commission is a rounding error or the operator's entire income. Measured on
 * era 1750 it is very nearly the whole of it — across the active set, operators
 * took 32,668 POLYX in commission and earned 12,828 on their own stake, because
 * the median operator has 0.8% of its own exposure at stake. Commission is not
 * a fee on top of a validator's return; for almost every operator on Polymesh
 * it *is* the return.
 *
 * The split follows the chain's own order of operations, which is not the
 * intuitive one. Commission comes off the top of the whole reward, and only
 * what is left is divided by stake — so an operator with its own stake in the
 * pool is paid twice, once as commission and once as a backer.
 *
 *     commission  = gross × commissionRate
 *     rest        = gross − commission
 *     ownStake    = rest × (ownStake ÷ totalStake)
 *     nominators  = rest − ownStake
 *
 * `nominators` is taken as the remainder rather than computed from the
 * nominators' share of stake, so the three parts always sum to `gross` exactly
 * and a stacked bar can never show a gap or an overlap at the top.
 */

export interface RewardSplit {
  /** What the operator earned from block production, before anything is taken. */
  gross: (number | null)[];
  /** Taken off the top, at the operator's commission rate. */
  commission: (number | null)[];
  /** The operator's share of the remainder, earned on its own stake. */
  ownStake: (number | null)[];
  /** The remainder, to everyone else backing them. */
  nominators: (number | null)[];
}

/** What the operator kept in total: commission plus its own stake's share. */
export function operatorKept(split: RewardSplit): (number | null)[] {
  return split.commission.map((commission, i) => {
    const own = split.ownStake[i];
    return commission == null || own == null ? null : commission + own;
  });
}

export function deriveRewardSplit(
  operator: Pick<OperatorSeries, 'points' | 'commission' | 'totalStake' | 'ownStake'>,
  network: NullableNetwork<'validatorReward' | 'totalPoints'>,
): RewardSplit {
  const gross = deriveOperatorRewards(operator, network);

  const commission: (number | null)[] = [];
  const ownStake: (number | null)[] = [];
  const nominators: (number | null)[] = [];

  for (const [i, earned] of gross.entries()) {
    const rate = operator.commission[i];
    const own = operator.ownStake[i];
    const total = operator.totalStake[i];

    if (earned == null || rate == null || own == null || total == null || total <= 0) {
      commission.push(null);
      ownStake.push(null);
      nominators.push(null);
      continue;
    }

    const taken = earned * rate;
    const rest = earned - taken;
    /**
     * Clamped, because the stored ratio can exceed 1 and the maths cannot.
     *
     * In the chain's first weeks validators had no nominators at all, so their
     * own stake *was* the whole exposure — and the two are stored as separate
     * six-decimal figures, which lets rounding put own fractionally above
     * total. Measured across all 103,541 operator-eras it happens 55 times, all
     * in the first chunk, and the worst overshoot is 0.019%.
     *
     * Small, and not harmless: unclamped it makes the nominators' remainder
     * negative, and a negative band in a stacked area is drawn below the one
     * beneath it. The chain never paid a nominator a negative reward, so the
     * ratio is capped rather than the artefact rendered.
     */
    const toOwn = rest * Math.min(1, own / total);

    commission.push(taken);
    ownStake.push(toOwn);
    nominators.push(rest - toOwn);
  }

  return { gross, commission, ownStake, nominators };
}

/**
 * The same split for the whole active set, era by era.
 *
 * Summed from the per-operator split rather than taken from
 * `network.validatorReward` directly, because the three parts depend on each
 * operator's own commission and self-stake and there is no network-level column
 * that carries either. The total does reconcile: measured on era 1750 the parts
 * sum to 338,919 POLYX against a recorded `validatorReward` of 338,919.
 */
export function deriveNetworkRewardSplit(
  operators: Readonly<
    Record<string, Pick<OperatorSeries, 'points' | 'commission' | 'totalStake' | 'ownStake'>>
  >,
  network: NullableNetwork<'validatorReward' | 'totalPoints'>,
  eraCount: number,
): RewardSplit {
  const total: RewardSplit = {
    gross: Array.from({ length: eraCount }, () => null),
    commission: Array.from({ length: eraCount }, () => null),
    ownStake: Array.from({ length: eraCount }, () => null),
    nominators: Array.from({ length: eraCount }, () => null),
  };

  for (const operator of Object.values(operators)) {
    const split = deriveRewardSplit(operator, network);
    for (const key of ['gross', 'commission', 'ownStake', 'nominators'] as const) {
      for (let i = 0; i < eraCount; i += 1) {
        const value = split[key][i];
        if (value == null) continue;
        // Null is "no operator contributed here yet", which is not the same as
        // zero — an era with no data at all must stay blank rather than plot a
        // floor of nothing.
        total[key][i] = (total[key][i] ?? 0) + value;
      }
    }
  }

  return total;
}
