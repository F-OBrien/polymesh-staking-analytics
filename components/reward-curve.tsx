'use client';

import { useMemo } from 'react';
import { useLatest } from '@/lib/data/queries';
import { LazyChart, LazyXyLineChart } from '@/components/charts/lazy-chart';
import { curveInflation, REWARD_CURVE } from '@/lib/metrics/staking';
import { formatPercent } from '@/lib/format';
import type { XySeries } from '@/components/charts/xy-line-chart';

/**
 * How the return responds to how much of the supply is staked (C3).
 *
 * The chart that explains why the APR everywhere else is what it is: staking is
 * a shared pot, so the same annual issuance divided more ways means a lower
 * individual return as participation rises.
 *
 * The threshold that matters on Polymesh is the *cap*, not Substrate's 70%
 * "ideal" ratio. A fixed 140,000,000 POLYX annual reward caps inflation at
 * ~10.7% of issuance, so below ~50% staked the curve governs, at ~50% the cap
 * binds and inflation goes flat, and above that APR is `cap ÷ ratio` — falling
 * much faster than the curve suggests (21.4% at 50%, 15.3% at 70%). The ideal
 * is never reached. Both are marked, because the difference is the insight.
 *
 * Nothing here is fetched: the curve is a pure function of the chain constants,
 * and only the current-position marker needs `latest.json`.
 */

/**
 * One sample per whole percent of staking ratio. Finer sampling rounds several
 * points to the same x label, so the table view repeats rows; the exact
 * crossover is marked separately anyway.
 */
const STEP = 0.01;

/**
 * The curve starts here, not at zero. APR is `inflation ÷ ratio`, which goes to
 * infinity as the staked share approaches zero — drawn from zero, that asymptote
 * sets the y scale and the chart becomes a picture of a hyperbola rather than of
 * this network. Comfortably below anything Polymesh has seen.
 */
const MIN_RATIO = 0.1;

export function RewardCurve({ height = 300 }: { height?: number }) {
  const latest = useLatest();

  const { x, series, cap, capRatio, currentRatio } = useMemo(() => {
    const ratioNow = latest.data?.stakingRatio ?? 0;

    // From the chain constant, not today's `inflation`: below the ceiling the
    // curve and the capped value agree exactly, so the cap is invisible in the
    // output until it binds and cannot be inferred from a sample of it.
    const issuance = latest.data ? Number(BigInt(latest.data.totalIssuance)) : 0;
    const ceiling = latest.data ? Number(BigInt(latest.data.fixedYearlyReward)) : 0;
    const cap = issuance > 0 ? ceiling / issuance : REWARD_CURVE.iIdeal;

    const xs: number[] = [];
    const inflation: number[] = [];
    const apr: number[] = [];

    const steps = Math.round((1 - MIN_RATIO) / STEP);
    for (let i = 0; i <= steps; i += 1) {
      const ratio = Number((MIN_RATIO + i * STEP).toFixed(4));
      const capped = Math.min(curveInflation(ratio), cap);
      xs.push(ratio);
      inflation.push(capped);
      // APR is what a staker receives: the whole pot shared among the staked.
      apr.push(capped / ratio);
    }

    // Where the curve reaches the cap *at today's supply* — not a fixed
    // property of the chain. The ceiling is a fixed annual POLYX figure, so as
    // supply grows it shrinks as a fraction of issuance and this crossover
    // slides down with it. Labelled "at today's supply" for that reason.
    let lo = 0;
    let hi: number = REWARD_CURVE.xIdeal;
    for (let i = 0; i < 50; i += 1) {
      const mid = (lo + hi) / 2;
      if (curveInflation(mid) < cap) lo = mid;
      else hi = mid;
    }

    return {
      x: xs,
      cap,
      // Null when the ceiling is above the curve's own peak — then it never
      // binds and there is no threshold worth marking.
      capRatio: cap < REWARD_CURVE.iIdeal ? lo : null,
      currentRatio: ratioNow,
      series: [
        { id: 'apr', label: 'Return (APR)', values: apr },
        { id: 'inflation', label: 'Inflation', values: inflation },
      ] satisfies XySeries[],
    };
  }, [latest.data]);

  const percent = (v: number) => formatPercent(v, { decimals: 2 });

  const markers = useMemo(() => {
    const list: { x: number; label: string; colour?: string }[] = [];
    if (currentRatio > 0) {
      list.push({
        x: currentRatio,
        label: `now ${formatPercent(currentRatio, { decimals: 1 })}`,
        colour: 'var(--series-1)',
      });
    }
    if (capRatio != null) {
      list.push({
        x: capRatio,
        label: `cap bites ${formatPercent(capRatio, { decimals: 0 })} (today)`,
      });
    }
    return list;
  }, [currentRatio, capRatio]);

  return (
    <LazyChart height={height} label="Reward curve">
      <LazyXyLineChart
        title="Return against how much is staked"
        subtitle="Why the APR is what it is — and what happens to it if participation grows."
        coverage={
          capRatio == null
            ? 'The protocol’s formula, not observed data.'
            : `The protocol’s formula, not observed data. Inflation is the lower of the curve ` +
              `and a fixed 140,000,000 POLYX a year — ${percent(cap)} of today’s supply, which ` +
              `the curve would only reach at ${formatPercent(capRatio, { decimals: 0 })} staked. ` +
              `That crossover falls as supply grows.`
        }
        x={x}
        series={series}
        xLabel="Share of all POLYX that is staked"
        yLabel="Annual rate"
        format={(v) => percent(v)}
        tickFormat={(v) => formatPercent(v, { decimals: 0 })}
        formatX={(v) => formatPercent(v, { decimals: 0 })}
        markers={markers}
        height={height}
        loading={latest.isLoading}
      />
    </LazyChart>
  );
}

/**
 * A plain-language reading of where the network sits on the curve, beside the
 * chart rather than inside it, so the conclusion is available to anyone who
 * does not read charts.
 */
export function RewardCurveReading() {
  const latest = useLatest();
  if (!latest.data) return null;

  const ratio = latest.data.stakingRatio;
  const inflation = latest.data.inflation;
  const curveHere = curveInflation(ratio);
  const cap =
    BigInt(latest.data.totalIssuance) > 0n
      ? Number(BigInt(latest.data.fixedYearlyReward)) / Number(BigInt(latest.data.totalIssuance))
      : Number.POSITIVE_INFINITY;

  // Which of the two rules is binding. Compare the curve against the cap, never
  // the stored inflation against the curve: `latest.json` rounds inflation to
  // six places, so that compares a rounded value against its own source and
  // reports a ceiling that is not being reached.
  const capped = curveHere >= cap;

  return (
    <p className="mt-3 mb-0 max-w-[70ch] text-sm" style={{ color: 'var(--text-secondary)' }}>
      {formatPercent(ratio, { decimals: 1 })} of all POLYX is staked, earning{' '}
      {formatPercent(inflation / ratio, { decimals: 2 })} a year before commission. Inflation is
      whichever is lower of the reward curve and a fixed 140,000,000 POLYX a year.{' '}
      {capped
        ? `The fixed amount is binding, so the pot no longer grows with participation and any further staking divides it among more stake.`
        : `The curve is binding at ${formatPercent(inflation, { decimals: 2 })}; the fixed amount is ${formatPercent(cap, { decimals: 2 })} of today’s supply and is not yet reached.`}{' '}
      Because that amount is fixed in tokens rather than as a rate, it shrinks as a share of supply
      every time new POLYX is minted — so the staking level at which it starts to bite falls over
      time.
    </p>
  );
}
