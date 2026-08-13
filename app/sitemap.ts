import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/config/site';

/**
 * The routes worth indexing.
 *
 * Written out rather than derived from the filesystem, because the two things
 * that would have to be excluded are exactly the two a filesystem walk would
 * include: `/kitchen-sink` is an internal workbench, and the 131 prerendered
 * operator pages would bury five real routes under a list that turns over as
 * the validator set changes. Operator pages are reachable from `/operators`,
 * which is in here.
 */
export const dynamic = 'force-static';

export default function sitemap(): MetadataRoute.Sitemap {
  const routes = [
    '/',
    '/operators/',
    '/compare/',
    '/my-staking/',
    '/calculator/',
    '/slashing/',
    '/about/',
  ];

  return routes.map((path) => ({
    url: absoluteUrl(path),
    changeFrequency: path === '/about/' ? 'monthly' : 'daily',
    priority: path === '/' ? 1 : 0.7,
  }));
}
