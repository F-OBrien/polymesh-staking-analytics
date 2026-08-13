'use client';

import { useId, useMemo, useRef, useState } from 'react';
import {
  bandPath,
  nearestIndex,
  plotBox,
  responsiveMargin,
  timeScale,
  valueScale,
} from '@/lib/charts/geometry';
import { useMeasuredWidth } from '@/lib/charts/use-measure';
import { formatEraDate } from '@/lib/format';
import { Grid, XAxis, YAxis } from './axes';
import { ChartFrame, useChartHeight } from './chart-frame';
import { Legend, type LegendItem } from './legend';

/**
 * A quantity over time, divided into parts that sum to the whole.
 *
 * This was bars first, and bars were wrong. A bar chart says "these are
 * discrete events you might compare one against the next", which is true of
 * thirty eras and a lie about 1,748 of them: past a few hundred the bars become
 * hairlines separated by gaps of background, and the reader is left comparing
 * the white space. Rewards paid per era are a continuous flow, and an area
 * reads as one.
 *
 * **Absolute, never normalised to 100%.** A percentage stack would answer "what
 * proportion went to nominators" and destroy "how much" in the process, which
 * is the information a chart denominated in tokens exists to add to a site that
 * is otherwise all rates.
 */

export interface StackSegment {
  id: string;
  label: string;
  colour: string;
  /** One value per period, bottom segment first. */
  values: readonly (number | null)[];
}

export interface StackedAreaChartProps {
  /** Unix seconds, one per period, ascending. */
  times: readonly number[];
  /** Stacked bottom to top in the order given. */
  segments: readonly StackSegment[];
  title: string;
  subtitle?: string | undefined;
  coverage?: string | undefined;
  actions?: React.ReactNode;
  yLabel?: string | undefined;
  /** What one period is called in the readout — "eras" or "weeks". */
  pointNoun?: string;
  format: (value: number | null) => string;
  tickFormat?: ((value: number) => string) | undefined;
  height?: number;
  loading?: boolean | undefined;
  error?: Error | null | undefined;
  empty?: React.ReactNode;
}

export function StackedAreaChart({
  times,
  segments,
  title,
  subtitle,
  coverage,
  actions,
  yLabel,
  pointNoun = 'periods',
  format,
  tickFormat,
  height: requestedHeight = 300,
  loading = false,
  error,
  empty,
}: StackedAreaChartProps) {
  const legend = useMemo<LegendItem[]>(
    // Top-down, so the legend reads in the order the bands appear rather than
    // the order they are drawn.
    () => [...segments].reverse().map((s) => ({ id: s.id, label: s.label, colour: s.colour })),
    [segments],
  );

  const totals = useMemo(() => stackTotals(segments, times.length), [segments, times.length]);

  const table = (
    <table
      className="w-full border-collapse text-sm"
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      <caption className="sr-only">{title}, as a table</caption>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th scope="col" className="p-2 text-left font-medium">
            Date
          </th>
          {segments.map((segment) => (
            <th key={segment.id} scope="col" className="p-2 text-right font-medium">
              {segment.label}
            </th>
          ))}
          <th scope="col" className="p-2 text-right font-medium">
            Total
          </th>
        </tr>
      </thead>
      <tbody>
        {times.map((time, i) => (
          <tr key={time} style={{ borderTop: '1px solid var(--border)' }}>
            <th scope="row" className="p-2 text-left font-normal">
              {formatEraDate(time)}
            </th>
            {segments.map((segment) => (
              <td key={segment.id} className="p-2 text-right">
                {format(segment.values[i] ?? null)}
              </td>
            ))}
            <td className="p-2 text-right">{format(totals[i] ?? null)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );

  return (
    <ChartFrame
      title={title}
      subtitle={subtitle}
      coverage={coverage}
      actions={actions}
      legend={<Legend items={legend} />}
      height={requestedHeight}
      loading={loading}
      error={error}
      empty={empty}
      table={table}
    >
      <StackedPlot
        times={times}
        segments={segments}
        totals={totals}
        title={title}
        yLabel={yLabel}
        pointNoun={pointNoun}
        format={format}
        tickFormat={tickFormat}
        requestedHeight={requestedHeight}
      />
    </ChartFrame>
  );
}

/** Sits inside the frame, so `useChartHeight` reads the expanded height. */
function StackedPlot({
  times,
  segments,
  totals,
  title,
  yLabel,
  pointNoun,
  format,
  tickFormat,
  requestedHeight,
}: Pick<
  StackedAreaChartProps,
  'times' | 'segments' | 'title' | 'yLabel' | 'format' | 'tickFormat'
> & {
  totals: (number | null)[];
  pointNoun: string;
  requestedHeight: number;
}) {
  const titleId = useId();
  const [containerRef, measuredWidth] = useMeasuredWidth<HTMLDivElement>();
  const svgRef = useRef<SVGSVGElement>(null);
  const [focus, setFocus] = useState<number | null>(null);

  const height = useChartHeight(requestedHeight);
  const width = measuredWidth ?? 0;
  const box = plotBox(width, height, { ...responsiveMargin(width), right: 16 });

  const x = useMemo(() => timeScale(times, box.innerWidth), [times, box.innerWidth]);
  /**
   * Zero-based, always, and not a caller's choice.
   *
   * `valueScale` fits the data by default, which is right for the rate charts
   * that make up most of this kit and wrong for anything whose *height* is the
   * value. Fitted to the stack totals rather than to any one band, since a
   * domain fitted to the largest part would clip the stack at its top.
   */
  const y = useMemo(
    () => valueScale([totals], box.innerHeight, { includeZero: true, min: 0 }),
    [totals, box.innerHeight],
  );

  const xs = useMemo(() => times.map((t) => x(new Date(t * 1000))), [times, x]);

  /**
   * One path per band, each running from the running total below it to the
   * running total including it.
   *
   * Built from a single cumulative pass so adjacent bands share their boundary
   * exactly: the top edge of one is the same sequence of points as the bottom
   * edge of the next, which is what stops a hairline of background showing
   * between them at fractional pixel positions.
   */
  const paths = useMemo(() => {
    const running = times.map(() => 0);
    return segments.map((segment) => {
      const points = times.map((_, i) => {
        const value = segment.values[i];
        // A null anywhere in the stack breaks every band at that index rather
        // than letting the ones above slump onto the axis.
        if (value == null || totals[i] == null) return { x: xs[i] as number, lo: null, hi: null };
        const lo = running[i] as number;
        const hi = lo + value;
        running[i] = hi;
        return { x: xs[i] as number, lo: y(lo), hi: y(hi) };
      });
      return { id: segment.id, colour: segment.colour, d: bandPath(points) };
    });
  }, [segments, times, xs, y, totals]);

  const focused = focus != null ? focus : null;

  return (
    <div ref={containerRef} className="w-full">
      {width > 0 ? (
        <>
          <svg
            ref={svgRef}
            width={width}
            height={height}
            role="img"
            aria-labelledby={titleId}
            className="block overflow-visible"
            onMouseLeave={() => setFocus(null)}
            onMouseMove={(event) => {
              const rect = svgRef.current?.getBoundingClientRect();
              if (!rect) return;
              setFocus(nearestIndex(xs, event.clientX - rect.left - box.margin.left));
            }}
          >
            <title id={titleId}>{`${title}. ${times.length} ${pointNoun}.`}</title>

            <g transform={`translate(${box.margin.left}, ${box.margin.top})`}>
              <Grid box={box} yScale={y} />
              {paths.map((path) => (
                <path key={path.id} d={path.d} fill={path.colour} />
              ))}
              <YAxis box={box} scale={y} format={tickFormat ?? ((v) => format(v))} label={yLabel} />
              <XAxis box={box} scale={x} />

              {focused != null && xs[focused] != null ? (
                <line
                  x1={xs[focused]}
                  x2={xs[focused]}
                  y1={0}
                  y2={box.innerHeight}
                  stroke="var(--axis)"
                  strokeWidth={1}
                  shapeRendering="crispEdges"
                  pointerEvents="none"
                />
              ) : null}
            </g>
          </svg>

          <p
            className="mt-1 mb-0 text-xs"
            style={{ color: 'var(--text-secondary)', minHeight: '1.25rem' }}
            aria-live="polite"
          >
            {focused != null
              ? `${formatEraDate(times[focused] as number)}: ${segments
                  .map((s) => `${s.label} ${format(s.values[focused] ?? null)}`)
                  .join(' · ')} · total ${format(totals[focused] ?? null)}`
              : ''}
          </p>
        </>
      ) : (
        // Reserves height before the container is measured, so nothing shifts.
        <div style={{ height }} />
      )}
    </div>
  );
}

function stackTotals(segments: readonly StackSegment[], length: number): (number | null)[] {
  const totals: (number | null)[] = Array.from({ length }, () => null);
  for (const segment of segments) {
    for (let i = 0; i < length; i += 1) {
      const value = segment.values[i];
      if (value == null) continue;
      totals[i] = (totals[i] ?? 0) + value;
    }
  }
  return totals;
}
