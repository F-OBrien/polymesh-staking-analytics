'use client';

import { useId, useMemo, useState } from 'react';
import { plotBox, responsiveMargin, valueScale } from '@/lib/charts/geometry';
import { useMeasuredWidth } from '@/lib/charts/use-measure';
import { Grid, YAxis } from './axes';
import { ChartFrame, useChartHeight } from './chart-frame';
import { Legend, type LegendItem } from './legend';

/**
 * A field of categories as bars diverging from a baseline, over a tolerance
 * band.
 *
 * The x axis carries no labels by design: eighty-six operator names will not
 * fit, and the question is "what does the field look like, and is anyone
 * genuinely outside the noise?" rather than "what is operator X?". Names arrive
 * on hover, on pinned bars, and in the table view.
 *
 * The band is the point. A bar chart of a noisy measure invites ranking, and
 * ranking noise manufactures findings; drawing the region chance alone explains
 * — per category, since each has its own uncertainty — makes "inside the band"
 * the visible default.
 *
 * Direction is encoded twice, by side and by the diverging colour pair, since
 * colour is never the only cue (§7.3). Blue/crimson rather than red/green, so
 * it survives every form of CVD.
 */

export interface DeviationItem {
  id: string;
  label: string;
  value: number;
  /** Lower edge of the tolerance band for this category. */
  low: number;
  /** Upper edge of the tolerance band for this category. */
  high: number;
  /** A second line for the hover readout, e.g. "86 eras · 4,762 blocks". */
  detail?: string;
  /** Palette colour when this category is pinned; overrides the direction hue. */
  highlight?: string | undefined;
  /**
   * Draw this one back, as a category that is no longer a live choice. An
   * operator that has left the set still belongs in a chart of what the range
   * paid, but it is not something a reader can act on.
   */
  muted?: boolean | undefined;
}

export interface DeviationChartProps {
  items: readonly DeviationItem[];
  /** The value bars diverge from — 1 for a ratio, 0 for a difference. */
  baseline: number;
  title: string;
  subtitle?: string | undefined;
  coverage?: string | undefined;
  actions?: React.ReactNode;
  yLabel?: string | undefined;
  format: (value: number) => string;
  tickFormat?: ((value: number) => string) | undefined;
  /** Names the band in the legend, e.g. "Explained by chance". */
  bandLabel?: string;
  /** Column heading for `value` in the table view. */
  valueLabel?: string;
  /**
   * The three verdicts, for when "expected" is the wrong word for the baseline
   * — a chart of what an operator *paid* is read against the field, not against
   * an expectation.
   */
  readings?: Readings;
  height?: number;
  loading?: boolean | undefined;
  error?: Error | null | undefined;
  empty?: React.ReactNode;
}

/** Below this the bars are hairlines and hovering one is a coin toss. */
const MIN_SLOT = 3;

export function DeviationChart({
  items,
  baseline,
  title,
  subtitle,
  coverage,
  actions,
  yLabel,
  format,
  tickFormat,
  bandLabel = 'Within the margin of error',
  valueLabel = 'Value',
  readings = DEFAULT_READINGS,
  height: requestedHeight = 300,
  loading = false,
  error,
  empty,
}: DeviationChartProps) {
  const legend = useMemo<LegendItem[]>(() => {
    const list: LegendItem[] = [
      { id: 'band', label: bandLabel, variant: 'band', colour: 'var(--band-fill)' },
    ];
    for (const item of items) {
      if (item.highlight) list.push({ id: item.id, label: item.label, colour: item.highlight });
    }
    return list;
  }, [items, bandLabel]);

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
          <th scope="col" className="p-2 text-right font-medium">
            {valueLabel}
          </th>
          <th scope="col" className="p-2 text-right font-medium">
            {bandLabel}
          </th>
          <th scope="col" className="p-2 text-left font-medium">
            Reading
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
            <td className="p-2 text-right">{format(item.value)}</td>
            <td className="p-2 text-right" style={{ color: 'var(--text-muted)' }}>
              {format(item.low)} – {format(item.high)}
            </td>
            <td className="p-2 text-left">{reading(item, readings)}</td>
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
      <DeviationPlot
        items={items}
        baseline={baseline}
        title={title}
        yLabel={yLabel}
        format={format}
        tickFormat={tickFormat}
        readings={readings}
        requestedHeight={requestedHeight}
      />
    </ChartFrame>
  );
}

/**
 * The plot, as a child of the frame rather than a sibling. The nesting is
 * load-bearing: `useChartHeight` reads a context the frame provides *around its
 * children*, so calling it in the component that renders `<ChartFrame>` sits
 * above the provider and silently returns the collapsed height.
 */
function DeviationPlot({
  items,
  baseline,
  title,
  yLabel,
  format,
  tickFormat,
  readings,
  requestedHeight,
}: Pick<
  DeviationChartProps,
  'items' | 'baseline' | 'title' | 'yLabel' | 'format' | 'tickFormat'
> & {
  readings: Readings;
  requestedHeight: number;
}) {
  const titleId = useId();
  const [containerRef, measuredWidth] = useMeasuredWidth<HTMLDivElement>();
  const [focus, setFocus] = useState<number | null>(null);

  const height = useChartHeight(requestedHeight);
  const width = measuredWidth ?? 0;

  const margin = responsiveMargin(width);
  // No x axis — the categories carry no labels — so the bottom margin only has
  // to clear the descenders on the lowest y tick.
  const box = plotBox(width, height, { ...margin, right: 16, bottom: 12 });

  const y = useMemo(() => {
    // Band edges join the domain so the band is never clipped: with a tight
    // field it can sit inside the bars' extent, and a half-drawn tolerance
    // band reads as a data series.
    const values = items.map((item) => item.value);
    const lows = items.map((item) => item.low);
    const highs = items.map((item) => item.high);
    return valueScale([values, lows, highs, [baseline]], box.innerHeight);
  }, [items, baseline, box.innerHeight]);

  const slot = items.length > 0 ? box.innerWidth / items.length : 0;
  const barWidth = Math.max(1, slot * 0.8);
  const centre = (i: number) => slot * (i + 0.5);

  /**
   * One polygon rather than a rectangle per category: abutting rectangles leave
   * hairline seams at fractional pixel boundaries, giving the band a striped
   * texture that reads as data.
   */
  const bandPath = useMemo(() => {
    if (items.length === 0 || slot <= 0) return '';
    const top: string[] = [];
    const bottom: string[] = [];
    items.forEach((item, i) => {
      const left = slot * i;
      const right = slot * (i + 1);
      top.push(`${left},${y(item.high)}`, `${right},${y(item.high)}`);
      bottom.unshift(`${left},${y(item.low)}`, `${right},${y(item.low)}`);
    });
    return `M${[...top, ...bottom].join('L')}Z`;
  }, [items, slot, y]);

  const focused = focus != null ? items[focus] : null;

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
              <path d={bandPath} fill="var(--band-fill)" />
              <YAxis box={box} scale={y} format={tickFormat ?? format} label={yLabel} />

              {/* The baseline is the axis here, so it is solid and drawn over
                    the band rather than dashed like an added reference. */}
              <line
                x1={0}
                x2={box.innerWidth}
                y1={y(baseline)}
                y2={y(baseline)}
                stroke="var(--axis)"
                strokeWidth={1}
                shapeRendering="crispEdges"
              />

              {items.map((item, i) => {
                const top = y(item.value);
                const zero = y(baseline);
                const outside = item.value > item.high || item.value < item.low;
                const above = item.value >= baseline;
                const fill = item.muted
                  ? 'var(--text-muted)'
                  : (item.highlight ??
                    (outside
                      ? above
                        ? 'var(--div-pos-strong)'
                        : 'var(--div-neg-strong)'
                      : above
                        ? 'var(--div-pos)'
                        : 'var(--div-neg)'));
                const dimmed = focus != null && focus !== i;
                return (
                  <rect
                    key={item.id}
                    x={centre(i) - barWidth / 2}
                    y={Math.min(top, zero)}
                    width={barWidth}
                    height={Math.max(1, Math.abs(zero - top))}
                    fill={fill}
                    opacity={dimmed ? 0.4 : item.muted ? 0.55 : 1}
                    onMouseEnter={() => setFocus(i)}
                  />
                );
              })}

              {/* Hit targets: at 86 categories a bar can be 3px of a 12px
                    slot, and pointing at one is otherwise a test of aim. */}
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

          {/* The bars carry no labels, so this line is how a name is read. */}
          <p
            className="mt-1 mb-0 text-xs"
            style={{ color: 'var(--text-secondary)', minHeight: '1.25rem' }}
            aria-live="polite"
          >
            {focused
              ? `${focused.label}: ${format(focused.value)} — ${reading(focused, readings)}${
                  focused.detail ? ` · ${focused.detail}` : ''
                }`
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

/**
 * The one-phrase verdict, shared by the hover readout and the table. Three
 * outcomes only, the middle covering everything inside the band whichever side
 * of the baseline it falls: a bar half a standard error above the line is
 * indistinguishable, not "slightly better", and wording it otherwise
 * reintroduces the ranking of noise this chart prevents.
 */
export interface Readings {
  above: string;
  below: string;
  within: string;
}

const DEFAULT_READINGS: Readings = {
  above: 'above expected',
  below: 'below expected',
  within: 'as expected',
};

function reading(item: DeviationItem, readings: Readings): string {
  if (item.value > item.high) return readings.above;
  if (item.value < item.low) return readings.below;
  return readings.within;
}
