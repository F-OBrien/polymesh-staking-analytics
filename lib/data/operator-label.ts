import { truncateAddress } from '@/lib/format';
import type { OperatorRegistry } from '@/lib/schemas/data';

/**
 * Display labels for operators, disambiguated by address only where needed.
 * Several nodes commonly run under one identity and share its registry name, so
 * a legend would otherwise read "DigiClear" three times — and §8.1 rule 5
 * forbids leaning on colour to tell series apart.
 *
 * The disambiguator is the address, which actually identifies a node and cannot
 * drift. Do not number them instead ("DigiClear 2"): nothing on chain carries
 * such a number, and any derived from a sort of the identity's addresses
 * renumbers silently whenever a stash is added.
 *
 *     Assetera                       — the only node under that name
 *     DigiClear (2HW34b…sNz3Dz)      — one of three
 *
 * Ambiguity is judged against the whole registry rather than what is on screen,
 * so a label does not change as a filter or selection changes.
 */
export type OperatorLabeller = (address: string) => string;

export function buildLabeller(registry: OperatorRegistry | undefined): OperatorLabeller {
  if (!registry) return (address) => truncateAddress(address);

  const counts = new Map<string, number>();
  for (const record of Object.values(registry)) {
    counts.set(record.name, (counts.get(record.name) ?? 0) + 1);
  }

  return (address) => {
    const record = registry[address];
    if (!record) return truncateAddress(address);
    return (counts.get(record.name) ?? 0) > 1
      ? `${record.name} (${truncateAddress(address)})`
      : record.name;
  };
}
