import type { MetadataRoute } from 'next';
import { absoluteUrl } from '@/config/site';

export const dynamic = 'force-static';

export default function robots(): MetadataRoute.Robots {
  return {
    rules: {
      userAgent: '*',
      allow: '/',
      // The chart-kit workbench. Also marked noindex on the page itself; this
      // saves a crawl of the heaviest route on the site to reach that tag.
      disallow: `${absoluteUrl('/kitchen-sink/')}`.replace(/^https?:\/\/[^/]+/, ''),
    },
    sitemap: absoluteUrl('/sitemap.xml'),
  };
}
