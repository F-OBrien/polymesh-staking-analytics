import type { OperatorSeries } from '@/lib/schemas/data';
import type { NullableNetwork } from './derive';
import { deriveOperatorRewards } from './derive';

/**
 * Where an era's rewards actually went, in POLYX — the magnitude behind the
 * rates shown everywhere else. Measured on mainnet, commission is not a fee on
 * top of a validator's return but very nearly the whole of it: the median
 * operator has under 1% of its own exposure at stake.
 *
 * The split follows the chain's order of operations, which is not the intuitive
 * one — commission comes off the top and only the remainder is divided by
 * stake, so an operator with its own stake in the pool is paid twice:
 *
 *     commission  = gross × commissionRate
 *     rest        = gross − commission
 *     ownStake    = rest × (ownStake ÷ totalStake)
 *     nominators  = rest − ownStake
 *
 * `nominators` is the remainder rather than a share of stake, so the three
 * parts sum to `gross` exactly and a stacked bar can never gap or overlap.
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
     * Clamped, because the stored ratio can exceed 1 where an operator's own
     * stake was the whole exposure: own and total are separate six-decimal
     * figures, so rounding can put own fractionally above total. Unclamped that
     * makes the nominators' remainder negative, which a stacked area draws
     * below the band beneath it.
     */
    const toOwn = rest * Math.min(1, own / total);

    commission.push(taken);
    ownStake.push(toOwn);
    nominators.push(rest - toOwn);
  }

  return { gross, commission, ownStake, nominators };
}

/**
 * The same split for the whole active set, era by era. Summed from the
 * per-operator split rather than `network.validatorReward`, since the parts
 * depend on each operator's own commission and self-stake and no network-level
 * column carries either. Verified to reconcile against the recorded total.
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
        // Null is "no operator contributed here", not zero — an era with no
        // data must stay blank rather than plot a floor of nothing.
        total[key][i] = (total[key][i] ?? 0) + value;
      }
    }
  }

  return total;
}
