/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed storage, as in compat.ts */

import type { ApiLike } from './compat';

/**
 * Where a nominator's stake actually went, for a given era. "Bonded" is a
 * number the user chose; assigned is what the election did with it, and they
 * differ in three ways:
 *
 *  1. The election picks a subset of your targets. Phragmén optimises the
 *     network's stake distribution, not yours, so nominating eight operators
 *     commonly means backing one.
 *  2. A new nomination does not take effect until the next election.
 *  3. Rewards for era N are paid during era N+1, so the exposure that earned
 *     today's payout is the previous era's — which is why both are read here.
 *     "Why did I earn nothing?" is usually the previous era's allocation.
 */

export interface TargetAllocation {
  /** The operator. */
  address: string;
  /** This stash's stake backing that operator this era, in base units. */
  value: bigint;
  /** Exposure page it landed on, or null when not backing this operator. */
  page: number | null;
  /** Whether the operator was in the active set at all this era. */
  elected: boolean;
  /**
   * Whether the stash currently nominates this operator. False means it is
   * exposed to an operator it has since dropped — not an error, and not stale
   * data. See `readEraAllocation`.
   */
  nominated: boolean;
}

export interface EraAllocation {
  era: number;
  /** Sum of `targets[].value` — what the election actually put to work. */
  assigned: bigint;
  /** Stake sitting with operators the stash no longer nominates. */
  unnominated: bigint;
  /**
   * This stash's own validator self-stake, when the stash is itself an elected
   * operator. Zero for a plain nominator. Included in `assigned`.
   */
  own: bigint;
  targets: TargetAllocation[];
}

const toBigInt = (value: unknown): bigint => {
  try {
    return BigInt(value?.toString() ?? '0');
  } catch {
    return 0n;
  }
};

interface Backing {
  operator: string;
  value: bigint;
  page: number;
}

/**
 * Every operator this stash is exposed to in an era, found by searching the
 * era's whole exposure rather than the nomination list — the correctness point
 * of the module.
 *
 * Nominations change at any moment; exposure is fixed at the election. Re-
 * nominate mid-era and your stake stays with the operator you just dropped, who
 * is no longer in `staking.nominators(stash).targets` — so iterating that list
 * reports a normally-earning position as "nothing assigned".
 *
 * `erasStakersPaged.entries(era)` is a single prefix read over every operator
 * and page (~425ms, 74 KB on mainnet), so it cannot miss anything. §2.1 calls
 * this the heaviest query available; that is about issuing it per operator on
 * every page load, not twice on demand for one address.
 */
async function readEraBacking(api: ApiLike, stash: string, era: number): Promise<Backing[]> {
  const backing: Backing[] = [];

  if ('erasStakersPaged' in api.query.staking) {
    const pages: any[] = await api.query.staking.erasStakersPaged.entries(era);

    for (const [key, page] of pages) {
      if (page.isNone) continue;
      for (const other of page.unwrap().others) {
        if (String(other.who) !== stash) continue;
        backing.push({
          operator: String(key.args[1]),
          value: toBigInt(other.value),
          page: Number(key.args[2]?.toString() ?? '0'),
        });
      }
    }
    return backing;
  }

  // Pre-v8 shape. Only reached against an old runtime; mainnet is paged.
  const entries: any[] = await api.query.staking.erasStakersClipped.entries(era);
  for (const [key, exposure] of entries) {
    for (const other of exposure?.others ?? []) {
      if (String(other.who) !== stash) continue;
      backing.push({ operator: String(key.args[1]), value: toBigInt(other.value), page: 0 });
    }
  }
  return backing;
}

/**
 * Each elected operator's exposure overview for an era, keyed by address. Gives
 * which operators were elected — so a nomination reads "not elected" rather
 * than "not backing you" — and an operator's own self-stake, which lives in
 * `own` rather than the `others` list a nominator appears in.
 */
async function readOverviews(api: ApiLike, era: number): Promise<Map<string, { own: bigint }>> {
  try {
    const overviews: any[] = await api.query.staking.erasStakersOverview.entries(era);
    const byAddress = new Map<string, { own: bigint }>();
    for (const [key, overview] of overviews) {
      const address = String(key.args[1]);
      const value = overview?.isSome === true ? overview.unwrap() : overview;
      byAddress.set(address, { own: toBigInt(value?.own) });
    }
    return byAddress;
  } catch {
    return new Map();
  }
}

/**
 * How this stash's stake was allocated for one era. The list is the union of
 * what the stash nominates and what it is exposed to, which differ both ways:
 * nominated but not backed (the election chose others, or the nomination
 * post-dates it), and backed but not nominated (changed after the election, so
 * the stake stays put until the next one).
 */
export async function readEraAllocation(
  api: ApiLike,
  stash: string,
  era: number,
  targets: readonly string[],
): Promise<EraAllocation> {
  const [backing, overviews] = await Promise.all([
    readEraBacking(api, stash, era),
    readOverviews(api, era),
  ]);

  const byOperator = new Map<string, { value: bigint; page: number }>();
  for (const entry of backing) {
    const existing = byOperator.get(entry.operator);
    // A stash appears on one page per operator; summing rather than assigning
    // stays correct if that ever changes.
    byOperator.set(entry.operator, {
      value: (existing?.value ?? 0n) + entry.value,
      page: entry.page,
    });
  }

  const nominatedSet = new Set(targets);
  // Nominations first and in their own order, then anything else holding stake.
  const addresses = [...targets, ...[...byOperator.keys()].filter((a) => !nominatedSet.has(a))];

  const allocations: TargetAllocation[] = addresses.map((address) => {
    const held = byOperator.get(address);
    return {
      address,
      value: held?.value ?? 0n,
      page: held?.page ?? null,
      elected: overviews.has(address),
      nominated: nominatedSet.has(address),
    };
  });

  // The stash's own validator stake, if it is itself an elected operator.
  const own = overviews.get(stash)?.own ?? 0n;

  return {
    era,
    // Own stake counts as assigned — it is exposed and earning, and excluding
    // it would tell an operator their bond was idle.
    assigned: allocations.reduce((sum, a) => sum + a.value, own),
    unnominated: allocations.reduce((sum, a) => (a.nominated ? sum : sum + a.value), 0n),
    own,
    targets: allocations,
  };
}

export interface StakeAllocation {
  /** The era now running — what the stake is doing right now. */
  current: EraAllocation;
  /**
   * The era before it — the one whose rewards are being paid out now. Kept
   * separate because "what am I earning on today" and "what is today's payout
   * for" are different questions. Null when there is no previous era.
   */
  previous: EraAllocation | null;
}

/**
 * Reads the active era from the chain, not from the snapshot. `latest.json` is
 * regenerated every fifteen minutes, so its `activeEra` lags across an era
 * boundary — and exposure is keyed by era, so the snapshot's number reads the
 * previous era's exposure and reports a funded stash as having nothing.
 *
 * Anything read over the socket should ask the socket what era it is.
 */
async function readActiveEra(api: ApiLike): Promise<number | null> {
  try {
    const active: any = await api.query.staking.activeEra();
    if (active?.isSome !== true) return null;
    return Number(active.unwrap().index.toString());
  } catch {
    return null;
  }
}

export async function readStakeAllocation(
  api: ApiLike,
  stash: string,
  /** Fallback only, for when the chain will not say. */
  snapshotEra: number,
  targets: readonly string[],
): Promise<StakeAllocation> {
  const era = (await readActiveEra(api)) ?? snapshotEra;

  // No `targets.length === 0` shortcut: a chilled stash still has exposure for
  // the current era and is still earning from it.
  const [current, previous] = await Promise.all([
    readEraAllocation(api, stash, era, targets),
    era > 0 ? readEraAllocation(api, stash, era - 1, targets) : Promise.resolve(null),
  ]);

  return { current, previous };
}

/**
 * The part of an active bond the election did not put to work. Clamped at zero:
 * an unbond since the election lowers `active` without changing this era's
 * exposure, so assigned can transiently exceed it.
 */
export function idleStake(active: bigint, assigned: bigint): bigint {
  const idle = active - assigned;
  return idle > 0n ? idle : 0n;
}
