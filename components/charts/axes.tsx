'use client';

import { tickCount, type PlotBox, type TimeScale, type ValueScale } from '@/lib/charts/geometry';

/**
 * Axes and grid, recessive by design: hairline grid, muted labels, no
 * chart-area border, no axis line on the value side. All of it is `aria-hidden`
 * — a chart's accessible representation is its table, and announcing every
 * gridline would be noise.
 */

/**
 * The ticks to draw for a value axis. `scaleLinear.ticks(n)` honours `n` and is
 * used as-is; `scaleLog.ticks(n)` does not, returning every power of ten and,
 * on a narrow domain, every multiple of each — so a log axis is thinned to
 * roughly the count a linear one would use.
 *
 * Thinned evenly, with nothing appended. Force-keeping the top tick so the
 * highest value is always labelled produces uneven final gaps, which read as a
 * mistake in the data rather than in the axis.
 */
function valueTicks(scale: ValueScale, count: number): number[] {
  // `base()` exists only on a log scale, and is the one structural difference
  // between the two that does not need the caller to say which it is.
  if (!('base' in scale)) return scale.ticks(count);

  const [lo, hi] = scale.domain() as [number, number];
  if (!(lo > 0) || !(hi > lo)) return scale.ticks(count);

  /**
   * The 1-2-5 ladder a log axis is expected to be labelled with. Thinning
   * d3's own ticks instead gives sets like 20% / 70% / 300% / 800% — each value
   * correct, and nothing about the set saying "each step is a power of ten".
   */
  const ladder: number[] = [];
  const first = Math.floor(Math.log10(lo));
  const last = Math.ceil(Math.log10(hi));
  for (let power = first; power <= last; power += 1) {
    for (const mantissa of [1, 2, 5]) {
      const value = mantissa * 10 ** power;
      if (value >= lo && value <= hi) ladder.push(value);
    }
  }

  // Too few rungs in range to be a ladder (a domain inside one decade, say);
  // d3's own set is denser and better than three labels.
  if (ladder.length < 3) return scale.ticks(count);
  if (ladder.length <= count) return ladder;

  const step = Math.ceil(ladder.length / count);
  return ladder.filter((_, i) => i % step === 0);
}

export function Grid({ box, yScale }: { box: PlotBox; yScale: ValueScale }) {
  const ticks = valueTicks(yScale, tickCount(box.innerHeight, 48));

  return (
    <g aria-hidden="true">
      {ticks.map((tick) => (
        <line
          key={tick}
          x1={0}
          x2={box.innerWidth}
          y1={yScale(tick)}
          y2={yScale(tick)}
          stroke="var(--gridline)"
          strokeWidth={1}
          // Horizontal only: vertical gridlines on a time axis add clutter
          // without helping anyone read a value off the chart.
          shapeRendering="crispEdges"
        />
      ))}
    </g>
  );
}

export function YAxis({
  box,
  scale,
  format,
  label,
}: {
  box: PlotBox;
  scale: ValueScale;
  format: (value: number) => string;
  // Explicitly `| undefined`: callers pass a conditional label, and under
  // exactOptionalPropertyTypes an absent property differs from an explicit one.
  label?: string | undefined;
}) {
  const ticks = valueTicks(scale, tickCount(box.innerHeight, 48));

  return (
    <g aria-hidden="true">
      {ticks.map((tick) => (
        <text
          key={tick}
          x={-8}
          y={scale(tick)}
          textAnchor="end"
          dominantBaseline="middle"
          fontSize={11}
          fill="var(--text-muted)"
          // Tabular figures so tick labels form a clean right-aligned column.
          style={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {format(tick)}
        </text>
      ))}
      {/* The unit sits horizontally above the axis rather than rotated beside
          it. Rotated text is harder to read, and at narrow left margins it
          collided with the tick labels it was meant to describe.

          Anchored at the left edge of the margin, growing rightward — not
          right-anchored at x=-8, which silently clipped anything wider than the
          gutter: "commission" rendered as "mmission" and "operators" as
          "erators". There is nothing to collide with at this height, since it
          sits above the plot area and above the topmost tick. */}
      {label ? (
        <text x={-box.margin.left} y={-8} textAnchor="start" fontSize={10} fill="var(--text-muted)">
          {label}
        </text>
      ) : null}
    </g>
  );
}

/**
 * The x axis: dates, not era indices. An era is a day, so era 1403 *is* a date,
 * but nobody thinks in era indices — the index stays in the tooltip and table.
 */
export function XAxis({ box, scale }: { box: PlotBox; scale: TimeScale }) {
  const ticks = scale.ticks(tickCount(box.innerWidth, 90));
  const format = scale.tickFormat();

  return (
    <g aria-hidden="true" transform={`translate(0, ${box.innerHeight})`}>
      <line
        x1={0}
        x2={box.innerWidth}
        y1={0}
        y2={0}
        stroke="var(--axis)"
        strokeWidth={1}
        shapeRendering="crispEdges"
      />
      {ticks.map((tick) => (
        <text
          key={tick.getTime()}
          x={scale(tick)}
          y={16}
          textAnchor="middle"
          fontSize={11}
          fill="var(--text-muted)"
        >
          {format(tick)}
        </text>
      ))}
    </g>
  );
}

/**
 * A dashed reference line, e.g. the network average or an ideal target.
 * Direct-labelled at the right edge rather than left to the legend — it is what
 * every other series is read against, so its identity should need no lookup.
 */
export function ReferenceLine({
  box,
  y,
  label,
  colour = 'var(--text-secondary)',
}: {
  box: PlotBox;
  y: number;
  label?: string;
  colour?: string;
}) {
  return (
    <g aria-hidden="true">
      <line
        x1={0}
        x2={box.innerWidth}
        y1={y}
        y2={y}
        stroke={colour}
        strokeWidth={1.5}
        strokeDasharray="4 4"
      />
      {label ? (
        <text x={box.innerWidth + 8} y={y} dominantBaseline="middle" fontSize={11} fill={colour}>
          {label}
        </text>
      ) : null}
    </g>
  );
}
