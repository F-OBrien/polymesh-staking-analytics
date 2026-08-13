import type { Metadata } from 'next';
import { Suspense } from 'react';
import { OperatorsView } from '@/components/operators-view';
import { HeadingWithTip } from '@/components/info-tip';
import { Skeleton } from '@/components/states';

export const metadata: Metadata = {
  title: 'Operators',
  description:
    'Every Polymesh operator ranked by return, commission, stake and reliability. Pin operators to compare them.',
};

export default function OperatorsPage() {
  return (
    <main id="main">
      <HeadingWithTip as="h1" title="Operators" lead="Every operator, ranked and filterable.">
        Every return column says which period it covers and whether commission has been taken off —
        those two things change the number more than the choice of operator does. Hover the ⓘ on any
        column heading for what it measures.
      </HeadingWithTip>

      {/* Both the era range and the pinned selection live in the URL, so this
          subtree reads useSearchParams and needs a boundary under static
          export. */}
      <Suspense fallback={<Skeleton height={560} label="Loading operators" />}>
        <OperatorsView />
      </Suspense>
    </main>
  );
}
