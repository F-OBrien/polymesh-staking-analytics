'use client';

import { useMemo, useState } from 'react';
import { summariseReturns, type ReturnRecord } from '@/lib/metrics/returns';
import { SERIES_TOKENS } from '@/lib/charts/palette';
import { formatPercent } from '@/lib/format';
import { LazyChart, LazyContributionChart } from '@/components/charts/lazy-chart';
import type { ContributionItem } from '@/components/charts/contribution-chart';
import {
  filterOperators,
  OperatorStatusFilter,
  type StatusFilter,
} from '@/components/operator-status-filter';
import type { StitchedSeries } from '@/lib/data/series';
import type { OperatorStatus } from '@/lib/schemas/data';

/**
 * Why each operator paid what it did — the chart above says how much, this says
 * what made it so. The return decomposes exactly into blocks produced,
 * commission charged and the stake the reward was shared with, and a
 * logarithmic-mean split turns that multiplicative identity into parts that
 * *add*, so the bars are an attribution rather than an illustration.
 *
 * The order is a control rather than a convention: this plots three values and
 * sorts by a fourth, so unlike the single-value charts above it nothing
 * visibly descends and the order would otherwise read as arbitrary.
 *
 * It defaults to what persists, not what was earned. Across eras 1600–1750,
 * commission repeats at r = 0.997 and production at r = 0.618, while the stake
 * advantage manages r = 0.288 and mean-reverts at r = −0.973 — and it is the
 * widest of the three, so ranking on the total sorts the field mostly by the
 * term that will not be there next month. The stake band is drawn at half
 * weight for the same reason.
 */

/** The colours, in stacking order. Stake last so it reads as the addendum. */
const FACTORS = [
  { key: 'production', label: 'Block production', colour: 'var(--series-1)' },
  { key: 'commission', label: 'Commission', colour: 'var(--series-3)' },
  { key: 'stake', label: 'Stake shared with', colour: 'var(--series-2)' },
] as const;

/**
 * How the field is ordered. `durable` is the default, per the note above; `net`
 * aligns this chart bar-for-bar with the return chart, for comparing the two.
 */
const SORTS = [
  { key: 'durable', label: 'What lasts', describe: 'the part of the return that lasts' },
  { key: 'net', label: 'Net effect', describe: 'net effect, matching the chart above' },
  { key: 'production', label: 'Block production', describe: 'block production' },
  { key: 'commission', label: 'Commission', describe: 'commission' },
  { key: 'stake', label: 'Stake shared with', describe: 'the stake shared with' },
] as const;

type FactorSort = (typeof SORTS)[number]['key'];

export interface ReturnFactorsChartProps {
  series: StitchedSeries | null | undefined;
  erasPerYear: number;
  nameOf: (address: string) => string;
  statusOf: (address: string) => OperatorStatus;
  selected: readonly string[];
  selectionNoun?: string | undefined;
  height?: number;
  loading?: boolean | undefined;
  error?: Error | null | undefined;
}

export function ReturnFactorsChart({
  series,
  erasPerYear,
  nameOf,
  statusOf,
  selected,
  selectionNoun,
  height = 320,
  loading = false,
  error,
}: ReturnFactorsChartProps) {
  const [status, setStatus] = useState<StatusFilter>('active');
  const [sort, setSort] = useState<FactorSort>('durable');

  const summary = useMemo(() => {
    if (!series) return null;
    return summariseReturns({
      eras: series.eras,
      network: series.network,
      operators: series.operators,
      erasPerYear,
    });
  }, [series, erasPerYear]);

  const items = useMemo<(ContributionItem & { status: OperatorStatus })[]>(() => {
    if (!summary || summary.records.length === 0) return [];

    // Each factor is centred on the field's average of it, so a bar reads as
    // "how this operator differed" rather than "Polymesh charges commission".
    // Summing the centred parts gives each operator's excess over the field
    // across its *own* eras, which is also the fairer comparison — it does not
    // charge an operator for having been present only while the network paid
    // less.
    const mean = (pick: (r: ReturnRecord) => number) =>
      summary.records.reduce((total, r) => total + pick(r), 0) / summary.records.length;
    const centre = {
      production: mean((r) => r.contribution.production),
      commission: mean((r) => r.contribution.commission),
      stake: mean((r) => r.contribution.stake),
    };

    const slotOf = new Map(selected.map((address, i) => [address, i]));

    return summary.records
      .map((record) => {
        const operatorStatus = statusOf(record.address);
        const slot = slotOf.get(record.address);
        const segments = FACTORS.map((factor) => ({
          key: factor.key,
          label: factor.label,
          colour: factor.colour,
          value: record.contribution[factor.key] - centre[factor.key],
          provisional: factor.key === 'stake',
        }));

        return {
          id: record.address,
          status: operatorStatus,
          label:
            operatorStatus === 'inactive'
              ? `${nameOf(record.address)} (no longer running)`
              : nameOf(record.address),
          segments,
          // Exactly the sum of the parts, by construction — never a separately
          // computed total that could disagree with the bars drawn above it.
          net: segments.reduce((total, s) => total + s.value, 0),
          muted: operatorStatus === 'inactive',
          detail: `${record.eras} eras · ${formatPercent(record.netApr, { decimals: 2 })} after commission`,
          highlight: slot != null && slot < SERIES_TOKENS.length ? SERIES_TOKENS[slot] : undefined,
          durable: record.durable,
        };
      })
      .sort((a, b) => sortValue(b, sort) - sortValue(a, sort));
  }, [summary, selected, nameOf, statusOf, sort]);

  const pinned = useMemo(() => new Set(selected), [selected]);
  const visible = useMemo(() => filterOperators(items, status, pinned), [items, status, pinned]);

  const hiddenPinned = useMemo(() => {
    const shown = new Set(visible.map((item) => item.id));
    return items.filter((item) => pinned.has(item.id) && !shown.has(item.id)).length;
  }, [items, pinned, visible]);

  const coverage = useMemo(() => {
    if (!summary || items.length === 0) return undefined;
    const shown =
      visible.length === items.length
        ? `${items.length} operators`
        : `showing ${visible.length} of ${items.length} operators`;

    const spread = (key: (typeof FACTORS)[number]['key']) => {
      const values = items.map((i) => i.segments.find((s) => s.key === key)?.value ?? 0);
      return Math.sqrt(values.reduce((a, b) => a + b * b, 0) / values.length);
    };

    const order = SORTS.find((s) => s.key === sort)?.describe ?? sort;
    return (
      `${summary.eras} eras, ${shown}, ordered by ${order}. ` +
      `Across the field the three factors move a return by ` +
      `±${formatPercent(spread('production'), { decimals: 2 })} (production), ` +
      `±${formatPercent(spread('commission'), { decimals: 2 })} (commission) and ` +
      `±${formatPercent(spread('stake'), { decimals: 2 })} (stake). ` +
      `Stake is the widest and the least repeatable, which is why it is drawn faintly ` +
      `and kept out of the ordering.`
    );
  }, [summary, items, visible.length, sort]);

  const signed = (value: number) => formatPercent(value, { decimals: 2, signed: true });

  return (
    <LazyChart height={height} label="What explains each operator's return">
      <LazyContributionChart
        title="What explains the difference"
        subtitle={`Each bar is one operator, split into the three things that move a return. The line is the net, and the field is ordered by ${SORTS.find((option) => option.key === sort)?.label.toLowerCase() ?? sort}.`}
        coverage={coverage}
        items={visible}
        legendKeys={FACTORS}
        format={signed}
        tickFormat={(v: number) => formatPercent(v, { decimals: 1, signed: true })}
        yLabel="Effect on return"
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <label className="sr-only" htmlFor="factors-sort">
              Sort operators by
            </label>
            <select
              id="factors-sort"
              className="rounded-md border px-2 py-1 text-sm"
              style={{
                borderColor: 'var(--border)',
                background: 'var(--surface)',
                color: 'var(--text-primary)',
              }}
              value={sort}
              onChange={(event) => setSort(event.target.value as FactorSort)}
            >
              {SORTS.map((option) => (
                <option key={option.key} value={option.key}>
                  Sort: {option.label}
                </option>
              ))}
            </select>
            <OperatorStatusFilter
              id="factors-status"
              value={status}
              onChange={setStatus}
              hidden={items.length - visible.length}
              hiddenPinned={hiddenPinned}
              showPinnedOption={pinned.size > 0}
              {...(selectionNoun ? { selectionNoun } : {})}
            />
          </div>
        }
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
 * The quantity the field is ordered by. Reads the *drawn* segment values rather
 * than the record behind them, so sorting by a factor makes exactly the band
 * the reader sees descend monotonically.
 */
function sortValue(item: ContributionItem & { durable: number }, sort: FactorSort): number {
  if (sort === 'durable') return item.durable;
  if (sort === 'net') return item.net;
  return item.segments.find((segment) => segment.key === sort)?.value ?? 0;
}
