'use client';

import { useId, useMemo, useState } from 'react';
import { plotBox, responsiveMargin, valueScale } from '@/lib/charts/geometry';
import { useMeasuredWidth } from '@/lib/charts/use-measure';
import { Grid, YAxis } from './axes';
import { ChartFrame, useChartHeight } from './chart-frame';
import { Legend, type LegendItem } from './legend';

/**
 * A field of categories, each broken into signed parts that sum to its total.
 * Where `DeviationChart` asks "is this one outside the noise?", this asks what
 * made it so. Positive parts stack up from the baseline and negative parts
 * down, with a tick marking the net — which is not where either stack ends,
 * since a category can be pushed both ways at once.
 *
 * The parts must genuinely sum to the net; callers build them with a
 * logarithmic-mean split (see `lib/metrics/returns.ts`). A stacked chart whose
 * parts only approximate the total teaches the reader to distrust the
 * arithmetic.
 */

export interface ContributionSegment {
  key: string;
  label: string;
  colour: string;
  value: number;
  /**
   * Draw this part as provisional — for a factor that is real but does not
   * persist, so a tall bar built from it cannot be mistaken for a durable one.
   */
  provisional?: boolean;
}

export interface ContributionItem {
  id: string;
  label: string;
  /** Signed parts. Their sum must equal `net`. */
  segments: readonly ContributionSegment[];
  net: number;
  detail?: string;
  /** Palette colour when pinned; drawn as an outline so the parts stay visible. */
  highlight?: string | undefined;
  /** Drawn back, for a category that is no longer a live choice. */
  muted?: boolean | undefined;
}

export interface ContributionChartProps {
  items: readonly ContributionItem[];
  title: string;
  subtitle?: string | undefined;
  coverage?: string | undefined;
  actions?: React.ReactNode;
  yLabel?: string | undefined;
  /** Names the factors in the legend, in stacking order. */
  legendKeys: readonly { key: string; label: string; colour: string }[];
  format: (value: number) => string;
  tickFormat?: ((value: number) => string) | undefined;
  height?: number;
  loading?: boolean | undefined;
  error?: Error | null | undefined;
  empty?: React.ReactNode;
}

/** Below this the bars are hairlines and hovering one is a coin toss. */
const MIN_SLOT = 3;

export function ContributionChart({
  items,
  title,
  subtitle,
  coverage,
  actions,
  yLabel,
  legendKeys,
  format,
  tickFormat,
  height: requestedHeight = 320,
  loading = false,
  error,
  empty,
}: ContributionChartProps) {
  const legend = useMemo<LegendItem[]>(
    () => [
      ...legendKeys.map((k) => ({ id: k.key, label: k.label, colour: k.colour })),
      { id: 'net', label: 'Net effect', variant: 'solid' as const, colour: 'var(--text-primary)' },
    ],
    [legendKeys],
  );

  const table = (
    <table
      className="w-full border-collapse text-sm"
      style={{ fontVariantNumeric: 'tabular-nums' }}
    >
      <caption className="sr-only">{title}, as a table</caption>
      <thead>
        <tr style={{ borderBottom: '1px solid var(--border)' }}>
          <th scope="col" className="p-2 text-left font-medium">
            #
          </th>
          <th scope="col" className="p-2 text-left font-medium">
            Name
          </th>
          {legendKeys.map((k) => (
            <th key={k.key} scope="col" className="p-2 text-right font-medium">
              {k.label}
            </th>
          ))}
          <th scope="col" className="p-2 text-right font-medium">
            Net
          </th>
        </tr>
      </thead>
      <tbody>
        {items.map((item, i) => (
          <tr
            key={item.id}
            style={{
              borderTop: '1px solid var(--border)',
              ...(item.muted ? { color: 'var(--text-muted)' } : {}),
            }}
          >
            <td className="p-2 text-left" style={{ color: 'var(--text-muted)' }}>
              {i + 1}
            </td>
            <th scope="row" className="p-2 text-left font-normal">
              {item.label}
            </th>
            {legendKeys.map((k) => (
              <td key={k.key} className="p-2 text-right">
                {format(item.segments.find((s) => s.key === k.key)?.value ?? 0)}
              </td>
            ))}
            <td className="p-2 text-right">{format(item.net)}</td>
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
      <ContributionPlot
        items={items}
        title={title}
        yLabel={yLabel}
        format={format}
        tickFormat={tickFormat}
        requestedHeight={requestedHeight}
      />
    </ChartFrame>
  );
}

/** Sits inside the frame, so `useChartHeight` reads the expanded height. */
function ContributionPlot({
  items,
  title,
  yLabel,
  format,
  tickFormat,
  requestedHeight,
}: Pick<ContributionChartProps, 'items' | 'title' | 'yLabel' | 'format' | 'tickFormat'> & {
  requestedHeight: number;
}) {
  const titleId = useId();
  const [containerRef, measuredWidth] = useMeasuredWidth<HTMLDivElement>();
  const [focus, setFocus] = useState<number | null>(null);

  const height = useChartHeight(requestedHeight);
  const width = measuredWidth ?? 0;
  const margin = responsiveMargin(width);
  const box = plotBox(width, height, { ...margin, right: 16, bottom: 12 });

  /**
   * Stacked extents, not the raw values: the domain has to reach the top of the
   * upward stack and the bottom of the downward one. Fitting it to the parts,
   * or to the net, clips every bar whose factors pull in opposite directions.
   */
  const y = useMemo(() => {
    const highs: number[] = [];
    const lows: number[] = [];
    for (const item of items) {
      let up = 0;
      let down = 0;
      for (const segment of item.segments) {
        if (segment.value >= 0) up += segment.value;
        else down += segment.value;
      }
      highs.push(up);
      lows.push(down);
    }
    return valueScale([highs, lows, [0]], box.innerHeight);
  }, [items, box.innerHeight]);

  const slot = items.length > 0 ? box.innerWidth / items.length : 0;
  const barWidth = Math.max(1, slot * 0.8);
  const centre = (i: number) => slot * (i + 0.5);

  const focused = focus != null ? items[focus] : null;
  const zero = y(0);

  return (
    <div ref={containerRef} className="w-full">
      {width > 0 ? (
        <>
          <svg
            width={width}
            height={height}
            role="img"
            aria-labelledby={titleId}
            className="block overflow-visible"
            onMouseLeave={() => setFocus(null)}
          >
            <title id={titleId}>{`${title}. ${items.length} operators.`}</title>

            <g transform={`translate(${box.margin.left}, ${box.margin.top})`}>
              <Grid box={box} yScale={y} />
              <YAxis box={box} scale={y} format={tickFormat ?? format} label={yLabel} />

              {items.map((item, i) => {
                const x = centre(i) - barWidth / 2;
                // Two running totals, so a part pulling the other way starts
                // from the baseline rather than the far end of the stack.
                let up = 0;
                let down = 0;
                return (
                  <g
                    key={item.id}
                    opacity={focus == null || focus === i ? (item.muted ? 0.55 : 1) : 0.35}
                  >
                    {item.segments.map((segment) => {
                      if (segment.value === 0) return null;
                      const from = segment.value >= 0 ? up : down;
                      const to = from + segment.value;
                      if (segment.value >= 0) up = to;
                      else down = to;
                      const top = Math.min(y(from), y(to));
                      return (
                        <rect
                          key={segment.key}
                          x={x}
                          y={top}
                          width={barWidth}
                          height={Math.max(0.5, Math.abs(y(to) - y(from)))}
                          fill={segment.colour}
                          // Reduced weight rather than a different hue: the
                          // same kind of quantity, just one that will not last.
                          opacity={segment.provisional ? 0.5 : 1}
                        />
                      );
                    })}

                    {/* The net, which is neither end of the stack.
                        Overhangs the bar and is drawn in the text colour, not
                        the axis grey: inside the bar and at axis weight it was
                        indistinguishable from the seam between two segments,
                        which made the one mark the reader is told to read the
                        hardest one to find. */}
                    <line
                      x1={x - 1.5}
                      x2={x + barWidth + 1.5}
                      y1={y(item.net)}
                      y2={y(item.net)}
                      stroke="var(--text-primary)"
                      strokeWidth={2}
                      shapeRendering="crispEdges"
                    />

                    {item.highlight ? (
                      <rect
                        x={x - 0.5}
                        y={Math.min(y(up), y(down)) - 1}
                        width={barWidth + 1}
                        height={Math.abs(y(down) - y(up)) + 2}
                        fill="none"
                        stroke={item.highlight}
                        strokeWidth={1.5}
                      />
                    ) : null}
                  </g>
                );
              })}

              <line
                x1={0}
                x2={box.innerWidth}
                y1={zero}
                y2={zero}
                stroke="var(--axis)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />

              {slot >= MIN_SLOT
                ? items.map((item, i) => (
                    <rect
                      key={`hit-${item.id}`}
                      x={slot * i}
                      y={0}
                      width={slot}
                      height={box.innerHeight}
                      fill="transparent"
                      onMouseEnter={() => setFocus(i)}
                    />
                  ))
                : null}
            </g>
          </svg>

          <p
            className="mt-1 mb-0 text-xs"
            style={{ color: 'var(--text-secondary)', minHeight: '1.25rem' }}
            aria-live="polite"
          >
            {focused
              ? `${focused.label}: ${focused.segments
                  .map((s) => `${s.label} ${format(s.value)}`)
                  .join(' · ')} → net ${format(focused.net)}${
                  focused.detail ? ` · ${focused.detail}` : ''
                }`
              : ''}
          </p>
        </>
      ) : (
        <div style={{ height }} />
      )}
    </div>
  );
}
