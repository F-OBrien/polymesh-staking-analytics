import { describe, expect, it } from 'vitest';
import { deriveNetworkRewardSplit, deriveRewardSplit, operatorKept } from './rewards';

const network = {
  validatorReward: [1000, 1000, 1000],
  totalPoints: [100, 100, 100],
};

const operator = (over: Partial<Record<string, (number | null)[]>> = {}) => ({
  points: [50, 50, 50],
  commission: [0.1, 0.1, 0.1],
  totalStake: [1000, 1000, 1000],
  ownStake: [100, 100, 100],
  ...over,
});

describe('deriveRewardSplit', () => {
  it('divides the reward the way the chain does', () => {
    const split = deriveRewardSplit(operator(), network);

    // Half the points, so half the era's 1000 POLYX.
    expect(split.gross[0]).toBeCloseTo(500, 6);
    // Commission comes off the top of the whole reward.
    expect(split.commission[0]).toBeCloseTo(50, 6);
    // Only the remaining 450 is divided by stake, and the operator holds 10%.
    expect(split.ownStake[0]).toBeCloseTo(45, 6);
    expect(split.nominators[0]).toBeCloseTo(405, 6);
  });

  it('always sums the parts back to the gross', () => {
    // Awkward numbers, where a percentage-of-a-percentage would not land clean.
    const split = deriveRewardSplit(
      operator({
        points: [37, 37, 37],
        commission: [0.077, 0.077, 0.077],
        ownStake: [313, 313, 313],
      }),
      network,
    );

    for (let i = 0; i < 3; i += 1) {
      const parts =
        (split.commission[i] as number) +
        (split.ownStake[i] as number) +
        (split.nominators[i] as number);
      expect(parts).toBeCloseTo(split.gross[i] as number, 10);
    }
  });

  it('pays an operator twice when it backs itself', () => {
    // The whole pool is the operator's own stake, so nothing is left over.
    const split = deriveRewardSplit(operator({ ownStake: [1000, 1000, 1000] }), network);

    expect(split.nominators[0]).toBeCloseTo(0, 10);
    expect(operatorKept(split)[0]).toBeCloseTo(split.gross[0] as number, 10);
  });

  it('never pays nominators a negative share when own stake rounds above total', () => {
    // As stored in the first chunk: no nominators at all, and own and total
    // recorded separately at six decimals, so own lands fractionally higher.
    const split = deriveRewardSplit(
      operator({ ownStake: [1061.04, 1061.04, 1061.04], totalStake: [1061, 1061, 1061] }),
      network,
    );

    expect(split.nominators[0]).toBe(0);
    expect(split.ownStake[0]).toBeCloseTo((split.gross[0] as number) * 0.9, 10);
    // The parts still reconstruct the whole; the clamp moves nothing else.
    const parts =
      (split.commission[0] as number) +
      (split.ownStake[0] as number) +
      (split.nominators[0] as number);
    expect(parts).toBeCloseTo(split.gross[0] as number, 10);
  });

  it('leaves everything blank for an era the operator was not in the set', () => {
    const split = deriveRewardSplit(
      operator({
        points: [null, 50, 50],
        commission: [null, 0.1, 0.1],
        totalStake: [null, 1000, 1000],
        ownStake: [null, 100, 100],
      }),
      network,
    );

    // Null, not zero: "not elected" and "earned nothing" are different claims,
    // and a zero would draw a bar of no height that reads as the second.
    expect(split.gross[0]).toBeNull();
    expect(split.commission[0]).toBeNull();
    expect(split.ownStake[0]).toBeNull();
    expect(split.nominators[0]).toBeNull();
  });

  it('withholds the split rather than assuming a commission of zero', () => {
    const split = deriveRewardSplit(operator({ commission: [null, 0.1, 0.1] }), network);
    expect(split.commission[0]).toBeNull();
    // The gross is still known — it depends only on points.
    expect(split.gross[0]).toBeCloseTo(500, 6);
  });
});

describe('deriveNetworkRewardSplit', () => {
  it('reconciles with the era reward the chain recorded', () => {
    const operators = {
      a: operator({ points: [50, 50, 50], commission: [0.1, 0.1, 0.1] }),
      b: operator({
        points: [30, 30, 30],
        commission: [0.05, 0.05, 0.05],
        ownStake: [500, 500, 500],
      }),
      c: operator({ points: [20, 20, 20], commission: [0.2, 0.2, 0.2], ownStake: [0, 0, 0] }),
    };

    const total = deriveNetworkRewardSplit(operators, network, 3);

    for (let i = 0; i < 3; i += 1) {
      expect(total.gross[i]).toBeCloseTo(network.validatorReward[i] as number, 6);
      const parts =
        (total.commission[i] as number) +
        (total.ownStake[i] as number) +
        (total.nominators[i] as number);
      expect(parts).toBeCloseTo(network.validatorReward[i] as number, 6);
    }
  });

  it('leaves an era with no contributing operator blank', () => {
    const total = deriveNetworkRewardSplit({ a: operator({ points: [null, 50, 50] }) }, network, 3);
    expect(total.gross[0]).toBeNull();
    expect(total.gross[1]).toBeCloseTo(500, 6);
  });
});
