import Link from 'next/link';

/**
 * Wayfinding from the landing page.
 *
 * The nav names the same four destinations, and this is not redundant with it:
 * a nav item is a word, and someone arriving without knowing what the site does
 * needs the sentence. Kept to three — the tasks a visitor actually arrives with
 * — rather than one card per route.
 */

const ENTRIES = [
  {
    href: '/operators',
    title: 'Find an operator',
    body: 'Compare every operator on return, commission, reliability and stake.',
  },
  {
    href: '/my-staking',
    title: 'Check your staking',
    body: 'See what you have staked, what it has earned, and whether your picks are performing.',
  },
  {
    href: '/calculator',
    title: 'Estimate returns',
    body: 'Project rewards for an amount and an operator, based on their actual history.',
  },
] as const;

export function EntryCards() {
  return (
    <section className="mt-8 grid gap-3 sm:grid-cols-3" aria-label="Where to next">
      {ENTRIES.map(({ href, title, body }) => (
        <Link
          key={href}
          href={href}
          className="group flex flex-col gap-1 rounded-[var(--radius-md)] border p-4 no-underline transition-colors"
          style={{ borderColor: 'var(--border)', background: 'var(--surface-1)' }}
        >
          <span className="font-semibold">
            {title}
            <span
              aria-hidden="true"
              className="ms-1 inline-block transition-transform group-hover:translate-x-0.5"
            >
              →
            </span>
          </span>
          <span className="text-sm" style={{ color: 'var(--text-secondary)' }}>
            {body}
          </span>
        </Link>
      ))}
    </section>
  );
}
