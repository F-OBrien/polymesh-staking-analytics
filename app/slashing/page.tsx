import type { Metadata } from 'next';
import { Suspense } from 'react';
import { SlashingView } from '@/components/slashing-view';
import { HeadingWithTip } from '@/components/info-tip';
import { Skeleton } from '@/components/states';

export const metadata: Metadata = {
  title: 'Slashing',
  description:
    'Offences recorded on Polymesh, what each cost, and how the two slashing penalties scale with the number of operators failing at once.',
};

export default function SlashingPage() {
  return (
    <main id="main">
      <HeadingWithTip
        as="h1"
        title="Slashing"
        lead="The one way staking can lose money rather than merely fail to earn it."
      >
        On Polymesh, slashing applies to an operator&rsquo;s own stake and not to nominated tokens.
        That is a governance setting rather than a fixed rule of the protocol, so it could change.
        This page shows what has actually happened, who a penalty would fall on, and what it would
        cost.
      </HeadingWithTip>

      <Suspense fallback={<Skeleton height={520} label="Loading slashing record" />}>
        <SlashingView />
      </Suspense>
    </main>
  );
}
