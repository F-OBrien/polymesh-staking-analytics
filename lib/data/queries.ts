'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { useMemo } from 'react';
import { DEFAULT_ERA_WINDOW } from '@/config/site';
import { chunksForRange } from './chunking';
import type { RewardSplit } from '@/lib/metrics/rewards';
import { prefersRollup, rollupToSeries } from './rollup-series';
import {
  fetchChunks,
  fetchLatest,
  fetchManifest,
  fetchOperators,
  fetchEraIndex,
  fetchOffences,
  fetchRollup,
  fetchSlashes,
} from './client';
import { createEraIndex, type EraIndex } from './era-index';
import { pruneCache } from './cache';
import { stitchChunks, type StitchedSeries } from './series';
import type {
  Latest,
  Manifest,
  Offences,
  OperatorRegistry,
  Rollup,
  Slashes,
} from '@/lib/schemas/data';

/**
 * Query hooks over the generated data. Every query states its staleness
 * explicitly rather than taking a default:
 *
 *  - Chunks: `Infinity` — immutable by construction.
 *  - Manifest: one minute — the only thing that reveals a new era.
 *  - Latest: one minute — regenerated every fifteen, so faster is waste.
 *  - Operators: one hour — names change roughly never.
 */

export const queryKeys = {
  manifest: ['manifest'] as const,
  operators: ['operators'] as const,
  latest: ['latest'] as const,
  rollup: ['rollup'] as const,
  slashes: ['slashes'] as const,
  offences: ['offences'] as const,
  eraIndex: ['era-index'] as const,
  chunks: (hashes: readonly string[]) => ['chunks', ...hashes] as const,
};

const MINUTE = 60_000;

export function useManifest(): UseQueryResult<Manifest> {
  return useQuery({
    queryKey: queryKeys.manifest,
    queryFn: ({ signal }) => fetchManifest({ signal }),
    staleTime: MINUTE,
    // A new era every 24h; hourly is ample and costs one kilobyte.
    refetchInterval: 60 * MINUTE,
  });
}

export function useOperators(): UseQueryResult<OperatorRegistry> {
  return useQuery({
    queryKey: queryKeys.operators,
    queryFn: ({ signal }) => fetchOperators({ signal }),
    staleTime: 60 * MINUTE,
  });
}

/**
 * The active-era snapshot. Era progress and countdowns are computed in the
 * browser from its anchors (§6.6a), so this needs no aggressive polling to keep
 * a countdown moving.
 */
export function useLatest(): UseQueryResult<Latest> {
  return useQuery({
    queryKey: queryKeys.latest,
    queryFn: ({ signal }) => fetchLatest({ signal }),
    staleTime: MINUTE,
    refetchInterval: 5 * MINUTE,
  });
}

export function useRollup(enabled = true): UseQueryResult<Rollup> {
  return useQuery({
    queryKey: queryKeys.rollup,
    queryFn: ({ signal }) => fetchRollup({ signal }),
    staleTime: 60 * MINUTE,
    enabled,
  });
}

/**
 * Slash history, within the chain's un-pruned window. An hour is generous for a
 * file that can only change when an era completes.
 */
export function useSlashes(enabled = true): UseQueryResult<Slashes> {
  return useQuery({
    queryKey: queryKeys.slashes,
    queryFn: ({ signal }) => fetchSlashes({ signal }),
    staleTime: 60 * MINUTE,
    enabled,
  });
}

/**
 * Offences reported against operators, over all history. Opt-in — only the
 * operator pages and `/slashing` use it.
 */
export function useOffences(enabled = true): UseQueryResult<Offences> {
  return useQuery({
    queryKey: queryKeys.offences,
    queryFn: ({ signal }) => fetchOffences({ signal }),
    staleTime: 60 * MINUTE,
    enabled,
  });
}

/**
 * Era to date, over all history. Opt-in because chunks already carry `eraStart`
 * for everything they hold; this covers eras outside that window, such as a
 * reward paid years ago. Immutable in practice — a past era's start never
 * changes and a new one is appended once a day.
 */
export function useEraIndex(enabled = true): UseQueryResult<EraIndex> {
  return useQuery({
    queryKey: queryKeys.eraIndex,
    queryFn: async ({ signal }) => createEraIndex(await fetchEraIndex({ signal })),
    staleTime: 60 * MINUTE,
    enabled,
  });
}

export interface EraRange {
  fromEra: number;
  toEra: number;
}

/**
 * Resolves an era range against the manifest; `undefined` selects the most
 * recent `DEFAULT_ERA_WINDOW` eras. Clamped to what exists, so a range past
 * ingested history yields the available subset — the UI reports coverage
 * separately rather than the query failing.
 */
export function resolveRange(manifest: Manifest | undefined, requested?: Partial<EraRange>): EraRange | null {
  if (!manifest) return null;

  const toEra = Math.min(requested?.toEra ?? manifest.lastCompleteEra, manifest.lastCompleteEra);
  const fromEra = Math.max(
    requested?.fromEra ?? toEra - DEFAULT_ERA_WINDOW + 1,
    manifest.firstEra,
  );

  return fromEra > toEra ? null : { fromEra, toEra };
}

export interface SeriesResult {
  series: StitchedSeries | null;
  range: EraRange | null;
  isLoading: boolean;
  isError: boolean;
  error: Error | null;
  /** True while widening a range pulls in chunks not yet cached. */
  isFetching: boolean;
}

/**
 * Loads exactly the chunks a range needs, and stitches them. The manifest lists
 * each chunk's span, so a 90-era window resolves to three files (§6.5a) and
 * widening fetches only what is not already held. Keyed by chunk hash, so
 * overlapping ranges share cache entries.
 */
export function useEraSeries(
  requested?: Partial<EraRange>,
  /**
   * Set false to resolve the range but fetch nothing. `useNetworkSeries` needs
   * this: hooks cannot be called conditionally, so the chunk query exists even
   * when the rollup is serving the range and would otherwise download dozens of
   * chunk files nothing reads.
   */
  { enabled = true }: { enabled?: boolean } = {},
): SeriesResult {
  const manifest = useManifest();
  const range = resolveRange(manifest.data, requested);

  const refs = useMemo(
    () =>
      manifest.data && range && enabled
        ? chunksForRange(manifest.data.chunks, range.fromEra, range.toEra)
        : [],
    [manifest.data, range?.fromEra, range?.toEra, enabled], // eslint-disable-line react-hooks/exhaustive-deps
  );

  const chunks = useQuery({
    queryKey: queryKeys.chunks(refs.map((r) => r.hash)),
    queryFn: async ({ signal }) => {
      const loaded = await fetchChunks(refs, { signal });
      // Drop cache entries the manifest no longer references, so the store
      // does not grow by one dead chunk per era.
      void pruneCache(new Set(manifest.data?.chunks.map((c) => c.hash) ?? []));
      return loaded;
    },
    enabled: refs.length > 0,
    staleTime: Number.POSITIVE_INFINITY,
  });

  const series = useMemo(
    () => (chunks.data && range ? stitchChunks(chunks.data, range) : null),
    [chunks.data, range?.fromEra, range?.toEra], // eslint-disable-line react-hooks/exhaustive-deps
  );

  return {
    series,
    range,
    isLoading: manifest.isLoading || (refs.length > 0 && chunks.isLoading),
    isFetching: manifest.isFetching || chunks.isFetching,
    isError: manifest.isError || chunks.isError,
    error: (manifest.error ?? chunks.error) as Error | null,
  };
}


/**
 * The network series for a range, at whatever resolution it warrants: chunk
 * data era by era below the threshold, the weekly rollup above it — one small
 * file rather than dozens of chunks for a five-year chart nobody reads a single
 * era's value from.
 *
 * The switch is never hidden; the caller puts `resolution` in the chart's
 * coverage line. Chunks remain the fallback, so a missing `rollup-weekly.json`
 * degrades to slow rather than blank.
 */
export function useNetworkSeries(requested?: Partial<EraRange>): SeriesResult & {
  resolution: 'era' | 'week';
  /**
   * The reward split, when it came from the rollup. Returned explicitly rather
   * than sniffed off the series: it is derivable from `operators` at era
   * resolution and can only be carried at week resolution.
   */
  rewardSplit: RewardSplit | undefined;
} {
  const manifest = useManifest();
  const range = resolveRange(manifest.data, requested);
  const wantsRollup = prefersRollup(range);

  const rollup = useRollup(wantsRollup);
  const weekly = useMemo(() => rollupToSeries(rollup.data, range), [rollup.data, range]);

  // Suppressed only once the rollup has actually produced a series. Caching is
  // by chunk hash, so stepping 90d -> All -> 90d pays for chunks once.
  const eraSeries = useEraSeries(requested, { enabled: !(wantsRollup && weekly) });

  if (wantsRollup && weekly) {
    return {
      series: weekly,
      range,
      isLoading: manifest.isLoading || rollup.isLoading,
      isFetching: manifest.isFetching || rollup.isFetching,
      isError: manifest.isError,
      error: manifest.error as Error | null,
      resolution: 'week',
      rewardSplit: weekly.rewardSplit,
    };
  }

  return { ...eraSeries, resolution: 'era', rewardSplit: undefined };
}
