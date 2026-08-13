/**
 * Slashing: the penalty model, and what a slash costs a nominator. The curves
 * here are the two penalty *formulas* against the number of simultaneous
 * offenders, not history — both are superlinear in how many operators fail
 * together, which is the most counter-intuitive property of Substrate slashing
 * and the reason spreading nominations across independent operators matters.
 *
 * History is a separate concern: see `lib/schemas/data.ts` and `/slashing`.
 */

/**
 * Penalty for unresponsiveness (the `im-online` offence): a validator that
 * stops sending heartbeats.
 *
 *   fraction = min( 3 * (k - (n/10 + 1)) / n, 1 ) * 0.07
 *
 * where `k` is the number of validators offending in the same session and `n`
 * is the size of the active set.
 *
 * Two surprising properties fall out of it: there is a free allowance (while
 * `k <= n/10 + 1` the penalty is zero, so an isolated offline validator is not
 * slashed at all, it simply earns nothing), and it is capped at 7%, reached
 * once roughly a third of the set is unresponsive at once.
 */
export function unresponsivenessPenalty(offenders: number, validators: number): number {
  if (validators <= 0) return 0;
  const allowance = validators / 10 + 1;
  return Math.max(Math.min((3 * (offenders - allowance)) / validators, 1), 0) * 0.07;
}

/**
 * Penalty for equivocation (signing two conflicting blocks or votes — a BABE or
 * GRANDPA offence).
 *
 *   fraction = min( (3k / n)^2, 1 )
 *
 * Quadratic, with no free allowance: one validator in a set of a hundred costs
 * 0.09% of stake, thirty-four at once costs everything. An isolated equivocation
 * is almost always a misconfiguration; a correlated one is indistinguishable
 * from an attack.
 */
export function equivocationPenalty(offenders: number, validators: number): number {
  if (validators <= 0) return 0;
  return Math.min(((3 * offenders) / validators) ** 2, 1);
}

export type OffenceKind = 'unresponsiveness' | 'equivocation';

export const OFFENCE_LABELS: Record<OffenceKind, string> = {
  unresponsiveness: 'Unresponsiveness',
  equivocation: 'Equivocation',
};

/**
 * Both penalty curves sampled across every possible offender count,
 * `0..validators` inclusive so each reaches its true endpoint.
 */
export function penaltyCurves(validators: number): {
  offenders: number[];
  unresponsiveness: number[];
  equivocation: number[];
} {
  const offenders: number[] = [];
  const unresponsiveness: number[] = [];
  const equivocation: number[] = [];

  for (let k = 0; k <= Math.max(0, validators); k += 1) {
    offenders.push(k);
    unresponsiveness.push(unresponsivenessPenalty(k, validators));
    equivocation.push(equivocationPenalty(k, validators));
  }

  return { offenders, unresponsiveness, equivocation };
}

/**
 * The smallest number of simultaneous offenders that triggers a non-zero
 * penalty, or null if the curve never leaves zero. Only meaningful for
 * unresponsiveness — equivocation has no allowance — but written generally so
 * the page can state the threshold rather than leave it to be inferred.
 */
export function firstPenalisedOffenderCount(
  validators: number,
  penalty: (offenders: number, validators: number) => number,
): number | null {
  for (let k = 1; k <= validators; k += 1) {
    if (penalty(k, validators) > 0) return k;
  }
  return null;
}

/**
 * What a slash of `fraction` would cost a nominator holding `bonded`.
 *
 * Hypothetical on mainnet: `validators.slashingAllowedFor` is `Validator`, so
 * nominated tokens are not slashed at all. Callers must check `Slashes.scope`
 * before presenting this as a real loss.
 *
 * The arithmetic is what Substrate would apply if the switch were flipped:
 * proportional to exposure, so a nominator loses the same percentage as the
 * operator, however large it is. The loss is *not* diluted across the
 * operator's other backers, which is what nominators tend to expect.
 */
export function nominatorLoss(bonded: number, fraction: number): number {
  return bonded * Math.max(0, Math.min(1, fraction));
}
