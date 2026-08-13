'use client';

import { useMemo, useState } from 'react';
import { summariseProduction } from '@/lib/metrics/production';
import { SERIES_TOKENS } from '@/lib/charts/palette';
import { formatNumber, formatPercent } from '@/lib/format';
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
 * Block production against what the authorship lottery predicts (C18).
 *
 * The catalogue asked for "current-era points by operator, sorted, with an
 * expected-value reference line". That chart was built and thrown away: at a
 * third of the way through era 1750 the field's spread was 12.5% against the
 * 13.4% a pure lottery predicts, and over a *complete* era it was 8.1% against
 * 7.9%. There is no operator signal in one era's points at all — only slot
 * luck — so sorting it produces a leaderboard of coin flips and a reference
 * line lends that leaderboard authority. See `lib/metrics/production.ts` for
 * the measurements.
 *
 * The question survives the chart. Accumulated over the selected era range the
 * luck averages down, and over ninety eras roughly 1.1% of genuine
 * operator-to-operator dispersion remains — small, but real, and it is missed
 * blocks, which is exactly what a nominator wants to know. So: the same
 * question, over the range, with the margin of error drawn so that "better
 * than expected" cannot be confused with "lucky".
 */

/** Two standard errors — the conventional line for "not just chance". */
const SIGMA = 2;

export interface ProductionChartProps {
  series: StitchedSeries | null | undefined;
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

export function ProductionChart({
  series,
  nameOf,
  statusOf,
  selected,
  selectionNoun,
  height = 300,
  loading = false,
  error,
}: ProductionChartProps) {
  // Matches the directory table's default, and the returns chart beside it.
  const [status, setStatus] = useState<StatusFilter>('active');

  const summary = useMemo(() => {
    if (!series) return null;
    return summariseProduction({
      eras: series.eras,
      network: series.network,
      operators: series.operators,
    });
  }, [series]);

  const items = useMemo<(DeviationItem & { status: OperatorStatus })[]>(() => {
    if (!summary) return [];
    const slotOf = new Map(selected.map((address, i) => [address, i]));

    return summary.records.map((record) => {
      const slot = slotOf.get(record.address);
      const margin = SIGMA * record.standardError;
      const operatorStatus = statusOf(record.address);
      return {
        id: record.address,
        status: operatorStatus,
        muted: operatorStatus === 'inactive',
        label:
          operatorStatus === 'inactive'
            ? `${nameOf(record.address)} (no longer running)`
            : nameOf(record.address),
        value: record.ratio,
        low: 1 - margin,
        high: 1 + margin,
        detail:
          `${record.eras} era${record.eras === 1 ? '' : 's'} · ` +
          `${formatNumber(record.points)} points against ${formatNumber(Math.round(record.expected))} expected`,
        // Only the first eight pins get a colour; the palette is not cycled,
        // and a ninth would repeat a hue already in use elsewhere.
        highlight: slot != null && slot < SERIES_TOKENS.length ? SERIES_TOKENS[slot] : undefined,
      };
    });
  }, [summary, selected, nameOf, statusOf]);

  /**
   * Display only — `summary` still covers the whole field, so the expected
   * line and the chance band do not shift when the selection changes.
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

  const outliers = useMemo(
    () => visible.filter((item) => item.value > item.high || item.value < item.low).length,
    [visible],
  );

  /**
   * What the range can actually support.
   *
   * Stated rather than implied, because it changes with the era-range control:
   * over a week the same calculation is almost pure noise, and a reader who
   * narrows the range deserves to be told the chart stopped meaning anything
   * rather than left to read the same shape as before.
   */
  const coverage = useMemo(() => {
    if (!summary || summary.records.length === 0) return undefined;
    const shown =
      visible.length === summary.records.length
        ? `${summary.records.length} operators`
        : `showing ${visible.length} of ${summary.records.length} operators`;
    const base =
      `${summary.eras} era${summary.eras === 1 ? '' : 's'}, ${shown}. ` +
      `Expected is the era's total points divided by the active set — authorship slots go per ` +
      `validator, not per unit of stake.`;

    if (summary.excessSpread == null) {
      return (
        `${base} Over this range the whole spread (±${formatPercent(summary.observedSpread, { decimals: 1 })}) ` +
        `is within what chance alone produces, so nothing here separates one operator from another. ` +
        `Widen the era range.`
      );
    }
    return (
      `${base} The field spreads ±${formatPercent(summary.observedSpread, { decimals: 1 })}, of which ` +
      `±${formatPercent(summary.luckSpread, { decimals: 1 })} is chance; ` +
      `±${formatPercent(summary.excessSpread, { decimals: 1 })} is genuine difference between operators.`
    );
  }, [summary, visible.length]);

  const signed = (value: number) => formatPercent(value - 1, { decimals: 1, signed: true });

  return (
    <LazyChart height={height} label="Block production against expected">
      <LazyDeviationChart
        title="Blocks produced, against expected"
        subtitle={
          outliers > 0
            ? `${outliers} of ${visible.length} operators are measurably off the mark. The rest are indistinguishable from each other.`
            : 'Every operator is within the margin of error — on this range, no one is measurably ahead or behind.'
        }
        coverage={coverage}
        actions={
          <OperatorStatusFilter
            id="production-status"
            value={status}
            onChange={setStatus}
            hidden={items.length - visible.length}
            hiddenPinned={hiddenPinned}
            showPinnedOption={pinned.size > 0}
            {...(selectionNoun ? { selectionNoun } : {})}
          />
        }
        items={visible}
        baseline={1}
        format={signed}
        tickFormat={signed}
        yLabel="Difference from expected"
        bandLabel="Explained by chance"
        valueLabel="vs expected"
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
