'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import {
  useEraIndex,
  useEraSeries,
  useLatest,
  useManifest,
  useOperators,
} from '@/lib/data/queries';
import { EraRangeControl, useResolvedRange } from '@/components/era-range-control';
import { useNow } from '@/lib/data/use-era-clock';
import { useLive } from '@/lib/data/use-live';
import {
  useRewardHistory,
  useRewardTotals,
  useStakeAllocation,
  useStashAddress,
  useStashPosition,
  useWallet,
} from '@/lib/data/use-stash';
import { buildOperatorRows, type OperatorRow } from '@/lib/data/operator-rows';
import {
  cumulativeRewards,
  realisedApr,
  rewardsByPeriod,
  suggestPeriod,
  pagesFor,
  rewardsToCsv,
  summariseRewards,
  type RewardPeriod,
} from '@/lib/indexer/rewards';
import { LazyChart, LazyEraSeriesChart, LazyTimeBarChart } from '@/components/charts/lazy-chart';
import { MAX_NAMED_SERIES } from '@/lib/charts/palette';
import { deriveOperatorApr } from '@/lib/metrics/derive';
import { compareChoice, type ChoiceComparison } from '@/lib/metrics/choice';
import type { NamedSeries } from '@/components/charts/banded-line-chart';
import { ProductionChart } from '@/components/production-chart';
import { LiveToggle } from '@/components/live-toggle';
import { StatTile } from '@/components/stat-tile';
import { AsOf, EmptyState, ErrorState, Skeleton } from '@/components/states';
import { idleStake, type TargetAllocation } from '@/lib/chain/allocation';
import { buildLabeller } from '@/lib/data/operator-label';
import { CopyAddress } from '@/components/copy-address';
import { outlierCap } from '@/lib/charts/notes';
import { looksLikeAddress } from '@/lib/chain/wallet';
import { explorerAccountUrl, explorerEventUrl } from '@/config/networks';
import {
  formatDateTime,
  formatNumber,
  formatPercent,
  formatPolyx,
  formatRelativeTime,
  truncateAddress,
} from '@/lib/format';

/**
 * One person's staking position. No connect wall: paste any stash and get its
 * full position and payout history with no wallet involved.
 *
 * Reward history comes from the indexer over plain `fetch`, so that half works
 * with none of the Polkadot stack loaded. Only the on-chain position — bonded,
 * unbonding, nominations — needs a socket, and it opens on demand.
 */

const DAY = 86_400;

const PERIOD_NOUN: Record<RewardPeriod, string> = {
  day: 'day',
  week: 'week',
  month: 'month',
  year: 'year',
};

const PERIODS: RewardPeriod[] = ['day', 'week', 'month', 'year'];

/**
 * Grouping for the reward bars. Starts on whatever the history's length
 * suggests and says "auto", since an unexplained "monthly" is confusing;
 * picking a grain explicitly pins it.
 */
function PeriodControl({
  value,
  onChange,
  auto,
}: {
  value: RewardPeriod;
  onChange: (next: RewardPeriod) => void;
  auto: boolean;
}) {
  return (
    <div className="flex items-center gap-1">
      <span className="sr-only" id="reward-period-label">
        Group rewards by
      </span>
      <div
        role="group"
        aria-labelledby="reward-period-label"
        className="flex items-center gap-0.5 rounded-full border p-0.5 text-xs"
        style={{ borderColor: 'var(--border)' }}
      >
        {PERIODS.map((option) => {
          const active = option === value;
          return (
            <button
              key={option}
              type="button"
              onClick={() => onChange(option)}
              aria-pressed={active}
              className="rounded-full px-2 py-0.5 capitalize transition-colors"
              style={{
                color: active ? 'var(--text-primary)' : 'var(--text-muted)',
                background: active ? 'var(--surface-2)' : 'transparent',
                fontWeight: active ? 600 : 400,
              }}
            >
              {option}
            </button>
          );
        })}
      </div>
      {auto ? (
        <span className="text-[10px]" style={{ color: 'var(--text-muted)' }}>
          auto
        </span>
      ) : null}
    </div>
  );
}

export function MyStakingView() {
  const { stash, setStash, clear } = useStashAddress();
  const wallet = useWallet();
  // Every duration on this page measures against this — `Date.now()` during
  // render is impure and unstable across re-renders.
  const now = useNow();
  const manifest = useManifest();
  const latest = useLatest();
  const registry = useOperators();
  const range = useResolvedRange(manifest.data);
  const { series } = useEraSeries(range);

  const activeEra = latest.data?.activeEra;
  const position = useStashPosition(stash, activeEra);

  // Reward history in two stages: totals are one request, and everything above
  // the fold comes from them. The event-by-event walk is one request per 100
  // payouts, so it waits until a reader asks for the detail.
  const totals = useRewardTotals(stash);

  // The address history was granted for, not a boolean — so pasting a second
  // stash cannot inherit the first one's consent to a long walk.
  const [historyFor, setHistoryFor] = useState<string | null>(null);
  const showHistory = historyFor === stash && stash !== '';

  // Fetched only alongside the detail — it fills in which era each payout was
  // earned in, and is useless without the events.
  const eraIndex = useEraIndex(showHistory);
  const rewards = useRewardHistory(stash, {
    enabled: showHistory,
    eraIndex: eraIndex.data,
  });

  // Defaults on with a wallet connected: that user has already paid for
  // `@polkadot/api`, so the subscription costs nothing extra (§6.6a).
  const live = useLive({ stash, defaultEnabled: wallet.accounts.length > 0 });

  const tokenDecimals = manifest.data?.chain.tokenDecimals ?? 6;
  const toPolyx = (value: bigint) => Number(value) / 10 ** tokenDecimals;

  const summary = useMemo(() => summariseRewards(rewards.data?.events ?? []), [rewards.data]);

  // Prefer the server-side aggregate, falling back to the walk's own sum. The
  // two agree exactly on real data.
  const lifetimeTotal = totals.data?.total ?? summary.total;
  const payoutCount = totals.data?.count ?? summary.count;
  // Also from the totals request, so neither waits on the full walk.
  const firstPayout = totals.data?.first ?? summary.first;
  const lastPayout = totals.data?.last ?? summary.last;

  // Null means "follow the history's length"; an explicit choice overrides it,
  // since the right grain depends on the question.
  const [period, setPeriod] = useState<RewardPeriod | null>(null);
  const events = useMemo(() => rewards.data?.events ?? [], [rewards.data]);
  const effectivePeriod = period ?? suggestPeriod(events);
  const daily = useMemo(() => rewardsByPeriod(events, effectivePeriod), [events, effectivePeriod]);
  const cumulative = useMemo(() => cumulativeRewards(daily), [daily]);

  const operatorRows = useMemo(
    () =>
      buildOperatorRows({
        series,
        latest: latest.data,
        registry: registry.data,
        erasPerYear: manifest.data?.erasPerYear ?? 365,
      }),
    [series, latest.data, registry.data, manifest.data],
  );

  // Live nominations win over the snapshot read when the socket is up.
  // Memoised so the `??` chain does not produce a fresh array every render.
  const nominations = useMemo(
    () => live.state.nominations ?? position.data?.nominations ?? [],
    [live.state.nominations, position.data],
  );

  const myOperators = useMemo(
    () => nominations.flatMap((address) => operatorRows.filter((row) => row.address === address)),
    [nominations, operatorRows],
  );

  const labelOf = useMemo(() => buildLabeller(registry.data), [registry.data]);

  // Unknown counts as active: a registry that has not loaded is not evidence
  // that an operator has stopped.
  const statusOf = useMemo(
    () => (address: string) => registry.data?.[address]?.status ?? 'active',
    [registry.data],
  );

  // Capped at the palette size: a further series would reuse a colour already
  // on screen. The note under the chart says how many are not drawn.
  const myAprSeries = useMemo<NamedSeries[]>(() => {
    if (!series) return [];
    return nominations.slice(0, MAX_NAMED_SERIES).flatMap((address) => {
      const columns = series.operators[address];
      if (!columns) return [];
      const { net } = deriveOperatorApr(columns, series.network, manifest.data?.erasPerYear ?? 365);
      return [{ id: address, label: labelOf(address), values: net }];
    });
  }, [series, nominations, labelOf, manifest.data?.erasPerYear]);

  // Across every series drawn — see the note in `operator-detail.tsx`. A
  // recently joined operator's first era pays a multiple of everything after
  // it, and one such point flattens the rest of the chart.
  const aprCap = useMemo(
    () =>
      outlierCap(
        [
          ...myAprSeries.flatMap((s) => s.values),
          ...(series?.network.aprP90 ?? []),
          ...(series?.network.avgApr ?? []),
        ],
        (v) => formatPercent(v, { decimals: 0 }),
        { because: 'in a first era' },
      ),
    [myAprSeries, series],
  );

  const allocation = useStakeAllocation(stash, activeEra, nominations);
  const currentTargets = allocation.data?.current.targets;
  const assignedByOperator = useMemo(() => {
    const map = new Map<string, bigint>();
    for (const target of currentTargets ?? []) map.set(target.address, target.value);
    return map;
  }, [currentTargets]);

  // Weighted by what the election actually assigned, not by the nomination
  // list — an unweighted average would describe a portfolio nobody holds.
  const choice = useMemo(() => {
    if (!series) return null;
    return compareChoice({
      eras: series.eras,
      network: series.network,
      operators: series.operators,
      picks: nominations.map((address) => ({
        address,
        weight: Number(assignedByOperator.get(address) ?? 0n),
      })),
      erasPerYear: manifest.data?.erasPerYear ?? 365,
    });
  }, [series, nominations, assignedByOperator, manifest.data?.erasPerYear]);

  const assigned = allocation.data?.current.assigned ?? null;
  // Operators still holding this stash's stake that it no longer nominates,
  // from re-nominating mid-era. They are still earning.
  const unnominatedHolders = useMemo(
    () => (currentTargets ?? []).filter((t) => !t.nominated && t.value > 0n),
    [currentTargets],
  );
  // From the chain, which can be one era ahead of the snapshot across a
  // boundary. Every label in this section uses it, so a number and the era
  // named beside it cannot disagree.
  const allocationEra = allocation.data?.current.era ?? null;
  const idle = position.data && assigned != null ? idleStake(position.data.active, assigned) : null;
  const previousAssigned = allocation.data?.previous?.assigned ?? null;
  // Non-zero only when this stash is itself an elected operator: its self-stake
  // is exposed directly rather than through anyone's nomination.
  const ownStake = allocation.data?.current.own ?? 0n;

  // Null until the history loads: the period needs the first payout's date,
  // which only the detail walk provides.
  const realised = useMemo(() => {
    const bonded = position.data?.active;
    const first = firstPayout?.datetime;
    if (bonded == null || first == null || first === 0) return null;
    const days = Math.max(1, (now / 1000 - first) / DAY);
    return realisedApr({ rewards: lifetimeTotal, bonded, days });
  }, [position.data, firstPayout, lifetimeTotal, now]);

  if (stash === '') {
    return <Disconnected wallet={wallet} onUseAddress={setStash} onPickAccount={setStash} />;
  }

  const networkApr = series ? (series.network.avgApr.at(-1) ?? null) : null;
  const asOf = latest.data ? <AsOf label={formatRelativeTime(latest.data.generatedAt)} /> : null;

  return (
    <>
      <header className="mt-8 flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <p className="m-0 text-sm" style={{ color: 'var(--text-muted)' }}>
            Showing
          </p>
          <h2 className="m-0 flex flex-wrap items-baseline gap-x-3 text-xl font-semibold">
            <CopyAddress address={stash} head={8} tail={8} label="this stash" />
            <a
              href={explorerAccountUrl(stash)}
              target="_blank"
              rel="noreferrer noopener"
              className="text-sm font-normal"
              style={{ color: 'var(--text-secondary)' }}
            >
              Subscan ↗
            </a>
            <button
              type="button"
              onClick={clear}
              className="text-sm font-normal underline"
              style={{ color: 'var(--text-muted)' }}
            >
              use a different address
            </button>
          </h2>
        </div>
        <LiveToggle live={live} />
      </header>

      {position.isError ? (
        <div className="mt-6">
          <ErrorState
            title="Could not read this position from the chain"
            message="Reward history below may still be available — it comes from a different source."
            onRetry={() => void position.refetch()}
          />
        </div>
      ) : null}

      <section aria-labelledby="position" className="mt-8">
        <h2 id="position" className="m-0 text-[22px] leading-7 font-semibold tracking-tight">
          Position
        </h2>

        {position.isLoading ? (
          <div className="mt-4">
            <Skeleton height={120} label="Reading position from the chain" />
          </div>
        ) : position.data && !position.data.isBonded ? (
          <div className="mt-4">
            <EmptyState
              title="This address has nothing bonded"
              message="It may never have staked, or it may have withdrawn everything. Reward history below still shows anything it earned in the past."
            />
          </div>
        ) : (
          <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            <StatTile
              emphasis
              label="Bonded and active"
              value={position.data ? formatPolyx(toPolyx(position.data.active)) : '—'}
              hint="not unbonding — but see what is assigned"
            />
            {/* What "bonded" is assumed to mean but does not: the election
                decides how much of a bond is exposed, and stake bonded since
                the last election is exposed not at all. */}
            <StatTile
              label={`Assigned this era`}
              value={assigned == null ? '—' : formatPolyx(toPolyx(assigned))}
              hint={
                allocation.isLoading
                  ? 'reading exposure…'
                  : ownStake > 0n
                    ? `own stake as an operator, era ${allocationEra ?? '—'}`
                    : idle != null && idle > 0n
                      ? `${formatPolyx(toPolyx(idle))} not earning`
                      : allocationEra != null
                        ? `all of it, in era ${allocationEra}`
                        : undefined
              }
            />
            <StatTile
              label="Unbonding"
              value={
                position.data
                  ? formatPolyx(
                      toPolyx(position.data.unbonding.reduce((sum, c) => sum + c.value, 0n)),
                    )
                  : '—'
              }
              hint={
                position.data && position.data.unbonding.length > 0
                  ? `${position.data.unbonding.length} chunk${position.data.unbonding.length === 1 ? '' : 's'}`
                  : 'nothing unbonding'
              }
            />
            <StatTile
              label="Withdrawable now"
              value={position.data ? formatPolyx(toPolyx(position.data.redeemable)) : '—'}
              hint={
                position.data && position.data.redeemable > 0n
                  ? 'already matured'
                  : 'nothing has matured'
              }
            />
            <StatTile
              label="Rewards paid to"
              value={describePayee(position.data?.rewardDestination).value}
              hint={describePayee(position.data?.rewardDestination).hint}
            />
          </div>
        )}

        {position.data && position.data.unbonding.length > 0 ? (
          <UnbondingTable
            chunks={position.data.unbonding}
            activeEra={live.state.activeEra ?? activeEra ?? 0}
            eraDurationSeconds={DAY}
            now={now}
            toPolyx={toPolyx}
          />
        ) : null}
      </section>

      <section aria-labelledby="earned" className="mt-12">
        <h2 id="earned" className="m-0 text-[22px] leading-7 font-semibold tracking-tight">
          What this address has earned
        </h2>

        {totals.isError || rewards.isError ? (
          <div className="mt-4">
            <ErrorState
              title="Could not load reward history"
              message={
                ((totals.error ?? rewards.error) as Error | null)?.message ??
                'The indexer did not respond.'
              }
              onRetry={() => {
                void totals.refetch();
                if (showHistory) void rewards.refetch();
              }}
            />
          </div>
        ) : totals.isLoading ? (
          <div className="mt-4">
            <Skeleton height={160} label="Loading reward totals" />
          </div>
        ) : payoutCount === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="No payouts on record"
              message="This address has never received a staking reward, at least as far back as the indexer goes."
            />
          </div>
        ) : (
          <>
            <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <StatTile
                emphasis
                label="Total earned"
                value={formatPolyx(toPolyx(lifetimeTotal))}
                hint={
                  rewards.data?.truncated
                    ? 'at least — history was truncated'
                    : `across ${formatNumber(payoutCount)} payouts`
                }
              />
              <StatTile
                label="Realised return"
                value={realised == null ? '—' : formatPercent(realised, { decimals: 2 })}
                hint="earned so far, against what is bonded now"
              />
              <StatTile
                label="Network average"
                value={formatPercent(networkApr, { decimals: 2 })}
                hint="most recent era, for comparison"
                footer={asOf}
              />
              <StatTile
                label="Last payout"
                value={
                  lastPayout?.datetime
                    ? formatRelativeTime(new Date(lastPayout.datetime * 1000).toISOString())
                    : '—'
                }
                hint={
                  lastPayout?.datetime
                    ? formatDateTime(new Date(lastPayout.datetime * 1000).toISOString())
                    : undefined
                }
              />
            </div>

            {/* The detail walk, behind an explicit choice: one request per 100
                payouts against a public endpoint, when the figures above
                already answer "how much have I earned". */}
            {!showHistory ? (
              <div className="mt-4">
                <button
                  type="button"
                  onClick={() => setHistoryFor(stash)}
                  className="rounded-[var(--radius-sm)] border px-3 py-2 text-sm"
                  style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
                >
                  Load full payout history
                </button>
                <p className="mt-2 mb-0 text-xs" style={{ color: 'var(--text-muted)' }}>
                  {formatNumber(payoutCount)} payouts — about {formatNumber(pagesFor(payoutCount))}{' '}
                  requests to the indexer. Needed for the chart, the per-era breakdown and the CSV.
                </p>
              </div>
            ) : rewards.isLoading ? (
              <div className="mt-4">
                <Skeleton height={160} label="Loading payout history" />
              </div>
            ) : daily.length > 0 ? (
              <div className="mt-4">
                {/* Bars, not a cumulative line: a monotonic total always
                    slopes up and hides when the payouts came and whether any
                    stopped. The running total sits under them on a shared x
                    axis rather than a second y axis (§8.1 rule 2). */}
                <LazyChart height={300} label="Rewards received">
                  <LazyTimeBarChart
                    title="Rewards received"
                    subtitle={`What arrived, and when. Gaps are ${PERIOD_NOUN[effectivePeriod]}s with no payout.`}
                    actions={
                      <PeriodControl
                        value={effectivePeriod}
                        onChange={setPeriod}
                        auto={period == null}
                      />
                    }
                    coverage={`${formatNumber(daily.length)} ${PERIOD_NOUN[effectivePeriod]}s · ${formatDateTime(
                      new Date(daily[0]!.day * 1000).toISOString(),
                    )} to today`}
                    times={daily.map((point) => point.day)}
                    values={daily.map((point) => toPolyx(point.amount))}
                    yLabel={`POLYX per ${PERIOD_NOUN[effectivePeriod]}`}
                    format={(v) => (v == null ? '—' : formatPolyx(v))}
                    tickFormat={(v) => formatPolyx(v, { compact: true })}
                    companion={{
                      values: cumulative.map((point) => toPolyx(point.amount)),
                      label: 'Cumulative',
                      format: (v) => (v == null ? '—' : formatPolyx(v, { compact: true })),
                    }}
                    height={300}
                  />
                </LazyChart>
              </div>
            ) : null}

            {rewards.data?.truncated ? (
              <p className="mt-3 mb-0 text-sm" style={{ color: 'var(--status-warning)' }}>
                This history was long enough to hit our page limit, so the total above is a floor
                rather than a complete figure.
              </p>
            ) : null}

            {showHistory && (rewards.data?.events.length ?? 0) > 0 ? (
              <div className="mt-4">
                <ExportButton
                  stash={stash}
                  csv={() =>
                    rewardsToCsv(rewards.data?.events ?? [], tokenDecimals, explorerEventUrl)
                  }
                />
              </div>
            ) : null}
          </>
        )}
      </section>

      <section aria-labelledby="my-operators" className="mt-12">
        {/* The range control sits here, not at the top: everything the window
            changes is inside this section. Above it are balances and a payout
            ledger, which an era window has no bearing on. */}
        <div className="flex flex-wrap items-baseline justify-between gap-3">
          <h2 id="my-operators" className="m-0 text-[22px] leading-7 font-semibold tracking-tight">
            Operators backed
          </h2>
          <EraRangeControl manifest={manifest.data} />
        </div>

        {position.isLoading ? (
          <div className="mt-4">
            <Skeleton height={200} label="Loading nominations" />
          </div>
        ) : position.isError ? (
          // Distinct from "no nominations" — showing that here would tell
          // someone they are earning nothing when they are.
          <div className="mt-4">
            <EmptyState
              title="Could not read nominations"
              message="The chain did not respond, so we cannot say which operators this address backs. This is usually temporary."
            />
          </div>
        ) : nominations.length === 0 ? (
          <div className="mt-4">
            <EmptyState
              title="Not currently nominating"
              message="This address has no active nominations, so it is not earning staking rewards."
              action={
                <Link href="/operators/" className="mt-1 text-sm">
                  Find operators
                </Link>
              }
            />
          </div>
        ) : (
          <>
            <AllocationNote
              activeEra={allocationEra}
              assigned={assigned}
              idle={idle}
              previousAssigned={previousAssigned}
              backing={
                allocation.data?.current.targets.filter((t) => t.nominated && t.value > 0n)
                  .length ?? null
              }
              nominated={nominations.length}
              unnominated={allocation.data?.current.unnominated ?? null}
              unnominatedCount={unnominatedHolders.length}
              toPolyx={toPolyx}
            />
            <NominationsTable
              rows={myOperators}
              addresses={nominations}
              assignedByOperator={assignedByOperator}
              unnominatedHolders={unnominatedHolders}
              registryLabel={labelOf}
              toPolyx={toPolyx}
              loading={allocation.isLoading}
            />

            {choice ? (
              <ChoiceVerdict
                choice={choice}
                assigned={assigned}
                nominated={nominations.length}
                backing={nominations.filter((a) => (assignedByOperator.get(a) ?? 0n) > 0n).length}
                toPolyx={toPolyx}
              />
            ) : null}

            {/* The same banded chart as /operators, with this address's picks
                as the named series, against the field's 10th–90th percentile
                band — so "is 20.1% good?" has an answer on the same axes.
                Needs no extra request; everything is already in memory. */}
            {myAprSeries.length > 0 ? (
              <div className="mt-4">
                <LazyChart height={300} label="My operators' return">
                  <LazyEraSeriesChart
                    title="How my operators have performed"
                    subtitle="Return after commission, against the whole field. Read it for outages and trend, not for ranking — see below for that."
                    series={series}
                    operators={myAprSeries}
                    band={
                      series
                        ? {
                            lo: series.network.aprP10,
                            mid: series.network.aprP50,
                            hi: series.network.aprP90,
                          }
                        : undefined
                    }
                    reference={
                      series
                        ? { values: series.network.avgApr, label: 'Network average' }
                        : undefined
                    }
                    format={(v) => formatPercent(v, { decimals: 2 })}
                    tickFormat={(v) => formatPercent(v, { decimals: 0 })}
                    yLabel="APR"
                    height={300}
                    offerLogScale
                    cap={aprCap}
                    // Kept short — it sits beside the frame's controls, and
                    // each wrapped line pushes the Expand button down.
                    note={
                      `One era's return is mostly slot luck; a sustained dip is an outage.` +
                      (myAprSeries.length < nominations.length
                        ? ` ${nominations.length - myAprSeries.length} of ${nominations.length} not drawn.`
                        : '')
                    }
                  />
                </LazyChart>
              </div>
            ) : null}

            {/* The ranking the chart above cannot give: accumulated over the
                range, block production separates operators in a way per-era
                APR cannot (see `lib/metrics/production.ts`). The whole field,
                with this address's picks coloured. */}
            <div className="mt-4">
              <ProductionChart
                series={series}
                nameOf={labelOf}
                statusOf={statusOf}
                selected={nominations.slice(0, MAX_NAMED_SERIES)}
                selectionNoun="nominated"
              />
            </div>
          </>
        )}
      </section>
    </>
  );
}

// ---------------------------------------------------------------------------
// Disconnected
// ---------------------------------------------------------------------------

/**
 * What the page shows before an address is chosen. The paste-an-address route
 * is as prominent as the wallet, not a fallback — inspecting an account that is
 * not yours is most of the reason to look at a staking page.
 */
function Disconnected({
  wallet,
  onUseAddress,
  onPickAccount,
}: {
  wallet: ReturnType<typeof useWallet>;
  onUseAddress: (address: string) => void;
  onPickAccount: (address: string) => void;
}) {
  const [draft, setDraft] = useState('');
  const [touched, setTouched] = useState(false);
  const valid = looksLikeAddress(draft);

  return (
    <div className="mt-8 grid gap-8 lg:grid-cols-2">
      <section
        aria-labelledby="by-address"
        className="rounded-[var(--radius-md)] border p-5"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
      >
        <h2 id="by-address" className="m-0 text-[17px] leading-6 font-semibold">
          Look up any address
        </h2>
        <p className="mt-1 mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          No wallet needed. Paste a stash address to see its position, its nominations and every
          reward it has been paid.
        </p>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            setTouched(true);
            if (valid) onUseAddress(draft);
          }}
          className="flex flex-col gap-2"
        >
          <label htmlFor="stash-input" className="sr-only">
            Stash address
          </label>
          <input
            id="stash-input"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            onBlur={() => setTouched(true)}
            placeholder="2H…"
            spellCheck={false}
            autoComplete="off"
            aria-invalid={touched && draft !== '' && !valid}
            aria-describedby="stash-help"
            className="w-full rounded-[var(--radius-sm)] border px-3 py-2 text-sm"
            style={{
              borderColor:
                touched && draft !== '' && !valid ? 'var(--status-critical)' : 'var(--border)',
              background: 'var(--page-plane)',
              fontFamily: 'var(--font-mono)',
            }}
          />
          <p id="stash-help" className="m-0 text-xs" style={{ color: 'var(--text-muted)' }}>
            {touched && draft !== '' && !valid
              ? 'That does not look like a Polymesh address — they are 47–48 characters and start with a digit or letter.'
              : 'Read-only. This site never asks you to sign anything.'}
          </p>
          <button
            type="submit"
            disabled={!valid}
            className="self-start rounded-[var(--radius-sm)] border px-3 py-1.5 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-40"
            style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
          >
            Look up
          </button>
        </form>
      </section>

      <section
        aria-labelledby="by-wallet"
        className="rounded-[var(--radius-md)] border p-5"
        style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
      >
        <h2 id="by-wallet" className="m-0 text-[17px] leading-6 font-semibold">
          Or connect a wallet
        </h2>
        <p className="mt-1 mb-3 text-sm" style={{ color: 'var(--text-secondary)' }}>
          Saves pasting. This site is read-only — connecting reveals your addresses and nothing
          else, and you will never be asked to sign.
        </p>

        {wallet.accounts.length > 0 ? (
          <ul className="m-0 flex list-none flex-col gap-1 p-0">
            {wallet.accounts.map((account) => (
              <li key={`${account.source}:${account.address}`}>
                <button
                  type="button"
                  onClick={() => onPickAccount(account.address)}
                  className="flex w-full items-baseline justify-between gap-3 rounded-[var(--radius-sm)] border px-3 py-2 text-left text-sm"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <span className="truncate font-medium">{account.name}</span>
                  <span
                    className="shrink-0 text-xs"
                    style={{ color: 'var(--text-muted)', fontFamily: 'var(--font-mono)' }}
                  >
                    {truncateAddress(account.address)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        ) : (
          <>
            <button
              type="button"
              onClick={() => void wallet.connect()}
              disabled={wallet.connecting}
              className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-sm font-medium disabled:opacity-60"
              style={{ borderColor: 'var(--border)', background: 'var(--surface-2)' }}
            >
              {wallet.connecting ? 'Waiting for the extension…' : 'Connect wallet'}
            </button>
            {wallet.error ? (
              <p className="mt-3 mb-0 text-sm" style={{ color: 'var(--status-critical)' }}>
                {wallet.error.message}
              </p>
            ) : null}
          </>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tables
// ---------------------------------------------------------------------------

function UnbondingTable({
  chunks,
  activeEra,
  eraDurationSeconds,
  now,
  toPolyx,
}: {
  chunks: readonly { era: number; value: bigint }[];
  activeEra: number;
  eraDurationSeconds: number;
  /** Milliseconds, from `useNow` — never `Date.now()` during render. */
  now: number;
  toPolyx: (value: bigint) => number;
}) {
  return (
    <div className="mt-4 overflow-x-auto">
      <table
        className="w-full border-collapse text-sm"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        <caption className="pb-2 text-left" style={{ color: 'var(--text-muted)' }}>
          Unbonding chunks and when each becomes withdrawable.
        </caption>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th scope="col" className="p-2 text-left font-medium">
              Unlocks at era
            </th>
            <th scope="col" className="p-2 text-left font-medium">
              Approximately
            </th>
            <th scope="col" className="p-2 text-right font-medium">
              Amount
            </th>
          </tr>
        </thead>
        <tbody>
          {chunks.map((chunk) => {
            const erasAway = chunk.era - activeEra;
            const when =
              erasAway <= 0
                ? 'available now'
                : formatDateTime(
                    new Date(now + erasAway * eraDurationSeconds * 1000).toISOString(),
                  );
            return (
              <tr key={chunk.era} style={{ borderTop: '1px solid var(--border)' }}>
                <th scope="row" className="p-2 text-left font-normal">
                  {formatNumber(chunk.era)}
                </th>
                <td className="p-2">{when}</td>
                <td className="p-2 text-right">{formatPolyx(toPolyx(chunk.value))}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Was picking these operators worth anything? The rest of the page is
 * absolutes; this splits the comparison into the two things a nominator can act
 * on separately — the fee they agreed to, and how well the node runs.
 *
 * A paragraph rather than tiles, because the conclusion is a comparison with a
 * sign and a cause, which four numbers in boxes would leave to the reader.
 */
function ChoiceVerdict({
  choice,
  assigned,
  nominated,
  backing,
  toPolyx,
}: {
  choice: ChoiceComparison;
  /** Stake assigned this era, for pricing the gap. */
  assigned: bigint | null;
  nominated: number;
  /** How many of the nominations the election actually put stake behind. */
  backing: number;
  toPolyx: (value: bigint) => number;
}) {
  const points = (value: number) => `${(value * 100).toFixed(2)} points`;
  const ahead = choice.difference >= 0;

  // Priced against assigned stake, not the bond — idle stake earns nothing.
  const stake = assigned != null ? toPolyx(assigned) : null;
  const worth = stake != null && stake > 0 ? stake * choice.difference : null;

  const larger = Math.abs(choice.fromCommission) >= Math.abs(choice.fromProduction);

  return (
    <div
      className="mt-4 rounded-[var(--radius-md)] border p-4 text-sm"
      style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
    >
      <h3 className="m-0 mb-1 text-[15px] font-semibold">Is this a good set of operators?</h3>
      <p className="m-0 max-w-[75ch]" style={{ color: 'var(--text-secondary)' }}>
        {/* Named precisely: weighting by assigned stake commonly reduces many
            nominations to the one the election used, and "your operators"
            would credit the whole set for one member's record. */}
        Over {formatNumber(choice.eras)} eras{' '}
        {backing === 1
          ? 'the operator your stake is actually behind'
          : backing > 0
            ? `the ${formatNumber(backing)} operators your stake is actually behind`
            : 'these operators'}{' '}
        returned{' '}
        <strong style={{ color: 'var(--text-primary)' }}>
          {formatPercent(choice.yourNet, { decimals: 2 })}
        </strong>{' '}
        after commission, against {formatPercent(choice.fieldNet, { decimals: 2 })} for the average
        operator — {ahead ? 'ahead by' : 'behind by'} {points(Math.abs(choice.difference))}.
        {worth != null
          ? ` On the ${formatPolyx(stake ?? 0)} POLYX assigned this era that is ${ahead ? 'worth' : 'costing'} about ${formatPolyx(Math.abs(worth))} POLYX a year.`
          : ' Nothing is assigned this era, so it is worth nothing until the next election.'}
      </p>
      <p className="mt-2 mb-0 max-w-[75ch]" style={{ color: 'var(--text-secondary)' }}>
        {/* The split, and which half decided it. Commission is the larger
            lever on this network (it spans 8–10%, where production separates
            operators by about 1%), so naming the driver is the actionable
            part. */}
        Commission accounts for {points(choice.fromCommission)} of that (
        {formatPercent(choice.yourCommission, { decimals: 2 })} against{' '}
        {formatPercent(choice.fieldCommission, { decimals: 2 })} across the field), and block
        production for {points(choice.fromProduction)}
        {larger ? ' — the fee is what decided it' : ' — the nodes are what decided it'}.
      </p>
      {choice.covered < nominated ? (
        <p className="mt-2 mb-0 text-xs" style={{ color: 'var(--text-muted)' }}>
          Based on {choice.covered} of {nominated} nominations. The rest have too little history in
          this range to measure.
        </p>
      ) : null}
    </div>
  );
}

/**
 * Why the numbers may not be what the nomination list implies: the election
 * commonly puts a whole bond behind one of eight targets, and rewards arriving
 * now are for the previous era. Renders only when there is something to say.
 */
function AllocationNote({
  activeEra,
  assigned,
  idle,
  previousAssigned,
  backing,
  nominated,
  unnominated,
  unnominatedCount,
  toPolyx,
}: {
  activeEra: number | null;
  assigned: bigint | null;
  idle: bigint | null;
  previousAssigned: bigint | null;
  backing: number | null;
  nominated: number;
  /** Stake held by operators no longer nominated. */
  unnominated: bigint | null;
  unnominatedCount: number;
  toPolyx: (value: bigint) => number;
}) {
  if (assigned == null) return null;

  const notes: string[] = [];

  // First, because it otherwise looks like a bug: the nomination list and the
  // stake disagree, and both are correct.
  if (unnominated != null && unnominated > 0n) {
    notes.push(
      `${formatPolyx(toPolyx(unnominated))} POLYX is still staked with ` +
        `${unnominatedCount === 1 ? 'an operator' : `${unnominatedCount} operators`} no longer ` +
        `nominated. Changing nominations does not move stake that is already exposed — the ` +
        `election fixed it for this era, and it moves at the next one. It is still earning in ` +
        `the meantime.`,
    );
  }

  if (backing != null && backing > 0 && backing < nominated) {
    notes.push(
      `The election put this stake behind ${backing} of the ${nominated} operators nominated. ` +
        `That is normal — it optimises the network’s spread of stake, not yours — but it does mean ` +
        `nominating more operators is not by itself diversification.`,
    );
  }

  if (backing === 0) {
    notes.push(
      `None of this stake is backing an operator in the current era. That happens when a ` +
        `nomination was made during this era, or when no nominated operator was elected.`,
    );
  }

  if (idle != null && idle > 0n && backing !== 0) {
    notes.push(
      `${formatPolyx(toPolyx(idle))} POLYX is bonded but not assigned this era, so it is not ` +
        `earning. Stake bonded after the last election joins at the next one.`,
    );
  }

  if (previousAssigned === 0n && assigned > 0n) {
    notes.push(
      `Payouts landing now are for era ${activeEra == null ? 'the previous era' : activeEra - 1}, ` +
        `when none of this stake was assigned — so expect nothing from them, even though it is ` +
        `earning in the era now running.`,
    );
  }

  if (notes.length === 0) return null;

  return (
    <ul
      className="mt-4 mb-0 flex list-none flex-col gap-2 rounded-[var(--radius-md)] border p-3 text-sm"
      style={{ borderColor: 'var(--border)', color: 'var(--text-secondary)' }}
    >
      {notes.map((note) => (
        <li key={note}>
          <span aria-hidden="true">•</span> {note}
        </li>
      ))}
    </ul>
  );
}

/**
 * Nominated operators, with a warning row for anything that should change a
 * decision — an operator no longer elected, blocked, or charging more than the
 * field. See `nominationWarnings`.
 */
function NominationsTable({
  rows,
  addresses,
  assignedByOperator,
  unnominatedHolders,
  registryLabel,
  toPolyx,
  loading,
}: {
  rows: readonly OperatorRow[];
  addresses: readonly string[];
  assignedByOperator: ReadonlyMap<string, bigint>;
  /** Operators holding stake that this stash no longer nominates. */
  unnominatedHolders: readonly TargetAllocation[];
  registryLabel: (address: string) => string;
  toPolyx: (value: bigint) => number;
  loading: boolean;
}) {
  // Addresses we hold no data for. Still shown — dropping a nomination would
  // misrepresent the position.
  const unknown = addresses.filter((address) => !rows.some((row) => row.address === address));

  return (
    <div className="mt-4 overflow-x-auto">
      <table
        className="w-full border-collapse text-sm"
        style={{ fontVariantNumeric: 'tabular-nums' }}
      >
        <caption className="pb-2 text-left" style={{ color: 'var(--text-muted)' }}>
          {formatNumber(addresses.length)} nomination
          {addresses.length === 1 ? '' : 's'}
          {unnominatedHolders.length > 0
            ? `, plus ${formatNumber(unnominatedHolders.length)} operator${
                unnominatedHolders.length === 1 ? '' : 's'
              } still holding stake from a previous era`
            : ''}
          . Warnings flag anything worth acting on.
        </caption>
        <thead>
          <tr style={{ borderBottom: '1px solid var(--border)' }}>
            <th scope="col" className="p-2 text-left font-medium">
              Operator
            </th>
            {/* Turns a list of intentions into a list of facts: which of these
                operators the stake is actually behind. */}
            <th scope="col" className="p-2 text-right font-medium">
              Assigned this era
            </th>
            {/* Two eras, not a mean: a mean over the range is dominated by an
                operator's first era, which pays on its own bond with no
                nominators and a full share of points. */}
            <th scope="col" className="p-2 text-right font-medium">
              This era
              <span className="block text-xs font-normal" style={{ color: 'var(--text-muted)' }}>
                so far
              </span>
            </th>
            <th scope="col" className="p-2 text-right font-medium">
              Last era
            </th>
            <th scope="col" className="p-2 text-right font-medium">
              Commission
            </th>
            <th scope="col" className="p-2 text-left font-medium">
              Status
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const warnings = nominationWarnings(row);
            return (
              <tr key={row.address} style={{ borderTop: '1px solid var(--border)' }}>
                <th scope="row" className="p-2 text-left font-normal">
                  <Link href={`/operators/${row.address}/`}>{row.name}</Link>
                  <CopyAddress
                    address={row.address}
                    label={row.name}
                    className="ms-2 align-middle text-xs"
                  />
                </th>
                <td className="p-2 text-right">
                  {loading ? (
                    <span style={{ color: 'var(--text-muted)' }}>…</span>
                  ) : (assignedByOperator.get(row.address) ?? 0n) > 0n ? (
                    formatPolyx(toPolyx(assignedByOperator.get(row.address)!))
                  ) : (
                    <span
                      style={{ color: 'var(--text-muted)' }}
                      title="The election did not put any of this stake behind this operator for the current era"
                    >
                      none
                    </span>
                  )}
                </td>
                <td className="p-2 text-right">{formatPercent(row.aprThisEra, { decimals: 2 })}</td>
                <td
                  className="p-2 text-right"
                  title={row.lastEraIndex == null ? undefined : `Era ${row.lastEraIndex}`}
                >
                  {formatPercent(row.aprLastEra, { decimals: 2 })}
                </td>
                <td className="p-2 text-right">{formatPercent(row.commission, { decimals: 2 })}</td>
                <td className="p-2">
                  {warnings.length === 0 ? (
                    <span style={{ color: 'var(--text-muted)' }}>Nothing to flag</span>
                  ) : (
                    <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                      {warnings.map((warning) => (
                        <li key={warning} style={{ color: 'var(--status-warning)' }}>
                          {/* Icon plus text: never colour alone. */}
                          <span aria-hidden="true">▲</span> {warning}
                        </li>
                      ))}
                    </ul>
                  )}
                </td>
              </tr>
            );
          })}
          {unknown.map((address) => (
            <tr key={address} style={{ borderTop: '1px solid var(--border)' }}>
              <th scope="row" className="p-2 text-left font-normal">
                <CopyAddress address={address} />
              </th>
              {/* One dash each, to keep the header's column count. */}
              <td className="p-2 text-right">—</td>
              <td className="p-2 text-right">—</td>
              <td className="p-2 text-right">—</td>
              <td className="p-2 text-right">—</td>
              <td className="p-2" style={{ color: 'var(--text-muted)' }}>
                No data — not in the current set or our history
              </td>
            </tr>
          ))}
          {/* Still holding this stash's stake though no longer nominated.
              Omitting them shows a position as unassigned when it is earning
              normally. */}
          {unnominatedHolders.map((holder) => (
            <tr key={holder.address} style={{ borderTop: '1px solid var(--border)' }}>
              <th scope="row" className="p-2 text-left font-normal">
                <Link href={`/operators/${holder.address}/`}>{registryLabel(holder.address)}</Link>
                <CopyAddress
                  address={holder.address}
                  label={registryLabel(holder.address)}
                  className="ms-2 align-middle text-xs"
                />
              </th>
              <td className="p-2 text-right">{formatPolyx(toPolyx(holder.value))}</td>
              <td className="p-2 text-right">—</td>
              <td className="p-2 text-right">—</td>
              <td className="p-2 text-right">—</td>
              <td className="p-2">
                <span style={{ color: 'var(--status-warning)' }}>
                  <span aria-hidden="true">▲</span> No longer nominated — still staked here until
                  the next era
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Renders a reward destination. `readPayee` returns a variant name (`Staked`,
 * `Stash`, `Controller`) or, for `Account`, a full address — truncated here to
 * fit a stat tile. Only `Staked` compounds, so the hint says so in words.
 */
function describePayee(destination: string | null | undefined): { value: string; hint: string } {
  if (destination == null) return { value: '—', hint: 'not known' };
  if (destination === 'Staked') {
    return { value: 'Staked', hint: 'added to the bond — compounding' };
  }
  // Anything that is not a known unit variant is an address.
  if (destination !== 'Stash' && destination !== 'Controller') {
    return {
      value: truncateAddress(destination),
      hint: 'paid to another account — not compounding',
    };
  }
  return { value: destination, hint: 'paid out free — not compounding' };
}

/**
 * What would make a nominator want to move. Note there is deliberately no
 * "nominator page is full" warning: Polymesh rewards every exposure page, so it
 * would push someone off a perfectly good node.
 */
function nominationWarnings(row: OperatorRow): string[] {
  const warnings: string[] = [];
  if (row.status !== 'active') {
    warnings.push(
      row.status === 'waiting' ? 'Not elected this era' : 'Not in the active set at all',
    );
  }
  if (row.blocked) warnings.push('Blocked to new nominations');
  if (row.commission != null && row.commission >= 0.2) {
    warnings.push(`Commission is high at ${formatPercent(row.commission, { decimals: 1 })}`);
  }
  return warnings;
}

/**
 * CSV download, built on click — a long history is a few hundred kilobytes of
 * string and most visitors never press it.
 */
function ExportButton({ stash, csv }: { stash: string; csv: () => string }) {
  return (
    <button
      type="button"
      onClick={() => {
        const blob = new Blob([csv()], { type: 'text/csv;charset=utf-8' });
        const url = URL.createObjectURL(blob);
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `polymesh-rewards-${stash.slice(0, 8)}.csv`;
        anchor.click();
        URL.revokeObjectURL(url);
      }}
      className="rounded-[var(--radius-sm)] border px-3 py-1.5 text-sm"
      style={{ borderColor: 'var(--border)' }}
    >
      Download reward history (CSV)
    </button>
  );
}
