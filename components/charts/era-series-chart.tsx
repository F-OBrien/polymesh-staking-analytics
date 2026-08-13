'use client';

import { useMemo, useState } from 'react';
import { ChartFrame } from './chart-frame';
import { MAX_NAMED_SERIES } from '@/lib/charts/palette';
import { BandedLineChart, type NamedSeries } from './banded-line-chart';
import { Legend, type LegendItem } from './legend';
import { SeriesTable, type SeriesTableColumn } from './series-table';
import { EmptyState } from '@/components/states';
import { interiorGaps } from '@/lib/charts/geometry';
import { formatEraDate } from '@/lib/format';
import type { StitchedSeries } from '@/lib/data/series';

/**
 * A complete era-series chart: frame, band, selected operators, legend, table.
 * One composition every page reuses, so the design doc's rules — a stated
 * question, a legend, a table view, stated coverage, a capped series count —
 * are enforced once rather than remembered five times.
 */

/** Stable empty array, so absent data does not churn referential equality. */
const NO_VALUES: readonly number[] = [];

export interface EraSeriesChartProps {
  title: string;
  subtitle?: string | undefined;
  series: StitchedSeries | null;
  /** Per-operator values, already derived. Order sets palette slots. */
  operators: readonly NamedSeries[];
  /** p10/p50/p90 across all operators, for the context band. */
  band?:
    | {
        lo: readonly (number | null)[];
        mid: readonly (number | null)[];
        hi: readonly (number | null)[];
      }
    | undefined;
  reference?: { values: readonly (number | null)[]; label: string } | undefined;
  format: (value: number | null) => string;
  /** Terser formatter for axis ticks; falls back to `format`. */
  tickFormat?: ((value: number) => string) | undefined;
  yLabel?: string | undefined;
  height?: number;
  includeZero?: boolean;
  /**
   * Appended to the coverage line: anything needed to read the plot correctly
   * rather than to know what it covers — chiefly `axisRangeNote`. Null is
   * accepted so a caller can pass that helper's result straight through.
   */
  note?: string | null | undefined;
  /**
   * What one point on the x axis is, when it is not an era. The weekly rollup
   * feeds this chart a few hundred buckets spanning far more eras, so calling
   * them eras would understate the history. Only the caller knows the
   * resolution.
   */
  pointNoun?: string | undefined;
  /**
   * An axis ceiling and the sentence that must accompany it, as one value
   * rather than a separate `yMax` and `note` — the two are only ever true
   * together, and on a log axis nothing is clipped, so a note about clipped
   * points would describe a chart the reader is not looking at. See
   * `outlierCap`.
   */
  cap?: { max: number; note: string } | null | undefined;
  /**
   * Offers a linear/log switch above the plot, starting on `linear`. Only for
   * data that actually spans orders of magnitude — otherwise the two views are
   * identical and the control is one more thing to read.
   */
  offerLogScale?: boolean | undefined;
  loading?: boolean | undefined;
  error?: Error | null | undefined;
  onRetry?: (() => void) | undefined;
  actions?: React.ReactNode;
  /** Called when a legend entry's remove button is used. */
  onRemoveOperator?: ((id: string) => void) | undefined;
}

export function EraSeriesChart({
  title,
  subtitle,
  series,
  operators,
  band,
  reference,
  format,
  tickFormat,
  yLabel,
  height = 320,
  includeZero = false,
  note,
  pointNoun = 'eras',
  cap,
  offerLogScale = false,
  loading,
  error,
  onRetry,
  actions,
  onRemoveOperator,
}: EraSeriesChartProps) {
  const [scaleType, setScaleType] = useState<'linear' | 'log'>('linear');

  // A module-level constant, not an inline `[]`: a fresh reference each render
  // would invalidate the memos below and defeat them.
  const eras = series?.eras ?? NO_VALUES;
  const eraStart = series?.eraStart ?? NO_VALUES;

  // Coverage is stated, never implied — a chart silently showing 40 eras when
  // 90 were asked for is worse than one that says so.
  const coverage = useMemo(() => {
    if (eras.length === 0) return note ?? undefined;
    const from = formatEraDate(eraStart[0], { withYear: true });
    const to = formatEraDate(eraStart.at(-1), { withYear: true });
    const span = `${eras.length} ${pointNoun} · ${from} – ${to}`;
    // A log axis has to be declared: equal vertical distances are equal
    // *ratios*, so a reader assuming linear misreads every gap. Joined with a
    // separator and stripped of trailing full stops, so the line reads as a
    // list of facts — each wrapped line pushes the plot further down.
    return [span, note, cap?.note, scaleType === 'log' ? 'Log scale' : null]
      .filter(Boolean)
      .map((part) => String(part).trim().replace(/\.$/, ''))
      .join(' · ');
  }, [eras.length, eraStart, note, pointNoun, scaleType, cap]);

  const legendItems = useMemo<LegendItem[]>(() => {
    const items: LegendItem[] = operators.slice(0, MAX_NAMED_SERIES).map((op) => ({
      id: op.id,
      label: op.label,
      variant: 'solid' as const,
      onRemove: onRemoveOperator ? () => onRemoveOperator(op.id) : undefined,
    }));

    // Context layers are listed last and visually distinguished, so they read
    // as background rather than as two more operators.
    if (band) {
      items.push({
        id: '__band',
        label: 'All operators (10th–90th percentile)',
        variant: 'band',
        colour: 'var(--band-fill)',
      });
      items.push({
        id: '__median',
        label: 'Median',
        variant: 'dashed',
        colour: 'var(--series-other)',
      });
    }
    if (reference) {
      items.push({
        id: '__reference',
        label: reference.label,
        variant: 'dashed',
        colour: 'var(--text-secondary)',
      });
    }

    // Only when something is actually drawn, and tested with `interiorGaps` —
    // the same test the plot marks from. Asking merely whether any value is
    // null would caption eras before an operator existed, which are not marked.
    if (operators.some((op) => interiorGaps(op.values).length > 0)) {
      items.push({
        id: '__gaps',
        label: 'Shaded: that operator dropped out of the set, so earned nothing',
        variant: 'band',
        colour: 'var(--series-other-alpha)',
      });
    }

    return items;
  }, [operators, band, reference, onRemoveOperator]);

  const tableColumns = useMemo<SeriesTableColumn[]>(() => {
    const columns: SeriesTableColumn[] = operators.map((op) => ({
      key: op.id,
      label: op.label,
      values: op.values,
      format,
    }));
    if (reference) {
      columns.push({
        key: '__reference',
        label: reference.label,
        values: reference.values,
        format,
      });
    }
    if (band) {
      columns.push({ key: '__p10', label: 'p10', values: band.lo, format });
      columns.push({ key: '__p50', label: 'Median', values: band.mid, format });
      columns.push({ key: '__p90', label: 'p90', values: band.hi, format });
    }
    return columns;
  }, [operators, reference, band, format]);

  const isEmpty = !loading && !error && eras.length === 0;

  const scaleControl = offerLogScale ? (
    <div
      role="group"
      aria-label="Value axis scale"
      className="flex items-center gap-0.5 rounded-full border p-0.5 text-xs"
      style={{ borderColor: 'var(--border)' }}
    >
      {(['linear', 'log'] as const).map((option) => {
        const on = option === scaleType;
        return (
          <button
            key={option}
            type="button"
            onClick={() => setScaleType(option)}
            aria-pressed={on}
            className="rounded-full px-2 py-0.5 capitalize transition-colors"
            style={{
              color: on ? 'var(--text-primary)' : 'var(--text-muted)',
              background: on ? 'var(--surface-2)' : 'transparent',
              fontWeight: on ? 600 : 400,
            }}
          >
            {option}
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      coverage={coverage}
      actions={
        scaleControl ? (
          <div className="flex items-center gap-2">
            {actions}
            {scaleControl}
          </div>
        ) : (
          actions
        )
      }
      height={height}
      loading={loading}
      error={error}
      onRetry={onRetry}
      legend={<Legend items={legendItems} />}
      empty={
        isEmpty ? (
          <EmptyState
            title="No data for this range"
            message="History accumulates daily. Try a shorter range, or check back once more eras have been recorded."
          />
        ) : undefined
      }
      table={<SeriesTable caption={title} eras={eras} eraStart={eraStart} columns={tableColumns} />}
    >
      <>
        <BandedLineChart
          eras={eras}
          eraStart={eraStart}
          series={operators}
          band={band ? { ...band, label: '10th–90th percentile of all operators' } : undefined}
          reference={reference}
          format={format}
          tickFormat={tickFormat}
          yLabel={yLabel}
          height={height}
          includeZero={includeZero}
          yMax={cap?.max}
          scaleType={scaleType}
        />
        {/* A second, visually-hidden copy of the table, so a screen reader
            reaches the data without having to find and operate the tab. */}
        <SeriesTable
          hidden
          caption={`${title} — data table`}
          eras={eras}
          eraStart={eraStart}
          columns={tableColumns}
          maxRows={120}
        />
      </>
    </ChartFrame>
  );
}
