import type { Metadata } from 'next';
import { Suspense } from 'react';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { OperatorDetail } from '@/components/operator-detail';
import { Skeleton } from '@/components/states';

/**
 * One page per operator, prerendered at build time. Static export has no server
 * and no rewrites, so every route must exist as a file; the addresses come from
 * the generated `public/data/operators.json`. An address absent from it 404s,
 * which is the honest outcome — there is nowhere to resolve it.
 *
 * A missing dataset fails the build deliberately, with an actionable message.
 * Returning an empty list instead is rejected by `output: export` anyway, and
 * would only deploy a site with every operator page missing.
 */

const REGISTRY_PATH = join(process.cwd(), 'public', 'data', 'operators.json');

const MISSING_DATA = `
public/data/operators.json is missing or empty, so there are no operator pages to build.

  Local development:  npm run fixtures
  CI:                 the workflow generates fixtures before building
  Deploy:             the "data" branch is checked out into public/data

That directory is gitignored — generated data never lives on a source branch.
`.trim();

interface OperatorRecordShape {
  name?: string;
}

async function readRegistry(): Promise<Record<string, OperatorRecordShape>> {
  try {
    const raw = await readFile(REGISTRY_PATH, 'utf8');
    return JSON.parse(raw) as Record<string, OperatorRecordShape>;
  } catch {
    return {};
  }
}

export async function generateStaticParams(): Promise<{ address: string }[]> {
  const registry = await readRegistry();
  const addresses = Object.keys(registry);

  if (addresses.length === 0) throw new Error(MISSING_DATA);

  return addresses.map((address) => ({ address }));
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ address: string }>;
}): Promise<Metadata> {
  const { address } = await params;
  const registry = await readRegistry();
  const name = registry[address]?.name;

  return {
    title: name ?? 'Operator',
    description: name
      ? `Staking performance for ${name} on Polymesh: return after commission, reliability, stake and commission history.`
      : 'Staking performance for a Polymesh operator.',
  };
}

export default async function OperatorPage({ params }: { params: Promise<{ address: string }> }) {
  const { address } = await params;

  return (
    <main id="main">
      <Suspense fallback={<Skeleton height={560} label="Loading operator" />}>
        <OperatorDetail address={address} />
      </Suspense>
    </main>
  );
}
