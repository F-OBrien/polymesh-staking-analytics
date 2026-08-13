'use client';

import { useMemo, useState } from 'react';
import { summariseReturns, type ReturnContribution } from '@/lib/metrics/returns';
import { SERIES_TOKENS } from '@/lib/charts/palette';
import { formatPercent } from '@/lib/format';
import { LazyChart, LazyDeviationChart } from '@/components/charts/lazy-chart';
import type { DeviationItem } from '@/components/charts/deviation-chart';
import type { StitchedSeries } from '@/lib/data/series';
import type { OperatorStatus } from '@/lib/schemas/data';
import {
  filterOperators,
  OperatorStatusFilter,
  type StatusFilter,
} from '@/components/operator-status-filter';

/**
 * What a nominator actually earned from each operator.
 *
 * The block-production chart beside this one is the better measure of an
 * operator's *work*, and the worse measure of the deal on offer. Two operators
 * filling their slots identically pay differently once commission is taken, and
 * differently again if one is sharing the reward with more stake — the reward
 * is fixed by points, so extra stake does not grow it, only splits it further.
 *
 * So: the same form, the same field, the same lottery band — and the return
 * after commission in place of the points.
 *
 * Operators that have since left the set are drawn back rather than dropped.
 * What they paid over the range is real and belongs in the field, but they are
 * not a choice anyone can make today.
 */

/** Two standard errors — the conventional line for "not just chance". */
const SIGMA = 2;

export interface ReturnsChartProps {
  series: StitchedSeries | null | undefined;
  erasPerYear: number;
  /** Address to display name. */
  nameOf: (address: string) => string;
  /** Address to registry status, for filtering and for greying out leavers. */
  statusOf: (address: string) => OperatorStatus;
  /** Pinned operators, in palette order. */
  selected: readonly string[];
  /** What `selected` is called here — "nominated" on the staking page. */
  selectionNoun?: string | undefined;
  height?: number;
  loading?: boolean | undefined;
  error?: Error | null | undefined;
}

export function ReturnsChart({
  series,
  erasPerYear,
  nameOf,
  statusOf,
  selected,
  selectionNoun,
  height = 300,
  loading = false,
  error,
}: ReturnsChartProps) {
  // Defaults to the operators a reader could actually nominate, matching the
  // directory table above it.
  const [status, setStatus] = useState<StatusFilter>('active');

  const summary = useMemo(() => {
    if (!series) return null;
    return summariseReturns({
      eras: series.eras,
      network: series.network,
      operators: series.operators,
      erasPerYear,
    });
  }, [series, erasPerYear]);

  const items = useMemo<(DeviationItem & { status: OperatorStatus })[]>(() => {
    if (!summary) return [];
    const slotOf = new Map(selected.map((address, i) => [address, i]));

    return summary.records.map((record) => {
      const slot = slotOf.get(record.address);
      const margin = SIGMA * record.standardError;

      // Whichever factor moved this operator furthest from the field, named in
      // the hover. A bar on its own says how much; this says what happened.
      const cause = dominantCause(record.contribution);
      const operatorStatus = statusOf(record.address);

      return {
        id: record.address,
        status: operatorStatus,
        label:
          operatorStatus === 'inactive'
            ? `${nameOf(record.address)} (no longer running)`
            : nameOf(record.address),
        value: record.netApr,
        // The band is centred on the field, not on the operator: it marks how
        // far slot luck alone could have carried them from it.
        low: summary.medianNetApr - margin,
        high: summary.medianNetApr + margin,
        muted: operatorStatus === 'inactive',
        detail:
          `elected for ${record.eras} of ${summary.eras} eras · ` +
          `${formatPercent(1 - record.keep, { decimals: 1 })} commission · ` +
          `mostly ${cause}`,
        // Only the first eight pins get a colour; the palette is not cycled,
        // and a ninth would repeat a hue already in use elsewhere.
        highlight: slot != null && slot < SERIES_TOKENS.length ? SERIES_TOKENS[slot] : undefined,
      };
    });
  }, [summary, selected, nameOf, statusOf]);

  /**
   * Filtered for display only — `summary` above still spans the whole field, so
   * the baseline and the margin of error stay put as the selection changes.
   */
  const pinned = useMemo(() => new Set(selected), [selected]);
  const visible = useMemo(() => filterOperators(items, status, pinned), [items, status, pinned]);

  /**
   * Pinned operators the filter is currently hiding.
   *
   * Surfaced next to the control because it is the one case where a missing bar
   * is surprising — the reader chose those operators — and "Pinned only" is one
   * selection away.
   */
  const hiddenPinned = useMemo(() => {
    const shown = new Set(visible.map((item) => item.id));
    return items.filter((item) => pinned.has(item.id) && !shown.has(item.id)).length;
  }, [items, pinned, visible]);

  /**
   * What the range can support, stated rather than implied.
   *
   * The band means the same thing it means on the production chart — how much
   * of a gap slot luck explains — but it will usually contain far fewer bars,
   * and that is the finding rather than a fault. Commission and stake are known
   * exactly, so a difference they cause is real however narrow the band is.
   */
  const coverage = useMemo(() => {
    if (!summary || summary.records.length === 0) return undefined;

    const shown =
      visible.length === summary.records.length
        ? `${summary.records.length} operators`
        : `showing ${visible.length} of ${summary.records.length} operators`;
    const base =
      `${summary.eras} era${summary.eras === 1 ? '' : 's'}, ${shown}, ` +
      `after commission. The field earned ${formatPercent(summary.referenceApr, { decimals: 2 })} ` +
      `before commission was taken. Each operator is measured over the eras it was elected, ` +
      `since an era it sat out sent a nominator's stake to their other choices rather than ` +
      `leaving it idle.`;

    if (summary.excessSpread == null) {
      return (
        `${base} Over this range the whole spread ` +
        `(±${formatPercent(summary.observedSpread, { decimals: 2 })}) is within what the ` +
        `authorship lottery alone produces, so nothing here separates one operator from ` +
        `another. Widen the era range.`
      );
    }

    return (
      `${base} The field spreads ±${formatPercent(summary.observedSpread, { decimals: 2 })}, of ` +
      `which ±${formatPercent(summary.luckSpread, { decimals: 2 })} is luck — the rest is ` +
      `production, commission and stake.`
    );
  }, [summary, visible]);

  const outliers = useMemo(
    () => visible.filter((item) => item.value > item.high || item.value < item.low).length,
    [visible],
  );

  const percent = (value: number) => formatPercent(value, { decimals: 2 });

  return (
    <LazyChart height={height} label="Return after commission by operator">
      <LazyDeviationChart
        title="What a nominator earned, by operator"
        subtitle={
          outliers > 0
            ? `${outliers} of ${visible.length} operators paid measurably more or less than the field. Hover a bar for what caused it.`
            : 'Every operator paid within the margin of error — on this range, none of them is measurably ahead or behind.'
        }
        coverage={coverage}
        actions={
          <OperatorStatusFilter
            id="returns-status"
            value={status}
            onChange={setStatus}
            hidden={items.length - visible.length}
            hiddenPinned={hiddenPinned}
            showPinnedOption={pinned.size > 0}
            {...(selectionNoun ? { selectionNoun } : {})}
          />
        }
        items={visible}
        baseline={summary?.medianNetApr ?? 0}
        format={percent}
        tickFormat={(v) => formatPercent(v, { decimals: 0 })}
        yLabel="Return after commission"
        bandLabel="Explained by chance"
        valueLabel="Return"
        readings={{
          above: 'paid more than the field',
          below: 'paid less than the field',
          within: 'in line with the field',
        }}
        height={height}
        loading={loading}
        error={error}
        empty={
          visible.length === 0
            ? items.length === 0
              ? 'No operator was in the active set for enough of this range.'
              : 'No operator matches this status over this range.'
            : null
        }
      />
    </LazyChart>
  );
}

/**
 * The factor that moved this operator furthest from the field, in words.
 *
 * Commission is excluded from the comparison rather than allowed to win it.
 * It is the largest term for almost every operator — around −2.2 percentage
 * points at a 10% rate — but it is nearly the same for all of them, so naming
 * it would tell the reader only that Polymesh has a commission, on every single
 * bar. What is wanted is what made *this* operator differ.
 */
function dominantCause(contribution: ReturnContribution): string {
  const candidates = [
    { label: 'block production', value: contribution.production },
    { label: 'the stake behind them', value: contribution.stake },
  ];

  const worst = candidates.reduce((best, c) =>
    Math.abs(c.value) > Math.abs(best.value) ? c : best,
  );

  if (Math.abs(worst.value) < 0.0005) return 'commission, like everyone else';
  return `${worst.label} (${formatPercent(worst.value, { decimals: 2, signed: true })})`;
}
