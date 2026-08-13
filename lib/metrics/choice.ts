import { deriveOperatorApr, type NullableNetwork } from './derive';
import type { OperatorSeries } from '@/lib/schemas/data';

/**
 * What backing *these* operators is worth, against backing the average one —
 * the counterfactual none of the page's absolute figures answers.
 *
 * Forward-looking, and it has to be: a retrospective version cannot be built
 * honestly, because the indexer's reward events carry no validator and the
 * counterfactual would also need each past era's exposure, an archive read per
 * era. So this compares the current nominations over the era range on screen
 * and prices the gap against the stake assigned now — also the more useful
 * direction, since a reader can change who they nominate.
 *
 * The gap decomposes exactly:
 *
 *     net = gross x (1 - commission)
 *     net_you - net_field = (gross_you - gross_field)(1 - c_you)   <- production
 *                         - gross_field (c_you - c_field)          <- commission
 *
 * and the two terms are worth very different amounts here: production separates
 * the field by about 1.1% once slot luck is removed
 * (`lib/metrics/production.ts`), while commission spans 8–10%. A nominator
 * chasing performance is optimising the smaller term, and the split says so.
 */

export interface OperatorPick {
  address: string;
  /** Stake assigned to this operator, for weighting. Zero is fine. */
  weight: number;
}

export interface ChoiceInput {
  eras: readonly number[];
  network: NullableNetwork<'validatorReward' | 'totalPoints'>;
  operators: Readonly<Record<string, OperatorSeries>>;
  picks: readonly OperatorPick[];
  erasPerYear: number;
  /**
   * Fraction of the range an operator must have been active for to count.
   * Every mean here weights operators equally, so without a floor one present
   * for three eras of eighty-six counts as much as one present throughout —
   * measured, enough to invert the comparison's conclusion.
   */
  minCoverage?: number;
}

const DEFAULT_MIN_COVERAGE = 0.5;

export interface ChoiceComparison {
  /** Eras with a usable figure for at least one pick. */
  eras: number;
  /** How many picks had any history in the range. */
  covered: number;
  /** Weighted mean net APR across the picks. */
  yourNet: number;
  /** Mean net APR across every operator with history in the range. */
  fieldNet: number;
  yourCommission: number;
  fieldCommission: number;
  /** `yourNet - fieldNet`. Positive means the picks beat the field. */
  difference: number;
  /** The part of `difference` explained by charging less (or more). */
  fromCommission: number;
  /** The part explained by producing more (or fewer) blocks. */
  fromProduction: number;
  /**
   * What the two named terms do not account for: the split uses each group's
   * *average* gross return and commission, and the average of a product is not
   * the product of the averages. Reported rather than folded into a named term,
   * so nothing is called "from commission" when it is an arithmetic artefact.
   *
   * `fromCommission + fromProduction + unexplained === difference`, exactly.
   */
  unexplained: number;
}

/** Mean of the defined values, or null when there are none. */
function mean(values: readonly (number | null)[]): number | null {
  let sum = 0;
  let count = 0;
  for (const value of values) {
    if (value == null || !Number.isFinite(value)) continue;
    sum += value;
    count += 1;
  }
  return count > 0 ? sum / count : null;
}

interface OperatorMeans {
  gross: number;
  net: number;
  commission: number;
  eras: number;
}

function summarise(
  operator: OperatorSeries,
  network: ChoiceInput['network'],
  erasPerYear: number,
): OperatorMeans | null {
  const { gross, net } = deriveOperatorApr(operator, network, erasPerYear);
  const g = mean(gross);
  const n = mean(net);
  const c = mean(operator.commission);
  if (g == null || n == null || c == null) return null;
  return { gross: g, net: n, commission: c, eras: net.filter((v) => v != null).length };
}

export function compareChoice({
  eras,
  network,
  operators,
  picks,
  erasPerYear,
  minCoverage = DEFAULT_MIN_COVERAGE,
}: ChoiceInput): ChoiceComparison | null {
  if (eras.length === 0 || picks.length === 0) return null;

  const required = eras.length * minCoverage;

  const field: OperatorMeans[] = [];
  for (const operator of Object.values(operators)) {
    const summary = summarise(operator, network, erasPerYear);
    if (summary != null && summary.eras >= required) field.push(summary);
  }
  if (field.length === 0) return null;

  const fieldGross = field.reduce((a, b) => a + b.gross, 0) / field.length;
  const fieldNet = field.reduce((a, b) => a + b.net, 0) / field.length;
  const fieldCommission = field.reduce((a, b) => a + b.commission, 0) / field.length;

  const mine: { summary: OperatorMeans; weight: number }[] = [];
  for (const pick of picks) {
    const columns = operators[pick.address];
    if (!columns) continue;
    const summary = summarise(columns, network, erasPerYear);
    // The same floor on the picks: an operator nominated last week has no
    // measurable record, and averaging it in reports its luck as the choice.
    if (summary != null && summary.eras >= required) mine.push({ summary, weight: pick.weight });
  }
  if (mine.length === 0) return null;

  // Weighted by assigned stake where there is any: a nominator commonly has
  // many nominations and stake behind one, so an unweighted average describes a
  // portfolio they do not hold. With nothing assigned, every pick counts once.
  const totalWeight = mine.reduce((a, b) => a + b.weight, 0);
  const weightOf = (entry: { weight: number }) =>
    totalWeight > 0 ? entry.weight / totalWeight : 1 / mine.length;

  const yourNet = mine.reduce((a, b) => a + b.summary.net * weightOf(b), 0);
  const yourGross = mine.reduce((a, b) => a + b.summary.gross * weightOf(b), 0);
  const yourCommission = mine.reduce((a, b) => a + b.summary.commission * weightOf(b), 0);

  const fromProduction = (yourGross - fieldGross) * (1 - yourCommission);
  const fromCommission = -fieldGross * (yourCommission - fieldCommission);
  const difference = yourNet - fieldNet;

  return {
    eras: eras.length,
    covered: mine.length,
    yourNet,
    fieldNet,
    yourCommission,
    fieldCommission,
    difference,
    fromCommission,
    fromProduction,
    unexplained: difference - fromCommission - fromProduction,
  };
}
