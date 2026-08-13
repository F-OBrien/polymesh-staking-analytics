import { resolveIndexerUrl } from '@/config/networks';

/**
 * The SubQuery indexer client. Reward history is the one thing unavailable from
 * chain state at any depth: an era's total is stored, but who was paid what
 * exists only as `Rewarded` events.
 *
 * Plain `fetch` rather than a GraphQL client: two query shapes in total, no
 * need for a normalised cache (TanStack Query has one), and it keeps this
 * module free of any Polkadot dependency so a pasted address can show reward
 * history without loading megabytes.
 *
 * The endpoint's rate limit is undocumented, which is why `fetchAllPages` is
 * sequential.
 */

/** The endpoint caps a single response at 100 rows regardless of what we ask. */
export const INDEXER_PAGE_SIZE = 100;

/** A hard stop, so a pathological account cannot spin forever. */
const MAX_PAGES = 200;

export class IndexerError extends Error {
  constructor(
    message: string,
    readonly detail?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'IndexerError';
  }
}

export interface GraphQlOptions {
  signal?: AbortSignal | undefined;
  /** Overrides the configured endpoint. Tests and local indexers only. */
  endpoint?: string | undefined;
  fetchImpl?: typeof fetch | undefined;
}

interface GraphQlResponse<T> {
  data?: T;
  errors?: { message: string }[];
}

/**
 * One GraphQL request. Note a failed query answers `200 OK` with an `errors`
 * array, so `response.ok` alone is not a success signal — checking only that
 * surfaces a schema error as "no rewards found".
 */
export async function graphql<T>(
  query: string,
  variables: Record<string, unknown>,
  { signal, endpoint, fetchImpl = fetch }: GraphQlOptions = {},
): Promise<T> {
  const url = endpoint ?? resolveIndexerUrl();

  let response: Response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ query, variables }),
      ...(signal ? { signal } : {}),
    });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new IndexerError(
      'Could not reach the indexer. Reward history is unavailable right now.',
      undefined,
      { cause },
    );
  }

  if (!response.ok) {
    throw new IndexerError(
      `The indexer returned ${response.status}.`,
      response.status === 429 ? 'The endpoint is rate-limited; try again shortly.' : undefined,
    );
  }

  let body: GraphQlResponse<T>;
  try {
    body = (await response.json()) as GraphQlResponse<T>;
  } catch (cause) {
    throw new IndexerError('The indexer returned a response we could not read.', undefined, {
      cause,
    });
  }

  if (body.errors?.length) {
    throw new IndexerError(
      'The indexer rejected the query.',
      body.errors.map((e) => e.message).join('; '),
    );
  }

  if (body.data == null) {
    throw new IndexerError('The indexer returned no data.');
  }

  return body.data;
}

/**
 * Parses an indexer timestamp to unix seconds. The endpoint emits UTC without a
 * zone marker and `Date.parse` reads a bare datetime as *local* time, shifting
 * every reward by hours — enough to land in the wrong era. `Z` is appended only
 * when the string does not already carry a zone, or the result is `…ZZ`.
 *
 * Widths vary (fractional seconds appear inconsistently), which is also why
 * this field must never be a sort key. Returns 0 for anything unreadable.
 */
export function parseIndexerDate(datetime: string | null | undefined): number {
  if (!datetime) return 0;
  const zoned = /(?:Z|[+-]\d{2}:?\d{2})$/.test(datetime) ? datetime : `${datetime}Z`;
  const parsed = Date.parse(zoned);
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
}

export interface Page<T> {
  nodes: T[];
  hasNextPage: boolean;
}

/**
 * Walks every page of a paginated query, sequentially: the rate limit is
 * undocumented, an account with years of history is dozens of requests, and
 * this runs in a user's browser where a 429 is visible.
 *
 * `MAX_PAGES` bounds it. Hitting the cap returns what was collected and flags
 * it rather than throwing — a partial history is still useful.
 */
export async function fetchAllPages<T>(
  loadPage: (offset: number) => Promise<Page<T>>,
): Promise<{ nodes: T[]; truncated: boolean }> {
  const nodes: T[] = [];

  for (let page = 0; page < MAX_PAGES; page += 1) {
    const { nodes: batch, hasNextPage } = await loadPage(page * INDEXER_PAGE_SIZE);
    nodes.push(...batch);

    // An empty page also ends the walk, or an indexer reporting `hasNextPage`
    // while returning nothing loops to the cap.
    if (!hasNextPage || batch.length === 0) return { nodes, truncated: false };
  }

  return { nodes, truncated: true };
}
