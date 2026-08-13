'use client';

import { useMemo } from 'react';
import { useEraSeries, useLatest, useManifest, useOperators } from '@/lib/data/queries';
import { useSelectedOperators } from '@/lib/data/use-selection';
import { useResolvedRange, EraRangeControl } from '@/components/era-range-control';
import { buildOperatorRows } from '@/lib/data/operator-rows';
import { deriveOperatorApr } from '@/lib/metrics/derive';
import { rankOperators } from '@/lib/data/series';
import { buildLabeller } from '@/lib/data/operator-label';
import { OperatorsTable } from '@/components/operators-table';
import { ProductionChart } from '@/components/production-chart';
import { ReturnsChart } from '@/components/returns-chart';
import { ReturnFactorsChart } from '@/components/return-factors-chart';
import { CommissionSpread } from '@/components/commission-spread';
import { LazyChart, LazyEraSeriesChart } from '@/components/charts/lazy-chart';
import { HeadingWithTip } from '@/components/info-tip';
import { LiveToggle } from '@/components/live-toggle';
import { useLive } from '@/lib/data/use-live';
import { useEraClock } from '@/lib/data/use-era-clock';
import { ErrorState, Skeleton } from '@/components/states';
import { formatPercent, formatPolyx } from '@/lib/format';
import { outlierCap } from '@/lib/charts/notes';
import type { NamedSeries } from '@/components/charts/banded-line-chart';

/**
 * The operator directory. Table first, charts second: a ranked, filterable
 * table is how "who should I nominate?" actually gets answered. The charts
 * react to whatever is pinned in the table, so the two are one tool rather than
 * two views of the same data.
 */
export function OperatorsView() {
  const manifest = useManifest();
  const latest = useLatest();
  const registry = useOperators();
  const range = useResolvedRange(manifest.data);
  const { series, isLoading, isError, error } = useEraSeries(range);
  const { selected, selectedSet, toggle, clear, isFull, max } = useSelectedOperators();

  const erasPerYear = manifest.data?.erasPerYear ?? 365;

  // Opt-in, and never gates first paint (§6.6a). On, the two current-era
  // columns stop being a 15-minute-old snapshot and update as blocks arrive.
  const live = useLive();

  // Derived in the browser from the snapshot's anchors against the local
  // clock, so it ticks with no network traffic (§6.6a).
  const clock = useEraClock(latest.data?.eraStatus);

  const rows = useMemo(
    () =>
      buildOperatorRows({
        series,
        latest: latest.data,
        registry: registry.data,
        erasPerYear,
        livePoints: live.enabled ? live.state.eraPoints : null,
      }),
    [series, latest.data, registry.data, erasPerYear, live.enabled, live.state.eraPoints],
  );

  // What the charts draw when nothing is pinned: highest measured return over
  // the selected range, which answers the question the page is for. Not stake —
  // the election equalises exposure, so the whole field spans a few percent and
  // ranking on it is near-random. A connected wallet's nominations win over
  // both.
  const charted = useMemo(() => {
    if (selected.length > 0) return selected;
    if (!series) return [];
    return rankOperators(series, 'aprNet', 5, { erasPerYear });
  }, [selected, series, erasPerYear]);

  // Several nodes share one identity's name, so a legend needs the address to
  // tell them apart — appended only where the name is actually ambiguous.
  const nameOf = useMemo(() => buildLabeller(registry.data), [registry.data]);

  // An operator that has left the set still appears in a chart of what the
  // range paid, drawn back rather than dropped. Unknown counts as active: a
  // registry that has not loaded is not evidence that anyone has stopped.
  const statusOf = useMemo(
    () => (address: string) => registry.data?.[address]?.status ?? 'active',
    [registry.data],
  );

  const aprSeries = useMemo<NamedSeries[]>(() => {
    if (!series) return [];
    return charted.flatMap((address) => {
      const columns = series.operators[address];
      if (!columns) return [];
      const { net } = deriveOperatorApr(columns, series.network, erasPerYear);
      return [{ id: address, label: nameOf(address), values: net }];
    });
  }, [series, charted, nameOf, erasPerYear]);

  const stakeSeries = useMemo<NamedSeries[]>(() => {
    if (!series) return [];
    return charted.flatMap((address) => {
      const columns = series.operators[address];
      if (!columns) return [];
      return [{ id: address, label: nameOf(address), values: columns.totalStake }];
    });
  }, [series, charted, nameOf]);

  const band = series
    ? { lo: series.network.aprP10, mid: series.network.aprP50, hi: series.network.aprP90 }
    : undefined;

  // A ceiling for the return chart, across every series drawn: an operator's
  // first era pays a multiple of everything after it, and one such point
  // flattens the whole plot. See `operator-detail.tsx`.
  const aprCap = useMemo(
    () =>
      outlierCap(
        [
          ...aprSeries.flatMap((s) => s.values),
          ...(series?.network.aprP90 ?? []),
          ...(series?.network.avgApr ?? []),
        ],
        (v) => formatPercent(v, { decimals: 0 }),
        { because: 'in a first era' },
      ),
    [aprSeries, series],
  );

  const chartError = isError ? ((error as Error | null) ?? new Error('Unknown error')) : null;
  const percent = (v: number | null) => formatPercent(v, { decimals: 2 });
  const polyx = (v: number | null) => (v == null ? '—' : formatPolyx(v, { compact: true }));

  if (latest.isError && manifest.isError) {
    return (
      <ErrorState
        title="Could not load operators"
        message="Neither the snapshot nor the era history responded. This is usually temporary."
        onRetry={() => {
          void latest.refetch();
          void manifest.refetch();
        }}
      />
    );
  }

  const tableLoading = isLoading || latest.isLoading || registry.isLoading;

  return (
    <>
      <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
        {/* The count only. Unpinning lives in the table's control row, next to
            the ★ column it undoes, rather than in a sentence above it. */}
        <p className="m-0 text-sm" style={{ color: 'var(--text-muted)' }}>
          {selected.length > 0
            ? `${selected.length} operator${selected.length === 1 ? '' : 's'} pinned`
            : 'Pin operators with ★ to compare them in the charts below'}
        </p>
        <EraRangeControl manifest={manifest.data} />
      </div>

      {/* Framing for the table's commission column. It is the larger of the
          two levers a nominator has, and the column alone cannot say whether a
          given figure is normal. */}
      <CommissionSpread />

      <section aria-labelledby="directory-heading" className="mt-6">
        <h2 id="directory-heading" className="sr-only">
          Operator directory
        </h2>

        {tableLoading && rows.length === 0 ? (
          <Skeleton height={480} label="Loading operators" />
        ) : (
          <OperatorsTable
            rows={rows}
            selectedSet={selectedSet}
            onTogglePin={toggle}
            selectionFull={isFull}
            maxSelected={max}
            loading={tableLoading}
            rangeEras={series?.eras.length ?? null}
            eraProgress={clock?.progress ?? null}
            liveControl={<LiveToggle live={live} />}
            onClearPins={clear}
          />
        )}
      </section>

      <section aria-labelledby="comparison-heading" className="mt-12">
        <HeadingWithTip
          as="h2"
          id="comparison-heading"
          className="mb-4"
          title={selected.length > 0 ? 'Pinned operators' : 'The five highest-returning operators'}
          lead={
            selected.length > 0
              ? undefined
              : 'Pin operators with ★ in the table above to compare them here instead.'
          }
        >
          {selected.length > 0 ? (
            <>
              Shown against the whole field, so a line can be read in context rather than in
              isolation. Each operator keeps its colour across every page of the site.
            </>
          ) : (
            <>
              Ranked by their typical era&rsquo;s return after commission, over the era range
              selected above. Ranking by <em>stake</em> would tell you little on Polymesh: the
              election spreads stake almost evenly, so the whole active set sits within a few
              percent of each other.
            </>
          )}
        </HeadingWithTip>

        <div className="flex flex-col gap-4">
          <LazyChart height={320} label="Operator return">
            <LazyEraSeriesChart
              title="Return, after commission"
              subtitle="How do these operators compare with the field?"
              offerLogScale
              cap={aprCap}
              series={series}
              operators={aprSeries}
              band={band}
              reference={
                series ? { values: series.network.avgApr, label: 'Network average' } : undefined
              }
              format={percent}
              tickFormat={(v) => formatPercent(v, { decimals: 0 })}
              yLabel="APR"
              loading={isLoading}
              error={chartError}
              onRemoveOperator={selected.length > 0 ? toggle : undefined}
            />
          </LazyChart>

          <LazyChart height={280} label="Operator stake">
            <LazyEraSeriesChart
              title="Stake backing each operator"
              subtitle="Is stake flowing toward or away from them?"
              series={series}
              operators={stakeSeries}
              format={polyx}
              tickFormat={(v) => formatPolyx(v, { compact: true })}
              yLabel="POLYX"
              height={280}
              loading={isLoading}
              error={chartError}
              onRemoveOperator={selected.length > 0 ? toggle : undefined}
            />
          </LazyChart>
        </div>
      </section>

      <section aria-labelledby="earned-heading" className="mt-12">
        <HeadingWithTip
          as="h2"
          id="earned-heading"
          className="mb-4"
          title="What each operator paid"
        >
          The return a nominator actually received, over the era range selected above. Three things
          move it: how many blocks the operator produced, what commission it charged, and how much
          stake it was sharing the reward with. Each operator is measured over the eras it was
          elected — in an era it sits out, the election moves your stake to your other choices, so
          it costs you nothing.
        </HeadingWithTip>

        <ReturnsChart
          series={series}
          erasPerYear={erasPerYear}
          nameOf={nameOf}
          statusOf={statusOf}
          selected={selected}
          loading={isLoading}
          error={chartError}
        />
      </section>

      <section aria-labelledby="factors-heading" className="mt-12">
        <HeadingWithTip
          as="h2"
          id="factors-heading"
          className="mb-4"
          title="What explains the difference"
        >
          The same operators as above, with the gap between them broken into its causes. Two of the
          three last: an operator&rsquo;s block production and its commission are much the same
          month to month. The third — how much stake it is sharing the reward with — is the widest
          of them and the least repeatable, because the election rebalances it and because
          nominating an under-staked operator is itself what removes the advantage. It is drawn
          faintly for that reason, and left out of the default ordering — which the Sort control
          names, and can change.
        </HeadingWithTip>

        <ReturnFactorsChart
          series={series}
          erasPerYear={erasPerYear}
          nameOf={nameOf}
          statusOf={statusOf}
          selected={selected}
          loading={isLoading}
          error={chartError}
        />
      </section>

      <section aria-labelledby="production-heading" className="mt-12">
        <HeadingWithTip as="h2" id="production-heading" className="mb-4" title="Block production">
          The part of that return the operator actually controls. Every validator is offered roughly
          the same number of slots regardless of stake, so what separates them is how many of those
          slots they fill. The differences are small, and most of what looks like a difference is
          luck — the shaded band is how much.
        </HeadingWithTip>

        <ProductionChart
          series={series}
          nameOf={nameOf}
          statusOf={statusOf}
          selected={selected}
          loading={isLoading}
          error={chartError}
        />
      </section>
    </>
  );
}
