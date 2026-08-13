import {
  fetchAllPages,
  graphql,
  INDEXER_PAGE_SIZE,
  parseIndexerDate,
  type GraphQlOptions,
  type Page,
} from './client';

/**
 * Reward history for a stash. Who was paid what exists only as `Rewarded`
 * events, so this is the one part of the app that needs an indexer.
 *
 * Output has to survive export to a spreadsheet and reconciliation against a
 * block explorer: amounts stay exact base-unit strings until the last possible
 * moment, and every row keeps its block and era.
 */

/**
 * A `Rewarded` staking event. `amount` is a base-unit string, never a number —
 * a lifetime of rewards exceeds what a float represents exactly.
 */
export interface RewardEvent {
  /**
   * The era whose work earned this reward, not the era it was paid in — a
   * payout is always made after the era it pays for has closed, so the two
   * differ by one. Both are carried, and neither is exported unqualified.
   *
   * Filled from `era-index.json`. Null means genuinely outside the known range;
   * never default it to 0, which exports as a confident "era 0".
   */
  earnedEra: number | null;
  /** The era this payout landed in. Always `earnedEra + 1` when both are known. */
  paidEra: number | null;
  blockNumber: number;
  /** Index of the event within its block. Addresses the event on an explorer. */
  eventIndex: number;
  /** Unix seconds. */
  datetime: number;
  amount: string;
}

interface RawStakingEvent {
  id: string;
  createdBlockId: string;
  eventId: string;
  amount: string | number | null;
  datetime: string;
  stashAccount: string | null;
  identityId: string | null;
}

interface StakingEventsResponse {
  stakingEvents: {
    nodes: RawStakingEvent[];
    pageInfo: { hasNextPage: boolean };
  };
}

/**
 * Every reward paid to a stash, oldest first. Two schema details that fail
 * silently rather than loudly:
 *
 *  - The block field is `createdBlockId`, not `blockId`.
 *  - `eventId` must match both `Reward` and `Rewarded`. Polymesh renamed the
 *    event across a runtime upgrade; filtering on one spelling returns a
 *    plausible-looking lifetime total missing its early years.
 *
 * Order by `CREATED_BLOCK_ID_ASC`, not `DATETIME_ASC`: the block id is
 * zero-padded to ten digits so a string sort is a numeric sort, whereas
 * `datetime` is compared as a string and is not fixed-width (fractional seconds
 * appear inconsistently). `ID_ASC` breaks ties within a block.
 */
const REWARDS_QUERY = `
  query RewardsForStash($stash: String!, $first: Int!, $offset: Int!) {
    stakingEvents(
      filter: {
        stashAccount: { equalTo: $stash }
        eventId: { in: [Reward, Rewarded] }
      }
      orderBy: [CREATED_BLOCK_ID_ASC, ID_ASC]
      first: $first
      offset: $offset
    ) {
      nodes {
        id
        createdBlockId
        eventId
        amount
        datetime
        stashAccount
        identityId
      }
      pageInfo {
        hasNextPage
      }
    }
  }
`;

export interface FetchRewardsOptions extends GraphQlOptions {
  /**
   * Which era a payout was earned in, given the block it was paid in. Injected
   * so this module stays free of our own data files. Returns null for anything
   * it cannot place, which becomes a blank cell rather than an invented era.
   */
  earnedEra?: ((blockNumber: number) => number | null) | undefined;
}

/**
 * Every `Rewarded` event for a stash, oldest first. `truncated` marks a history
 * cut short by the page cap, so the UI can say so rather than show a wrong
 * lifetime total.
 */
export async function fetchRewards(
  stash: string,
  { earnedEra, ...options }: FetchRewardsOptions = {},
): Promise<{ events: RewardEvent[]; truncated: boolean }> {
  const loadPage = async (offset: number): Promise<Page<RawStakingEvent>> => {
    const data = await graphql<StakingEventsResponse>(
      REWARDS_QUERY,
      { stash, first: INDEXER_PAGE_SIZE, offset },
      options,
    );
    return {
      nodes: data.stakingEvents.nodes,
      hasNextPage: data.stakingEvents.pageInfo.hasNextPage,
    };
  };

  const { nodes, truncated } = await fetchAllPages(loadPage);
  return { events: nodes.map((node) => toRewardEvent(node, earnedEra)), truncated };
}

/**
 * Headline totals for a stash in one request, so the page need not walk every
 * payout (paginated at a hard 100-row server cap) just to print a total.
 *
 * The aggregate set is narrow: `min`/`max` over `datetime` are not offered, so
 * the date range comes from one row at each end of the block ordering.
 */
const REWARD_SUMMARY_QUERY = `
  query RewardSummaryForStash($stash: String!) {
    totals: stakingEvents(
      filter: {
        stashAccount: { equalTo: $stash }
        eventId: { in: [Reward, Rewarded] }
      }
    ) {
      totalCount
      aggregates { sum { amount } }
    }
    first: stakingEvents(
      filter: {
        stashAccount: { equalTo: $stash }
        eventId: { in: [Reward, Rewarded] }
      }
      orderBy: [CREATED_BLOCK_ID_ASC, ID_ASC]
      first: 1
    ) {
      nodes { id createdBlockId amount datetime }
    }
    last: stakingEvents(
      filter: {
        stashAccount: { equalTo: $stash }
        eventId: { in: [Reward, Rewarded] }
      }
      orderBy: [CREATED_BLOCK_ID_DESC, ID_DESC]
      first: 1
    ) {
      nodes { id createdBlockId amount datetime }
    }
  }
`;

interface SummaryNode {
  id: string;
  createdBlockId: string;
  amount: string | number | null;
  datetime: string;
}

interface SummaryResponse {
  totals: {
    totalCount: number;
    aggregates: { sum: { amount: string | number | null } | null } | null;
  };
  first: { nodes: SummaryNode[] };
  last: { nodes: SummaryNode[] };
}

export interface RewardTotals {
  /** Exact lifetime total, in base units. */
  total: bigint;
  /** Number of payout events. Drives whether the detail walk is worth it. */
  count: number;
  /** Oldest payout. Needed to know over what period a return was realised. */
  first: RewardEvent | null;
  /** Newest payout. */
  last: RewardEvent | null;
}

/**
 * Lifetime total, count, and the first and last payout — without downloading
 * the payouts. One request, three aliased selections, so "realised return" and
 * "last payout" render without walking every event.
 */
export async function fetchRewardTotals(
  stash: string,
  { earnedEra, ...options }: FetchRewardsOptions = {},
): Promise<RewardTotals> {
  const data = await graphql<SummaryResponse>(REWARD_SUMMARY_QUERY, { stash }, options);
  const edge = (nodes: SummaryNode[]) => (nodes[0] ? toRewardEvent(nodes[0], earnedEra) : null);

  return {
    total: BigInt(toBaseUnits(data.totals.aggregates?.sum?.amount)),
    count: data.totals.totalCount,
    first: edge(data.first.nodes),
    last: edge(data.last.nodes),
  };
}

/**
 * How many paginated requests a full detail walk would cost, so the UI can ask
 * before spending minutes of someone's connection.
 */
export function pagesFor(count: number): number {
  return Math.ceil(count / INDEXER_PAGE_SIZE);
}

/**
 * Normalises one indexer row. Defensive because the endpoint is someone else's:
 * a row we cannot read becomes a zero rather than a crash, so one bad event
 * does not blank an entire reward history.
 */
export function toRewardEvent(
  node: {
    id?: string;
    createdBlockId: string;
    amount: string | number | null;
    datetime: string;
  },
  earnedEra?: ((blockNumber: number) => number | null) | undefined,
): RewardEvent {
  const blockNumber = Number.parseInt(node.createdBlockId, 10);
  const safeBlock = Number.isFinite(blockNumber) ? blockNumber : 0;
  const earned = earnedEra?.(safeBlock) ?? null;

  return {
    earnedEra: earned,
    paidEra: earned == null ? null : earned + 1,
    blockNumber: safeBlock,
    eventIndex: parseEventIndex(node.id),
    datetime: parseIndexerDate(node.datetime),
    amount: toBaseUnits(node.amount),
  };
}

/**
 * The event's position within its block, from the indexer's `blockId/eventIdx`
 * id. Both halves are zero-padded, which is what makes the id sortable.
 */
export function parseEventIndex(id: string | undefined): number {
  const index = Number.parseInt(id?.split('/')[1] ?? '', 10);
  return Number.isFinite(index) ? index : 0;
}

/**
 * Normalises an indexer `amount` to an exact base-unit string.
 *
 * The schema types this as `BigFloat`, so it arrives as a string, sometimes
 * with a `.0` tail, and in principle as a number. Downstream sums in `bigint`,
 * so the result must be integral; a fractional part is discarded rather than
 * rounded, since it can only be an artefact of the float encoding.
 */
export function toBaseUnits(amount: string | number | null | undefined): string {
  if (amount == null) return '0';

  const text = typeof amount === 'number' ? amount.toFixed(0) : amount.trim();
  // Rejects scientific notation, which would lose precision through Number.
  const match = /^(\d+)(?:\.\d+)?$/.exec(text);
  return match?.[1] ?? '0';
}

// ---------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------

export interface RewardSummary {
  /** Exact lifetime total, in base units. */
  total: bigint;
  count: number;
  first: RewardEvent | null;
  last: RewardEvent | null;
}

/** Sums in bigint, so a lifetime total is exact rather than nearly right. */
export function summariseRewards(events: readonly RewardEvent[]): RewardSummary {
  let total = 0n;
  for (const event of events) total += BigInt(event.amount);

  return {
    total,
    count: events.length,
    first: events[0] ?? null,
    last: events.at(-1) ?? null,
  };
}

export interface DailyReward {
  /** Unix seconds at the start of the bucket, UTC. */
  day: number;
  amount: bigint;
}

/**
 * How finely to bucket a reward history. Daily is the natural grain (one era,
 * one day), but a multi-year history needs coarser grouping to stay readable.
 */
export type RewardPeriod = 'day' | 'week' | 'month' | 'year';

const DAY_SECONDS = 86_400;

/**
 * Start of the bucket a moment falls in. UTC throughout, so boundaries do not
 * drift with the reader's timezone. Weeks start Monday per ISO-8601 —
 * `getUTCDay()` returns 0 for Sunday, hence the shift.
 */
export function periodStart(unixSeconds: number, period: RewardPeriod): number {
  const date = new Date(unixSeconds * 1000);

  switch (period) {
    case 'day':
      return Math.floor(unixSeconds / DAY_SECONDS) * DAY_SECONDS;
    case 'week': {
      const dayOfWeek = (date.getUTCDay() + 6) % 7;
      const midnight = Math.floor(unixSeconds / DAY_SECONDS) * DAY_SECONDS;
      return midnight - dayOfWeek * DAY_SECONDS;
    }
    case 'month':
      return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1) / 1000);
    case 'year':
      return Math.floor(Date.UTC(date.getUTCFullYear(), 0, 1) / 1000);
  }
}

/** The next bucket after `start`. Calendar-aware, so months keep their length. */
function nextPeriod(start: number, period: RewardPeriod): number {
  const date = new Date(start * 1000);
  switch (period) {
    case 'day':
      return start + DAY_SECONDS;
    case 'week':
      return start + 7 * DAY_SECONDS;
    case 'month':
      return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1) / 1000);
    case 'year':
      return Math.floor(Date.UTC(date.getUTCFullYear() + 1, 0, 1) / 1000);
  }
}

/**
 * Groups rewards into buckets for charting, by when the payout landed rather
 * than the era earned — several eras can be claimed in one transaction, which
 * would draw as a spike.
 *
 * Empty buckets are filled in, so a gap in earning renders as a flat stretch
 * rather than a jump between two distant points.
 */
export function rewardsByPeriod(
  events: readonly RewardEvent[],
  period: RewardPeriod = 'day',
): DailyReward[] {
  if (events.length === 0) return [];

  const buckets = new Map<number, bigint>();
  for (const event of events) {
    if (event.datetime === 0) continue;
    const start = periodStart(event.datetime, period);
    buckets.set(start, (buckets.get(start) ?? 0n) + BigInt(event.amount));
  }

  const keys = [...buckets.keys()].sort((a, b) => a - b);
  const first = keys[0];
  const last = keys.at(-1);
  if (first == null || last == null) return [];

  const filled: DailyReward[] = [];
  for (let start = first; start <= last; start = nextPeriod(start, period)) {
    filled.push({ day: start, amount: buckets.get(start) ?? 0n });
  }
  return filled;
}

/** Daily buckets — reads better at the call site than a defaulted argument. */
export function rewardsByDay(events: readonly RewardEvent[]): DailyReward[] {
  return rewardsByPeriod(events, 'day');
}

/**
 * The coarsest grain that still shows detail. Thresholds keep the chart near
 * ~120 buckets, where a bar is still wide enough to see and to point at.
 */
export function suggestPeriod(events: readonly RewardEvent[]): RewardPeriod {
  const times = events.map((e) => e.datetime).filter((t) => t > 0);
  if (times.length === 0) return 'day';
  const spanDays = (Math.max(...times) - Math.min(...times)) / DAY_SECONDS;

  if (spanDays <= 120) return 'day';
  if (spanDays <= 730) return 'week';
  if (spanDays <= 3650) return 'month';
  return 'year';
}

/** Running total, for the "what have I earned so far" line. */
export function cumulativeRewards(daily: readonly DailyReward[]): DailyReward[] {
  let running = 0n;
  return daily.map(({ day, amount }) => {
    running += amount;
    return { day, amount: running };
  });
}

/**
 * Realised return over a window, annualised. Not directly comparable to the APR
 * shown elsewhere: it divides rewards received by the amount *currently*
 * bonded, so bonding more part-way through reads low. The UI says so.
 */
export function realisedApr({
  rewards,
  bonded,
  days,
}: {
  rewards: bigint;
  bonded: bigint;
  days: number;
}): number | null {
  if (bonded <= 0n || days <= 0 || rewards < 0n) return null;
  // Float is safe here: the exactness that matters was preserved in the sum.
  const ratio = Number(rewards) / Number(bonded);
  return (ratio * 365) / days;
}

/**
 * CSV of a reward history for reporting. Carries the block and the exact
 * base-unit amount alongside the human-readable POLYX, so any row can be
 * reconciled against a block explorer.
 */
export function rewardsToCsv(
  events: readonly RewardEvent[],
  tokenDecimals: number,
  /** Injected so this module stays free of network config. */
  eventUrl?: (blockNumber: number, eventIndex: number) => string,
): string {
  const header = [
    'date_utc',
    // Never a bare `era` column — earned and paid-in differ by one.
    'era_earned',
    'era_paid_in',
    'block',
    'event_index',
    'event_id',
    'amount_polyx',
    'amount_base_units',
    ...(eventUrl ? ['explorer_url'] : []),
  ];
  const divisor = 10 ** tokenDecimals;
  const pad = (value: number) => String(value).padStart(10, '0');

  const lines = events.map((event) =>
    [
      event.datetime > 0 ? new Date(event.datetime * 1000).toISOString() : '',
      // Blank rather than 0: an invented era is worse than an empty cell in a
      // file filed for reporting.
      event.earnedEra == null ? '' : String(event.earnedEra),
      event.paidEra == null ? '' : String(event.paidEra),
      String(event.blockNumber),
      String(event.eventIndex),
      // The indexer's own id, so a row can be matched back to the source.
      `${pad(event.blockNumber)}/${pad(event.eventIndex)}`,
      (Number(event.amount) / divisor).toFixed(tokenDecimals),
      event.amount,
      ...(eventUrl ? [eventUrl(event.blockNumber, event.eventIndex)] : []),
    ].join(','),
  );

  return [header.join(','), ...lines].join('\n');
}
