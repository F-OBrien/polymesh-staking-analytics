'use client';

import { useMemo } from 'react';
import {
  deriveNetworkRewardSplit,
  deriveRewardSplit,
  type RewardSplit,
} from '@/lib/metrics/rewards';
import { formatPolyx } from '@/lib/format';
import { LazyChart, LazyStackedAreaChart } from '@/components/charts/lazy-chart';
import type { StackSegment } from '@/components/charts/stacked-area-chart';
import type { StitchedSeries } from '@/lib/data/series';

/**
 * Where the rewards actually went, in POLYX.
 *
 * This replaces a plain "rewards paid each era" line rather than sitting beside
 * one. It plots the same quantity — the total validator payout — as the top of
 * the stack, and adds the only thing the line was missing: who received it. Two
 * charts of one number, one of them strictly less informative, is the same
 * duplication that had the network figures written twice across two pages.
 *
 * Every other chart on the site is a rate, and a rate cannot answer "is this
 * commission worth arguing about?". Over era 1750 the active set earned 338,919
 * POLYX; operators took 32,668 as commission and 12,828 through their own
 * stake, leaving 293,423 — 86.6% — for everyone backing them. That reframes the
 * 10% in the commission column: it is not a tenth of what an operator makes, it
 * is very nearly all of it, because the median operator has 0.8% of its own
 * exposure at stake.
 */

export interface RewardSplitChartProps {
  series: StitchedSeries | null | undefined;
  /**
   * One operator's split. Absent means the whole active set.
   *
   * Only meaningful at era resolution: the weekly rollup carries the network
   * split but no per-operator columns at all, so an address there has nothing
   * to read and the chart says so rather than drawing an empty frame.
   */
  address?: string | undefined;
  /**
   * The split as the weekly rollup supplies it, when the range is long enough
   * that `series.operators` is empty.
   */
  precomputed?: RewardSplit | undefined;
  title?: string | undefined;
  subtitle?: string | undefined;
  /** "eras" or "weeks", matching what one point actually is. */
  pointNoun?: string | undefined;
  /** Appended to the coverage line, e.g. the weekly-resolution disclosure. */
  grain?: string | null | undefined;
  height?: number;
  loading?: boolean | undefined;
  error?: Error | null | undefined;
}

export function RewardSplitChart({
  series,
  address,
  precomputed,
  title,
  subtitle,
  pointNoun = 'eras',
  grain,
  height = 300,
  loading = false,
  error,
}: RewardSplitChartProps) {
  const split = useMemo(() => {
    if (precomputed) return precomputed;
    if (!series) return null;
    if (address != null) {
      const operator = series.operators[address];
      return operator ? deriveRewardSplit(operator, series.network) : null;
    }
    if (Object.keys(series.operators).length === 0) return null;
    return deriveNetworkRewardSplit(series.operators, series.network, series.eras.length);
  }, [series, address, precomputed]);

  const segments = useMemo<StackSegment[]>(() => {
    if (!split) return [];
    // Stacked bottom-up in the order the chain pays them: commission off the
    // top first, then the remainder divided by stake. Nominators sit on top,
    // being the largest part and the one read against the axis.
    return [
      {
        id: 'commission',
        label: 'Commission',
        colour: 'var(--series-3)',
        values: split.commission,
      },
      {
        id: 'own',
        label: "Operator's own stake",
        colour: 'var(--series-2)',
        values: split.ownStake,
      },
      {
        id: 'nominators',
        label: 'Nominators',
        colour: 'var(--series-1)',
        values: split.nominators,
      },
    ];
  }, [split]);

  /** The totals, so the headline does not have to be integrated by eye. */
  const coverage = useMemo(() => {
    if (!split) return grain ?? undefined;
    const sum = (values: readonly (number | null)[]) =>
      values.reduce<number>((total, v) => total + (v ?? 0), 0);

    const gross = sum(split.gross);
    if (gross <= 0) return grain ?? undefined;

    const kept = sum(split.commission) + sum(split.ownStake);
    const polyx = (v: number) => formatPolyx(v, { compact: true });

    const headline =
      `Over this range ${polyx(gross)} was paid out: ${polyx(sum(split.commission))} in ` +
      `commission and ${polyx(sum(split.ownStake))} on the operator${address == null ? "s'" : "'s"} ` +
      `own stake, leaving ${polyx(sum(split.nominators))} for nominators — ` +
      `${((1 - kept / gross) * 100).toFixed(1)}% of the total. Commission is taken off the whole ` +
      `reward first; only what remains is divided by stake.`;

    return grain ? `${headline} Shown as ${grain}.` : headline;
  }, [split, address, grain]);

  const times = series?.eraStart ?? [];
  const polyx = (v: number | null) => (v == null ? '—' : formatPolyx(v, { compact: true }));

  return (
    <LazyChart height={height} label="Rewards paid, split by recipient">
      <LazyStackedAreaChart
        title={title ?? 'Where the rewards went'}
        subtitle={
          subtitle ??
          `Total validator payout, divided between the operators and the people backing them.`
        }
        coverage={coverage}
        times={times}
        segments={segments}
        pointNoun={pointNoun}
        format={polyx}
        tickFormat={(v: number) => formatPolyx(v, { compact: true })}
        yLabel="POLYX"
        height={height}
        loading={loading}
        error={error}
        empty={
          segments.length === 0
            ? address != null
              ? 'Per-operator rewards are only held at era resolution. Choose a shorter range.'
              : 'No reward data for this range.'
            : null
        }
      />
    </LazyChart>
  );
}
