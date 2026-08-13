import { describe, expect, it } from 'vitest';
import { summariseReturns, type ReturnContribution, type ReturnsInput } from './returns';

/**
 * A network where every operator can be given a production share, a commission
 * and a stake independently, so each factor can be moved on its own and the
 * others held at exactly average.
 */
function chain(
  spec: Record<string, { share?: number; commission?: number; stake?: number; own?: number }>,
  eras = 10,
  { blocksPerEra = 1000, rewardPerEra = 1000, stakePerOperator = 1_000_000 } = {},
) {
  const addresses = Object.keys(spec);
  const shares = addresses.map((a) => spec[a]?.share ?? 1);
  const totalShare = shares.reduce((a, b) => a + b, 0);

  const operators: ReturnsInput['operators'] = Object.fromEntries(
    addresses.map((address, i) => [
      address,
      {
        points: Array.from(
          { length: eras },
          () => Math.round((blocksPerEra * (shares[i] as number)) / totalShare) * 20,
        ),
        commission: Array.from({ length: eras }, () => spec[address]?.commission ?? 0),
        totalStake: Array.from({ length: eras }, () => spec[address]?.stake ?? stakePerOperator),
        // A tenth of the exposure is the operator's own, so every era in a
        // fixture has nominator stake in it unless a test says otherwise.
        ownStake: Array.from(
          { length: eras },
          () => spec[address]?.own ?? (spec[address]?.stake ?? stakePerOperator) * 0.1,
        ),
      },
    ]),
  );

  const totalPoints = Array.from({ length: eras }, (_, e) =>
    addresses.reduce((sum, a) => sum + ((operators[a]?.points[e] as number) ?? 0), 0),
  );
  // `totalStaked` is the active set's summed exposure, which is what mainnet
  // records and what the reference return is taken against.
  const totalStaked = Array.from({ length: eras }, (_, e) =>
    addresses.reduce((sum, a) => sum + ((operators[a]?.totalStake[e] as number) ?? 0), 0),
  );

  return {
    eras: Array.from({ length: eras }, (_, i) => 1000 + i),
    network: {
      validatorReward: Array.from({ length: eras }, () => rewardPerEra),
      totalPoints,
      activeOperators: Array.from({ length: eras }, () => addresses.length),
      totalStaked,
    },
    operators,
    erasPerYear: 365,
    awardPerBlock: 20,
  } satisfies ReturnsInput;
}

const byAddress = (summary: ReturnType<typeof summariseReturns>, address: string) => {
  const record = summary.records.find((r) => r.address === address);
  if (!record) throw new Error(`no record for ${address}`);
  return record;
};

describe('summariseReturns', () => {
  it('gives a uniform field the reference return and no advantage anywhere', () => {
    const summary = summariseReturns(chain({ a: {}, b: {}, c: {}, d: {} }));

    expect(summary.records).toHaveLength(4);
    for (const record of summary.records) {
      expect(record.production).toBeCloseTo(1, 10);
      expect(record.keep).toBeCloseTo(1, 10);
      expect(record.stakeAdvantage).toBeCloseTo(1, 10);
      expect(record.netApr).toBeCloseTo(summary.referenceApr, 10);
      expect(record.referenceApr).toBeCloseTo(summary.referenceApr, 10);
    }
  });

  /**
   * The election spreads a nominator's stake over whichever of *their*
   * nominations were elected, so an operator sitting out an era moves that
   * stake to the others rather than idling it. Booking the era against the
   * operator would charge it for a loss nobody took, and would compound the
   * longer it stayed out.
   */
  it('measures an operator only over the eras it was elected', () => {
    const input = chain({ dropout: {}, b: {}, c: {}, d: {} }, 20);
    const dropout = input.operators['dropout'] as {
      points: (number | null)[];
      commission: (number | null)[];
      totalStake: (number | null)[];
    };
    for (const era of [8, 9, 10, 11]) {
      dropout.points[era] = null;
      dropout.commission[era] = null;
      dropout.totalStake[era] = null;
    }

    const summary = summariseReturns(input);
    const record = byAddress(summary, 'dropout');

    expect(record.eras).toBe(16);
    // Identical to the field in every era it was actually elected, so it must
    // read as identical to the field.
    expect(record.netApr).toBeCloseTo(byAddress(summary, 'b').netApr, 10);
    expect(record.production).toBeCloseTo(1, 10);
    expect(record.stakeAdvantage).toBeCloseTo(1, 10);
  });

  it('does charge an operator that was elected and scored nothing', () => {
    const input = chain({ idle: {}, b: {}, c: {}, d: {} }, 20);
    const idle = input.operators['idle'] as { points: (number | null)[] };
    // Elected — stake and commission still recorded — but authored nothing.
    for (const era of [8, 9, 10, 11]) idle.points[era] = 0;

    const summary = summariseReturns(input);
    const record = byAddress(summary, 'idle');

    // The stake was committed and the era was theirs, so the zero is theirs.
    expect(record.eras).toBe(20);
    expect(record.production).toBeLessThan(0.85);
    expect(record.netApr).toBeLessThan(byAddress(summary, 'b').netApr);
    expect(record.contribution.production).toBeLessThan(0);
  });

  it('compares an operator against the field over its own eras', () => {
    // The network's gross return doubles halfway through, and the operator is
    // only elected for the poorer half. Measured against the whole range it
    // would look far worse than it was.
    const input = chain({ early: {}, b: {}, c: {} }, 20);
    for (let i = 10; i < 20; i += 1) input.network.validatorReward[i] = 2000;
    const early = input.operators['early'] as {
      points: (number | null)[];
      commission: (number | null)[];
      totalStake: (number | null)[];
    };
    for (let i = 10; i < 20; i += 1) {
      early.points[i] = null;
      early.commission[i] = null;
      early.totalStake[i] = null;
    }

    const summary = summariseReturns(input);
    const record = byAddress(summary, 'early');

    expect(record.netApr).toBeCloseTo(record.referenceApr, 10);
    expect(record.referenceApr).toBeLessThan(summary.referenceApr);
    for (const value of Object.values(record.contribution)) {
      expect(value).toBeCloseTo(0, 10);
    }
  });

  it('reproduces the realised return from its factors', () => {
    // Every factor moved at once, so the identity is tested where it is least
    // trivially true.
    const summary = summariseReturns(
      chain({
        a: { share: 1.2, commission: 0.1, stake: 900_000 },
        b: { share: 0.9, commission: 0.05, stake: 1_100_000 },
        c: { share: 1.0, commission: 0.2, stake: 1_000_000 },
      }),
    );

    for (const record of summary.records) {
      const rebuilt = record.referenceApr * record.production * record.keep * record.stakeAdvantage;
      expect(rebuilt).toBeCloseTo(record.netApr, 8);
    }
  });

  /**
   * Each factor gets its own field. Putting all three deviants in one chain
   * would not isolate anything: the field average is what each is measured
   * against, so an under-staked operator lowers everyone else's stake term and
   * a heavy producer lowers everyone else's production term. That is correct
   * behaviour, and it means "only this factor differs" can only be arranged one
   * factor at a time.
   */
  it('attributes the gap to the factor that actually caused it', () => {
    const dominant = (c: ReturnContribution) =>
      (Object.entries(c) as [keyof typeof c, number][]).reduce((best, entry) =>
        Math.abs(entry[1]) > Math.abs(best[1]) ? entry : best,
      )[0];

    const producer = byAddress(
      summariseReturns(chain({ subject: { share: 1.3 }, b: {}, c: {}, d: {} })),
      'subject',
    );
    expect(dominant(producer.contribution)).toBe('production');
    expect(producer.contribution.production).toBeGreaterThan(0);

    const charger = byAddress(
      summariseReturns(chain({ subject: { commission: 0.25 }, b: {}, c: {}, d: {} })),
      'subject',
    );
    expect(dominant(charger.contribution)).toBe('commission');
    expect(charger.contribution.commission).toBeLessThan(0);
    expect(charger.contribution.production).toBeCloseTo(0, 10);

    const small = byAddress(
      summariseReturns(chain({ subject: { stake: 500_000 }, b: {}, c: {}, d: {} })),
      'subject',
    );
    expect(dominant(small.contribution)).toBe('stake');
    expect(small.contribution.stake).toBeGreaterThan(0);
    expect(small.contribution.commission).toBeCloseTo(0, 10);
  });

  it('splits the gap into parts that sum to it exactly', () => {
    const summary = summariseReturns(
      chain({
        a: { share: 1.4, commission: 0.3, stake: 600_000 },
        b: { share: 0.7, commission: 0.02, stake: 1_400_000 },
        c: {},
      }),
    );

    for (const record of summary.records) {
      const { production, commission, stake } = record.contribution;
      expect(production + commission + stake).toBeCloseTo(record.netApr - record.referenceApr, 10);
    }
  });

  it('separates the durable factors from the transient one', () => {
    const summary = summariseReturns(
      chain({ good: { share: 1.2, commission: 0.1 }, lucky: { stake: 500_000 }, filler: {} }),
    );

    const good = byAddress(summary, 'good');
    const lucky = byAddress(summary, 'lucky');

    // The under-staked operator earns more, and a ranking on realised return
    // would put it first — which is the whole reason `durable` exists.
    expect(lucky.netApr).toBeGreaterThan(good.netApr);
    expect(good.durable).toBeGreaterThan(lucky.durable);
    // Its whole advantage sits in the term that does not persist.
    expect(lucky.stakeAdvantage).toBeGreaterThan(1.5);
    expect(good.stakeAdvantage).toBeLessThan(1);
  });

  it('charges commission against the nominator but not against production', () => {
    const summary = summariseReturns(chain({ a: { commission: 0.2 }, b: {}, c: {} }));
    const a = byAddress(summary, 'a');

    expect(a.keep).toBeCloseTo(0.8, 10);
    expect(a.netApr).toBeCloseTo(a.grossApr * 0.8, 10);
    // Gross is node performance: identical operators differing only in
    // commission must be indistinguishable before it is taken.
    expect(a.grossApr).toBeCloseTo(byAddress(summary, 'b').grossApr, 10);
  });

  it('scales the uncertainty with the return, not with the ratio', () => {
    const summary = summariseReturns(chain({ a: {}, b: {}, c: {} }, 40));

    for (const record of summary.records) {
      expect(record.standardError).toBeGreaterThan(0);
      // The lottery's relative error, carried through multiplicatively.
      expect(record.standardError / record.netApr).toBeLessThan(0.2);
    }
  });

  it('reports a tight field as entirely explained by luck', () => {
    const summary = summariseReturns(chain({ a: {}, b: {}, c: {}, d: {} }, 5));
    expect(summary.excessSpread).toBeNull();
  });

  it('keeps a newcomer on a long range, where half the eras is the wrong ask', () => {
    // 200 eras. Half of them is 100, but an operator with 60 is perfectly
    // measurable — and over the chain's whole history the fractional rule threw
    // away most of the operators actually running.
    const input = chain({ veteran: {}, newcomer: {}, b: {}, c: {} }, 200);
    const newcomer = input.operators['newcomer'] as {
      points: (number | null)[];
      commission: (number | null)[];
      totalStake: (number | null)[];
      ownStake: (number | null)[];
    };
    for (let i = 0; i < 140; i += 1) {
      newcomer.points[i] = null;
      newcomer.commission[i] = null;
      newcomer.totalStake[i] = null;
      newcomer.ownStake[i] = null;
    }

    const summary = summariseReturns(input);
    expect(summary.records.map((r) => r.address)).toContain('newcomer');
    expect(byAddress(summary, 'newcomer').eras).toBe(60);
  });

  it('ignores eras in which no nominator stake was exposed', () => {
    const input = chain({ joiner: {}, b: {}, c: {}, d: {} }, 60);
    const joiner = input.operators['joiner'] as {
      points: (number | null)[];
      totalStake: (number | null)[];
      ownStake: (number | null)[];
    };
    // Elected on its own bond alone, as a new operator is until the next
    // election allocates nominations: a full era's blocks over a tiny stake.
    joiner.totalStake[0] = 50_000;
    joiner.ownStake[0] = 50_000;

    const summary = summariseReturns(input);
    const record = byAddress(summary, 'joiner');

    expect(record.eras).toBe(59);
    // No nominator could have earned that era, so it must not lift the figure
    // on a chart titled "what a nominator earned".
    expect(record.netApr).toBeCloseTo(byAddress(summary, 'b').netApr, 10);
  });

  it('drops operators present for too little of the range', () => {
    const input = chain({ a: {}, b: {}, latecomer: {} }, 20);
    const late = input.operators['latecomer'] as {
      points: (number | null)[];
      commission: (number | null)[];
      totalStake: (number | null)[];
    };
    // Absent for all but the last three eras — nulls, as the ingest writes them.
    for (let i = 0; i < 17; i += 1) {
      late.points[i] = null;
      late.commission[i] = null;
      late.totalStake[i] = null;
    }

    const summary = summariseReturns(input);
    expect(summary.records.map((r) => r.address)).not.toContain('latecomer');
  });

  it('withholds an era with no commission record rather than reading it as zero', () => {
    const input = chain({ a: {}, b: {}, c: {} }, 10);
    const a = input.operators['a'] as { commission: (number | null)[] };
    a.commission[0] = null;

    const summary = summariseReturns(input);
    // The era is skipped entirely, not counted with a free 100% keep rate.
    expect(byAddress(summary, 'a').eras).toBe(9);
    expect(byAddress(summary, 'b').eras).toBe(10);
  });

  it('returns an empty summary rather than dividing by zero', () => {
    expect(summariseReturns({ ...chain({ a: {} }), eras: [] }).records).toHaveLength(0);
    expect(summariseReturns({ ...chain({ a: {} }), erasPerYear: 0 }).records).toHaveLength(0);
  });
});
