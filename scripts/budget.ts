/**
 * Per-route JavaScript budget check: reads the exported HTML and gzips every
 * script it references, measuring what a browser actually fetches for a cold
 * visit. Deliberately different from what `next build` prints, which reports
 * chunks uncompressed and grouped by entry — so a shared chunk can drag a
 * charting library onto a page that never draws one and the summary looks fine.
 *
 * Usage: `npm run build && npm run budget`. Exits non-zero on a breach, so CI
 * can gate on it.
 */
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';
import { stripBasePath } from '../config/site';
import { gzipSync } from 'node:zlib';

const OUT_DIR = 'out';

/** §11 of the design doc. Gzipped, because that is what crosses the wire. */
const BUDGET_BYTES = 200 * 1024;

/**
 * Routes the budget does not apply to, with the reason. Keep this short and
 * justified: an exemption is a promise that the route is not on a user's path,
 * not a way to make a red number go away. Currently empty.
 */
const EXEMPT: Record<string, string> = {};

/** Turbopack emits the same page under several paths; collapse them to one. */
const canonicalise = (route: string): string =>
  route.replace(/\/operators\/[^/]+\/$/, '/operators/[address]/');

async function* htmlFiles(dir: string): AsyncGenerator<string> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) yield* htmlFiles(path);
    else if (entry.name.endsWith('.html')) yield path;
  }
}

/**
 * Every script URL a *modern* browser actually downloads for this document —
 * both `<script src>` tags and the bare strings in the Turbopack bootstrap
 * array, which are fetched just as eagerly.
 *
 * `nomodule` scripts are excluded, which is why this is more than one regex:
 * Next emits a ~39 KB gzip core-js polyfill bundle that every browser this site
 * targets skips entirely, and counting it inflates every route alike. Excluded
 * by URL rather than by tag, since the same file also appears in the preload
 * links and the bootstrap array.
 */
function scriptRefs(html: string): Set<string> {
  const refs = new Set<string>();
  const legacy = new Set<string>();

  for (const tag of html.matchAll(/<script\b[^>]*>/gi)) {
    const src = /src="(\/[^"]*?\.js)"/.exec(tag[0])?.[1];
    if (src == null) continue;
    // React renders the attribute as `noModule`; HTML attribute names are
    // case-insensitive, so match either.
    if (/\bnomodule\b/i.test(tag[0])) legacy.add(src);
    else refs.add(src);
  }

  for (const match of html.matchAll(/(?:src|href)="(\/[^"]*?\.js)"/g)) refs.add(match[1]!);
  for (const match of html.matchAll(/"(\/_next\/static\/[^"]*?\.js)"/g)) refs.add(match[1]!);

  for (const src of legacy) refs.delete(src);
  return refs;
}

async function main(): Promise<void> {
  const gzipCache = new Map<string, number>();

  const gzipSize = async (path: string): Promise<number> => {
    const cached = gzipCache.get(path);
    if (cached != null) return cached;
    const size = gzipSync(await readFile(path), { level: 9 }).length;
    gzipCache.set(path, size);
    return size;
  };

  const seen = new Set<string>();
  const routes: { route: string; bytes: number; files: number; unresolved: number }[] = [];

  for await (const file of htmlFiles(OUT_DIR)) {
    const route = canonicalise(
      `/${relative(OUT_DIR, file).split(sep).join('/')}`
        .replace(/index\.html$/, '')
        .replace(/\.html$/, '/'),
    );
    // One representative per canonical route: the hundred operator pages share
    // a bundle, so measuring all of them says nothing extra.
    if (seen.has(route)) continue;
    seen.add(route);

    const html = await readFile(file, 'utf8');
    let bytes = 0;
    let unresolved = 0;
    const refs = scriptRefs(html);

    for (const ref of refs) {
      // Strip the basePath: refs are absolute URLs, `out/` is its root. Read
      // from config rather than duplicated — a stale second copy resolves
      // every script to nothing and reports the route at 0 KB.
      const path = join(OUT_DIR, stripBasePath(ref));
      try {
        await stat(path);
        bytes += await gzipSize(path);
      } catch {
        unresolved += 1;
      }
    }

    routes.push({ route, bytes, files: refs.size, unresolved });
  }

  routes.sort((a, b) => b.bytes - a.bytes);

  const kb = (bytes: number) => `${(bytes / 1024).toFixed(1).padStart(7)} KB`;
  const breaches: typeof routes = [];

  console.log(`Per-route JS, gzipped. Budget ${(BUDGET_BYTES / 1024).toFixed(0)} KB.\n`);

  for (const entry of routes) {
    const exemption = EXEMPT[entry.route];
    const over = entry.bytes > BUDGET_BYTES;
    if (over && !exemption) breaches.push(entry);

    const marker = exemption ? 'skip' : over ? 'OVER' : ' ok ';
    const note = exemption
      ? `  — exempt: ${exemption}`
      : over
        ? `  (+${((entry.bytes - BUDGET_BYTES) / 1024).toFixed(1)} KB)`
        : '';
    const warn = entry.unresolved > 0 ? `  [${entry.unresolved} refs unresolved]` : '';
    console.log(
      `${marker}  ${kb(entry.bytes)}  ${String(entry.files).padStart(2)} files  ${entry.route}${note}${warn}`,
    );
  }

  // The floor every route pays: framework, app shell, query client, router.
  // Printed because a rise here moves every number at once, which is otherwise
  // easy to misread as one page having grown.
  const floor = routes.at(-1);
  if (floor) console.log(`\nShared floor: ${kb(floor.bytes).trim()} (${floor.route})`);

  if (breaches.length > 0) {
    console.error(`\n${breaches.length} route(s) over budget.`);
    process.exitCode = 1;
  }
}

await main();
