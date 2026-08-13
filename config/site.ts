/**
 * Site-level constants. `BASE_PATH` and the data origin are the two values that
 * change when the site moves host (design doc Q3/Q7), so nothing may hardcode
 * either — including the data layer, which resolves every fetch through
 * `dataUrl()`.
 */

export const SITE = {
  name: 'Polymesh Staking Analytics',
  shortName: 'Polymesh Staking',
  description:
    'Track staking on Polymesh: operator performance, rewards, network health, and your own position.',
  repository: 'https://github.com/F-OBrien/polymesh-staking-analytics',
} as const;

/** Matches `basePath` in next.config.ts. Empty string, or a path with a leading slash. */
export const BASE_PATH = process.env.NEXT_PUBLIC_BASE_PATH ?? '/polymesh-staking-analytics';

/**
 * Absolute origin, for the handful of places a relative URL will not do.
 *
 * Open Graph and the sitemap both need fully-qualified URLs — a link shared in
 * a chat client is resolved by that client, which has no idea what our base
 * path is. Everything else on the site uses relative URLs, so this is the only
 * value that has to know where the site is actually hosted.
 */
export const SITE_ORIGIN = process.env.NEXT_PUBLIC_SITE_ORIGIN ?? 'https://f-obrien.github.io';

/** Fully-qualified URL for a route path such as `/operators/`. */
export function absoluteUrl(path = '/'): string {
  const clean = path.startsWith('/') ? path : `/${path}`;
  return `${SITE_ORIGIN}${BASE_PATH}${clean === '/' ? '/' : clean}`;
}

/**
 * Removes the base path from an absolute site URL, giving a path relative to
 * the export root.
 *
 * For the build scripts, which walk `out/` and resolve the `<script src>` refs
 * in the emitted HTML. They each carried their own copy of the base path in a
 * regex, which survived the move to this repository only because it was
 * grepped for: a stale copy resolves every script to a missing file, and both
 * scripts treat a missing file as "nothing to weigh" rather than as an error —
 * so the budget would have reported every route at 0 KB and passed.
 */
export function stripBasePath(url: string): string {
  return BASE_PATH !== '' && url.startsWith(BASE_PATH) ? url.slice(BASE_PATH.length) : url;
}

/**
 * Where the generated data files live. Defaults to the site's own origin, which
 * is what GitHub Pages gives us. Point this at R2 or any CDN to move the data
 * without touching client code.
 */
const DATA_BASE_URL = process.env.NEXT_PUBLIC_DATA_BASE_URL ?? `${BASE_PATH}/data`;

/** Builds a URL for a generated data file. `path` is relative to the data root. */
export function dataUrl(path: string): string {
  const clean = path.startsWith('/') ? path.slice(1) : path;
  return `${DATA_BASE_URL.replace(/\/$/, '')}/${clean}`;
}

/**
 * Eras per chunk file. Shared by the pipeline (which writes them) and the
 * client (which resolves an era range to a chunk set), so it lives here rather
 * than being duplicated. Changing it invalidates every existing chunk.
 */
export const CHUNK_SIZE = 32;

/**
 * Era window shown by default. Full history runs to ~1,700 eras (design doc
 * §6.5a) and loading all of it on every visit would blow the payload budget;
 * 90 eras is roughly three chunks.
 */
export const DEFAULT_ERA_WINDOW = 90;
