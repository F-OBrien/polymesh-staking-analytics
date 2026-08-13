import { deriveEstimatedEraApr, deriveOperatorApr, lastDefinedAt } from '@/lib/metrics/derive';
import { median, robustSpread } from '@/lib/metrics/stats';
import type { Latest, OperatorRegistry } from '@/lib/schemas/data';
import type { StitchedSeries } from './series';

/**
 * Building, sorting and filtering the operator directory. Pure functions, so
 * this is testable without a DOM and the component stays presentational.
 *
 * Hand-rolled rather than TanStack Table (§6.8): the directory is ~100 rows, so
 * virtualisation buys nothing and 15 KB on the critical path is a poor trade.
 * Revisit if the table ever needs grouping, pinning or column resizing.
 */

export interface OperatorRow {
  address: string;
  name: string;
  status: 'active' | 'waiting' | 'inactive';
  /** null where the operator has no current snapshot entry. */
  commission: number | null;
  totalStake: number | null;
  ownStake: number | null;
  /** Own stake as a share of total — skin in the game. */
  selfStakeRatio: number | null;
  nominatorCount: number | null;
  /**
   * Exposure pages the operator's backers were split across. For the CSV export
   * only — a payout mechanic with no consequence for a nominator, so nothing
   * renders it as a status. See `pageCount` in `lib/schemas/data.ts`.
   */
  pageCount: number | null;
  blocked: boolean;
  /**
   * Return, on three time bases and two commission bases — never a bare
   * "return". What an operator earns right now, what it earned last era and
   * what it typically earns differ enough to change a nomination, as does
   * whether commission has been taken off (up to a fifth of the number).
   *
   * `…Gross` is before commission (node performance); the unsuffixed field is
   * after (what a nominator receives).
   */

  /** Estimated from points scored so far in the era now running. Forward-looking. */
  aprThisEra: number | null;
  aprThisEraGross: number | null;
  /** Actual, for the most recent complete era held. */
  aprLastEra: number | null;
  aprLastEraGross: number | null;
  /** Which era `aprLastEra` refers to, so the column can name it. */
  lastEraIndex: number | null;
  /**
   * The typical era across the visible range — a median, not a mean. See
   * `median` in `lib/metrics/stats.ts` for why a first era is a different
   * regime rather than a bad data point.
   */
  aprMedian: number | null;
  aprMedianGross: number | null;
  /**
   * Spread of per-era APR; lower is steadier. Shown as "consistency" rather
   * than raw σ, and robust for the same reason the centre is — squaring the
   * deviations makes one first-era spike read as a wildly erratic operator.
   */
  aprSpread: number | null;
  aprSpreadGross: number | null;
  /** Points scored so far in the era now running, from the snapshot or Live. */
  pointsThisEra: number | null;
  /** Eras present in the visible range, for the sparkline. */
  aprSeries: (number | null)[];
  /** Share of reward points in the most recent era with data. */
  pointsShare: number | null;
}

export interface BuildRowsInput {
  series: StitchedSeries | null;
  latest: Latest | undefined;
  registry: OperatorRegistry | undefined;
  erasPerYear: number;
  /**
   * Points for the era in progress, when the reader has Live on. Overrides the
   * snapshot's, which are up to 15 minutes old — invisible on a median over 90
   * eras, very visible on "is my node producing blocks right now".
   */
  livePoints?: { total: number; byOperator: Record<string, number> } | null | undefined;
}

const lastDefined = (values: readonly (number | null)[]): number | null => {
  for (let i = values.length - 1; i >= 0; i -= 1) {
    const value = values[i];
    if (value != null && Number.isFinite(value)) return value;
  }
  return null;
};

/**
 * One row per operator seen in either the range or the snapshot. The union, not
 * the intersection: an operator elected today may have no history in a short
 * range, and one with history may have dropped out.
 */
export function buildOperatorRows({
  series,
  latest,
  registry,
  erasPerYear,
  livePoints,
}: BuildRowsInput): OperatorRow[] {
  const bySnapshot = new Map((latest?.operators ?? []).map((op) => [op.address, op]));
  const addresses = new Set<string>([
    ...Object.keys(series?.operators ?? {}),
    ...bySnapshot.keys(),
  ]);

  // Inputs to the current-era estimate, shared by every row. Points come from
  // Live when on and the snapshot otherwise — the same quantity at different
  // freshness, so the estimate's shape does not change.
  const snapshotTotalPoints = (latest?.operators ?? []).reduce((sum, op) => sum + op.points, 0);
  const eraTotalPoints = livePoints?.total ?? snapshotTotalPoints;
  const inflation = latest?.inflation ?? 0;
  const issuancePolyx = latest ? Number(BigInt(latest.totalIssuance) / 1_000_000n) : 0;

  const rows: OperatorRow[] = [];

  for (const address of addresses) {
    const record = registry?.[address];
    const snapshot = bySnapshot.get(address);
    const columns = series?.operators[address];

    const apr =
      columns && series
        ? deriveOperatorApr(columns, series.network, erasPerYear)
        : { gross: [], net: [] };
    const aprSeries = apr.net;

    // Snapshot values are exact base-unit strings, the range gives POLYX
    // floats. Prefer the snapshot for "now", falling back to the last era held
    // so a row is never blank just because the snapshot lagged.
    const totalStake = snapshot
      ? Number(BigInt(snapshot.totalStake) / 1_000_000n)
      : (lastDefined(columns?.totalStake ?? []) ?? null);
    const ownStake = snapshot
      ? Number(BigInt(snapshot.ownStake) / 1_000_000n)
      : (lastDefined(columns?.ownStake ?? []) ?? null);

    const pointsShare = (() => {
      if (!series || !columns) return null;
      for (let i = series.eras.length - 1; i >= 0; i -= 1) {
        const points = columns.points[i];
        const total = series.network.totalPoints[i];
        if (points != null && total != null && total > 0) return points / total;
      }
      return null;
    })();

    const commission = snapshot?.commission ?? lastDefined(columns?.commission ?? []);

    // The newest era actually held. Named in the column header rather than
    // left implicit, since a stale ingest would otherwise pass for yesterday.
    const lastNet = lastDefinedAt(apr.net);
    const lastGross = lastDefinedAt(apr.gross);

    const pointsThisEra = livePoints
      ? (livePoints.byOperator[address] ?? null)
      : (snapshot?.points ?? null);

    const thisEra = deriveEstimatedEraApr({
      points: pointsThisEra,
      totalPoints: eraTotalPoints,
      totalStake,
      commission,
      inflation,
      totalIssuance: issuancePolyx,
    });

    rows.push({
      address,
      name: record?.name ?? address,
      status: record?.status ?? (snapshot?.elected ? 'active' : 'inactive'),
      commission,
      totalStake,
      ownStake,
      selfStakeRatio: totalStake != null && totalStake > 0 && ownStake != null ? ownStake / totalStake : null,
      nominatorCount: snapshot?.nominatorCount ?? lastDefined(columns?.nominatorCount ?? []),
      pageCount: snapshot?.pageCount ?? null,
      blocked: snapshot?.blocked ?? false,
      aprThisEra: thisEra.net,
      aprThisEraGross: thisEra.gross,
      aprLastEra: lastNet?.value ?? null,
      aprLastEraGross: lastGross?.value ?? null,
      lastEraIndex: lastNet != null ? (series?.eras[lastNet.index] ?? null) : null,
      aprMedian: median(aprSeries),
      aprMedianGross: median(apr.gross),
      aprSpread: robustSpread(aprSeries),
      aprSpreadGross: robustSpread(apr.gross),
      pointsThisEra,
      aprSeries,
      pointsShare,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// Sorting
// ---------------------------------------------------------------------------

export type SortKey =
  | 'name'
  | 'commission'
  | 'totalStake'
  | 'selfStakeRatio'
  | 'nominatorCount'
  | 'aprThisEra'
  | 'aprThisEraGross'
  | 'aprLastEra'
  | 'aprLastEraGross'
  | 'aprMedian'
  | 'aprMedianGross'
  | 'aprSpread'
  | 'aprSpreadGross'
  | 'pointsThisEra'
  | 'pointsShare';

export type SortDirection = 'asc' | 'desc';

/**
 * Sorts rows, always placing missing values last. A null is "unknown", not
 * "worst", so it must neither be buried under a descending sort nor floated to
 * the top by an ascending one.
 */
export function sortRows(
  rows: readonly OperatorRow[],
  key: SortKey,
  direction: SortDirection,
): OperatorRow[] {
  const sign = direction === 'asc' ? 1 : -1;

  return [...rows].sort((a, b) => {
    if (key === 'name') {
      return sign * a.name.localeCompare(b.name, undefined, { numeric: true });
    }

    const left = a[key];
    const right = b[key];

    if (left == null && right == null) return a.name.localeCompare(b.name);
    if (left == null) return 1;
    if (right == null) return -1;
    if (left === right) return a.name.localeCompare(b.name);

    return sign * (left < right ? -1 : 1);
  });
}

// ---------------------------------------------------------------------------
// Filtering
// ---------------------------------------------------------------------------

export interface OperatorFilters {
  /** Matched against name, node label and address, case-insensitively. */
  search?: string | undefined;
  status?: 'all' | 'active' | 'waiting' | 'inactive' | undefined;
  /** Maximum commission as a ratio; undefined means no cap. */
  maxCommission?: number | undefined;
  /** Restrict to a specific set, e.g. the connected wallet's nominations. */
  onlyAddresses?: ReadonlySet<string> | undefined;
}

export function filterRows(
  rows: readonly OperatorRow[],
  filters: OperatorFilters,
): OperatorRow[] {
  const needle = filters.search?.trim().toLowerCase();

  return rows.filter((row) => {
    if (filters.onlyAddresses && !filters.onlyAddresses.has(row.address)) return false;
    if (filters.status && filters.status !== 'all' && row.status !== filters.status) return false;

    if (filters.maxCommission != null) {
      // An unknown commission is not evidence of a low one.
      if (row.commission == null || row.commission > filters.maxCommission) return false;
    }

    if (needle) {
      const haystack = `${row.name} ${row.address}`.toLowerCase();
      if (!haystack.includes(needle)) return false;
    }

    return true;
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/** CSV of the visible rows, for checking a figure or for reporting. */
export function rowsToCsv(rows: readonly OperatorRow[]): string {
  const header = [
    'operator',
    'address',
    'status',
    'commission',
    'total_stake_polyx',
    'own_stake_polyx',
    'self_stake_ratio',
    'nominators',
    // Every return column names its period, its commission basis and the
    // statistic it is — a bare `apr` column in a spreadsheet is the ambiguity
    // worth avoiding, and so is calling a median a mean. `spread`, not
    // `stddev`: these are robust estimators (see `robustSpread`), σ-comparable
    // but not a sample standard deviation.
    'apr_this_era_est_net',
    'apr_this_era_est_gross',
    'apr_last_era_net',
    'apr_last_era_gross',
    'last_era',
    'apr_range_median_net',
    'apr_range_median_gross',
    'apr_range_spread_net',
    'points_this_era',
    'points_share',
    'exposure_pages',
  ];

  const escape = (value: string) => (/[",\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value);
  const num = (value: number | null) => (value == null ? '' : String(value));

  const lines = rows.map((row) =>
    [
      escape(row.name),
      row.address,
      row.status,
      num(row.commission),
      num(row.totalStake),
      num(row.ownStake),
      num(row.selfStakeRatio),
      num(row.nominatorCount),
      num(row.aprThisEra),
      num(row.aprThisEraGross),
      num(row.aprLastEra),
      num(row.aprLastEraGross),
      num(row.lastEraIndex),
      num(row.aprMedian),
      num(row.aprMedianGross),
      num(row.aprSpread),
      num(row.pointsThisEra),
      num(row.pointsShare),
      num(row.pageCount),
    ].join(','),
  );

  return [header.join(','), ...lines].join('\n');
}
