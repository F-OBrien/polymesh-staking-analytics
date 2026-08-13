import { aprToApy } from './staking';

/**
 * Reward projection for the calculator. The framing matters more than the
 * arithmetic: a single confident number is misleading, since the return depends
 * on the staking ratio, the operator continuing to perform and its commission
 * not changing — none of which the user controls.
 *
 * So every projection carries a range from that operator's own measured
 * era-to-era variance, and `assumptions()` states what the figure is
 * conditional on. A wide band is information, not a defect.
 */

export interface ProjectionInput {
  /** POLYX bonded. */
  amount: number;
  /** Expected return after commission, as a ratio. */
  apr: number;
  /**
   * Standard deviation of that operator's per-era APR, as a ratio. Drives the
   * band; pass 0 or null for a point estimate with no range.
   */
  aprStdDev?: number | null | undefined;
  /** Projection horizon in days. */
  days: number;
  erasPerYear: number;
  /**
   * Whether rewards are re-bonded as they are claimed. Polymesh does not
   * auto-compound — rewards land in the free balance and must be bonded again —
   * so this models a user who does that every era, an upper bound.
   */
  compound: boolean;
}

export interface ProjectionBand {
  /** Reward at the central APR. */
  mid: number;
  /** Reward one standard deviation below and above. */
  low: number;
  high: number;
}

export interface Projection {
  reward: ProjectionBand;
  /** Bonded plus reward. */
  total: ProjectionBand;
  /** The APR used, and the band around it. */
  apr: { mid: number; low: number; high: number };
  /**
   * The same three figures as an effective annual rate. A band rather than a
   * scalar so the headline and the range beside it stay on one basis —
   * otherwise a compounded headline sits outside its own uncompounded range and
   * reads as an arithmetic bug. Equal to `apr` when not compounding.
   */
  apy: { mid: number; low: number; high: number };
  /** Eras the horizon spans, rounded down — rewards accrue per whole era. */
  eras: number;
}

/**
 * Growth over `eras` at a per-era rate. Simple interest when not compounding,
 * because unclaimed rewards genuinely do not earn — they sit in the free
 * balance until bonded.
 */
function grow(
  amount: number,
  apr: number,
  eras: number,
  erasPerYear: number,
  compound: boolean,
): number {
  if (amount <= 0 || eras <= 0 || erasPerYear <= 0) return 0;
  const perEra = Math.max(0, apr) / erasPerYear;
  return compound ? amount * ((1 + perEra) ** eras - 1) : amount * perEra * eras;
}

export function project({
  amount,
  apr,
  aprStdDev,
  days,
  erasPerYear,
  compound,
}: ProjectionInput): Projection {
  const eras = Math.max(0, Math.floor((days * erasPerYear) / 365));
  const sigma = aprStdDev != null && Number.isFinite(aprStdDev) ? Math.abs(aprStdDev) : 0;

  // Clamped at zero: a wide band on a low-APR operator should bottom out at
  // "earns nothing", not "loses money". Slashing is a different number.
  const lowApr = Math.max(0, apr - sigma);
  const highApr = Math.max(0, apr + sigma);

  const reward: ProjectionBand = {
    mid: grow(amount, apr, eras, erasPerYear, compound),
    low: grow(amount, lowApr, eras, erasPerYear, compound),
    high: grow(amount, highApr, eras, erasPerYear, compound),
  };

  const effective = (rate: number) => (compound ? aprToApy(rate, erasPerYear) : rate);

  return {
    reward,
    total: { mid: amount + reward.mid, low: amount + reward.low, high: amount + reward.high },
    apr: { mid: apr, low: lowApr, high: highApr },
    apy: { mid: effective(apr), low: effective(lowApr), high: effective(highApr) },
    eras,
  };
}

/**
 * What the projection is conditional on, in words — rendered beside the figure
 * rather than as a footnote. Each entry names a specific thing that could make
 * the number wrong; "estimates only" tells a reader nothing.
 */
export function assumptions({
  compound,
  hasVariance,
  operatorLabel,
}: {
  compound: boolean;
  hasVariance: boolean;
  operatorLabel: string;
}): string[] {
  return [
    `Return is projected from ${operatorLabel}'s measured performance over the era range selected above, not from a forecast.`,
    hasVariance
      ? `The range is one standard deviation of ${operatorLabel}'s era-to-era return. Roughly two thirds of eras fell inside it; individual eras fell outside.`
      : 'No range is shown, because there is not enough history in this range to measure how variable the return has been.',
    compound
      ? 'Assumes every reward is claimed and re-bonded each era. Polymesh does not do this automatically, so this is an upper bound.'
      : 'Assumes rewards are left unbonded, so they do not themselves earn. This is the default behaviour.',
    'Assumes commission stays where it is. An operator can raise it at any time, and the change applies to the era in progress.',
    'Assumes the network staking ratio holds. Total rewards are fixed, so a rise in total stake dilutes everyone’s return.',
    'Excludes slashing. A single offence can cost more than a year of rewards — see the slashing page.',
  ];
}
