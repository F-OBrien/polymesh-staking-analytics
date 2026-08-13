import type { Metadata } from 'next';
import { Suspense } from 'react';
import { EntryCards } from '@/components/entry-cards';
import { NetworkAnalytics } from '@/components/network-analytics';
import { Skeleton } from '@/components/states';

export const metadata: Metadata = {
  description:
    'Live staking metrics for Polymesh: returns, inflation, stake, participation, decentralisation and operator performance.',
};

/**
 * Home, which *is* the network view.
 *
 * These were two pages and they said the same things. Home carried six tiles —
 * return, staked, staking ratio, inflation, operator count, era countdown — and
 * `/network` opened with the same figures in its Chain status and Rewards
 * sections, then went on to the charts behind them. A visitor read the numbers,
 * clicked Network, and read them again.
 *
 * Worse, the two copies had drifted. Home's staking-ratio tile had been
 * corrected to describe the *inflation cap* — the fixed 140,000,000 POLYX
 * yearly reward, which binds at about 50% staked — while `/network` still
 * described the reward curve's 70% "ideal", a Substrate concept that this chain
 * never reaches. Both were deployed. Merging leaves one copy, and it is the
 * correct one.
 *
 * What is kept from the old home page is the part `/network` had no equivalent
 * of: a sentence saying what the site is, and three cards saying where to go.
 */
export default function HomePage() {
  return (
    <main id="main">
      <section className="max-w-[60ch]">
        <h1 className="text-3xl leading-9 font-semibold tracking-tight">
          Polymesh staking, in the open
        </h1>
        <p className="mt-3" style={{ color: 'var(--text-secondary)' }}>
          Operator performance, network returns, and your own position — measured from public chain
          data, with every formula written down. The <a href="./about/">methodology</a> sets out
          each one.
        </p>
      </section>

      <EntryCards />

      {/* The era range lives in the URL, so this subtree reads useSearchParams
          and must sit behind a Suspense boundary for static export. The
          fallback reserves roughly the height of the first screen of content,
          so the page does not jump when it resolves. */}
      <Suspense fallback={<Skeleton height={520} label="Loading network analytics" />}>
        <NetworkAnalytics />
      </Suspense>
    </main>
  );
}
