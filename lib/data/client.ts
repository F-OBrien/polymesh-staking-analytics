import { dataUrl } from '@/config/site';
import type {
  Chunk,
  ChunkRef,
  EraIndexFile,
  Latest,
  Manifest,
  Offences,
  OperatorRegistry,
  Rollup,
  Slashes,
} from '@/lib/schemas/data';
import { readCachedChunk, writeCachedChunk } from './cache';
import { validateData, type DataFileKind } from './validate';

/**
 * Fetching the generated data files. The schema imports here are type-only and
 * erased at compile time; runtime validation goes through `./validate`, which
 * keeps Zod out of the production bundle.
 */

/** Thrown for any data-layer failure, so the UI can distinguish it from a bug. */
export class DataFetchError extends Error {
  constructor(
    message: string,
    readonly url: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = 'DataFetchError';
  }
}

interface FetchOptions {
  signal?: AbortSignal;
  /** `force-cache` for immutable chunks; `no-cache` for anything time-sensitive. */
  cache?: RequestCache;
}

async function fetchJson<K extends DataFileKind>(
  path: string,
  kind: K,
  { signal, cache = 'default' }: FetchOptions = {},
) {
  const url = dataUrl(path);

  let response: Response;
  try {
    // Spread conditionally, not passed as `undefined`: RequestInit declares
    // `AbortSignal | null`, which under exactOptionalPropertyTypes differs
    // from an absent property.
    response = await fetch(url, { cache, ...(signal ? { signal } : {}) });
  } catch (cause) {
    if (signal?.aborted) throw cause;
    throw new DataFetchError(`Could not reach ${path}. Check your connection.`, url, { cause });
  }

  if (!response.ok) {
    throw new DataFetchError(`${path} returned ${response.status}.`, url);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch (cause) {
    throw new DataFetchError(`${path} is not valid JSON.`, url, { cause });
  }

  try {
    return await validateData(kind, body);
  } catch (cause) {
    throw new DataFetchError(
      `${path} does not match the expected schema. The site and its data may be out of step.`,
      url,
      { cause },
    );
  }
}

/**
 * The manifest, always fetched fresh. It is a kilobyte and the only thing that
 * reveals which chunks exist, so caching it strands a client on yesterday's era.
 */
export function fetchManifest(options?: FetchOptions): Promise<Manifest> {
  return fetchJson('manifest.json', 'manifest', { ...options, cache: 'no-cache' });
}

/**
 * One chunk, preferring the IndexedDB copy.
 *
 * The content hash in the query string is load-bearing: a chunk file is not
 * actually immutable — a backfill can rewrite one to fill in eras it never held
 * — and `force-cache` serves a cached response without revalidating at all. Keep
 * the hash so different content is always a different URL, or a stale copy is
 * served under a name that now means something else and then written into
 * IndexedDB under the new manifest hash, making it permanent.
 */
export async function fetchChunk(ref: ChunkRef, options?: FetchOptions): Promise<Chunk> {
  const cached = await readCachedChunk(ref.hash);
  if (cached) return cached;

  const chunk = await fetchJson(`${ref.path}?v=${ref.hash}`, 'chunk', {
    ...options,
    cache: 'force-cache',
  });

  await writeCachedChunk(ref.hash, chunk);
  return chunk;
}

/**
 * Several chunks at once, in parallel — a 90-era window is three files, and
 * after the first visit most come from IndexedDB anyway.
 */
export function fetchChunks(refs: readonly ChunkRef[], options?: FetchOptions): Promise<Chunk[]> {
  return Promise.all(refs.map((ref) => fetchChunk(ref, options)));
}

/** The 15-minute snapshot. Short-lived, so never served from a stale cache. */
export function fetchLatest(options?: FetchOptions): Promise<Latest> {
  return fetchJson('latest.json', 'latest', { ...options, cache: 'no-cache' });
}

export function fetchOperators(options?: FetchOptions): Promise<OperatorRegistry> {
  return fetchJson('operators.json', 'operators', options);
}

/** Network-only weekly series, for ranges too long to load chunks for. */
export function fetchRollup(options?: FetchOptions): Promise<Rollup> {
  return fetchJson('rollup-weekly.json', 'rollup', options);
}

/**
 * Slash history. Rewritten wholesale by the pipeline rather than appended to,
 * so it is not hard-cached — an era leaving the chain's retention window
 * changes `prunedBefore` without changing any event.
 */
export function fetchSlashes(options?: FetchOptions): Promise<Slashes> {
  return fetchJson('slashes.json', 'slashes', options);
}

/**
 * Offences reported against operators, over all history. Separate from
 * `slashes.json` because the sources differ in kind: that file comes from chain
 * state, pruned to ~84 eras and recording only what was taken; this one comes
 * from indexer events, which reach genesis and fire regardless. With validator
 * slashing switched off, this is the file with the content.
 */
export function fetchOffences(options?: FetchOptions): Promise<Offences> {
  return fetchJson('offences.json', 'offences', options);
}

/**
 * Every era's start block and time, for the chain's whole life. Not fetched by
 * default: chunks carry `eraStart` for the eras they hold, which covers every
 * chart axis, so this is only for dates outside that window.
 */
export function fetchEraIndex(options?: FetchOptions): Promise<EraIndexFile> {
  return fetchJson('era-index.json', 'eraIndex', options);
}
