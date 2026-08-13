/* eslint-disable @typescript-eslint/no-explicit-any -- loosely-typed storage, as in compat.ts */

import type { ApiLike } from './compat';

/**
 * A stash's current staking position, from chain state rather than the indexer
 * — "how much is bonded right now" is a state question, and the indexer knows
 * only events.
 *
 * Balances stay `bigint` in base units throughout: a user reconciling against
 * their wallet notices a rounding difference immediately.
 */

export interface UnbondingChunk {
  /** Era at which this becomes withdrawable. */
  era: number;
  value: bigint;
}

export interface StashPosition {
  stash: string;
  /** Total bonded, including anything currently unbonding. */
  total: bigint;
  /** Bonded and backing nominations — `total` less the unbonding chunks. */
  active: bigint;
  unbonding: UnbondingChunk[];
  /** Sum of chunks that have already matured and can be withdrawn now. */
  redeemable: bigint;
  /** Where rewards are paid. Null when the chain reports nothing usable. */
  rewardDestination: string | null;
  /** Operators this stash currently nominates. Empty when not nominating. */
  nominations: string[];
  /** Era the nominations were submitted in, if the chain reports it. */
  nominatedAtEra: number | null;
  /** True when the stash has no ledger at all — it has never bonded. */
  isBonded: boolean;
}

const toBigInt = (value: unknown): bigint => {
  try {
    return BigInt(value?.toString() ?? '0');
  } catch {
    return 0n;
  }
};

/**
 * Reads everything `/my-staking` needs about one stash.
 *
 * Note the controller indirection: `staking.ledger` is keyed by controller, not
 * stash, so reading it with a stash address returns nothing for most accounts
 * and shows a bonded account as unbonded. `staking.bonded(stash)` gives the
 * controller first.
 */
export async function readStashPosition(
  api: ApiLike,
  stash: string,
  activeEra: number,
): Promise<StashPosition> {
  const controllerOption = await api.query.staking.bonded(stash);
  const controller = controllerOption?.isSome ? String(controllerOption.unwrap()) : null;

  const [ledgerOption, payeeRaw, nominatorsOption] = await Promise.all([
    controller ? api.query.staking.ledger(controller) : Promise.resolve(null),
    api.query.staking.payee(stash).catch(() => null),
    api.query.staking.nominators(stash).catch(() => null),
  ]);

  const ledger = ledgerOption?.isSome ? ledgerOption.unwrap() : null;

  const unbonding: UnbondingChunk[] = [];
  let unbondingTotal = 0n;
  let redeemable = 0n;

  for (const chunk of ledger?.unlocking ?? []) {
    const era = Number(chunk.era?.toString() ?? '0');
    const value = toBigInt(chunk.value);
    unbonding.push({ era, value });
    unbondingTotal += value;
    // A chunk unlocks *at* its era, so one whose era has arrived is already
    // withdrawable. Off by one here understates what can be taken out today.
    if (era <= activeEra) redeemable += value;
  }

  const total = toBigInt(ledger?.total);

  return {
    stash,
    total,
    // From the ledger's own `active` where present rather than by subtraction,
    // since the two can differ transiently around a slash.
    active: ledger?.active != null ? toBigInt(ledger.active) : total - unbondingTotal,
    unbonding: unbonding.sort((a, b) => a.era - b.era),
    redeemable,
    rewardDestination: readPayee(payeeRaw),
    nominations: readNominations(nominatorsOption),
    nominatedAtEra: readSubmittedEra(nominatorsOption),
    isBonded: ledger != null,
  };
}

/**
 * The reward destination: the variant name, or the address for `Account`. Only
 * `Staked` compounds, so this has to be right rather than merely present.
 *
 * Note `staking.payee` is an `Option<RewardDestination>`, not a bare enum —
 * accessors like `isAccount` live on the inner enum and are `undefined` on the
 * wrapper, which silently renders a destination as raw JSON. `toJSON()` remains
 * the fallback since it unwraps an `Option` transparently.
 */
function readPayee(payee: any): string | null {
  if (payee == null) return null;
  try {
    // Unwrap the Option first. `isSome === undefined` means this runtime hands
    // back a bare enum instead, which older Substrate versions do.
    const destination =
      payee.isSome === true ? payee.unwrap() : payee.isNone === true ? null : payee;
    if (destination == null) return null;

    if (destination.isAccount === true) return String(destination.asAccount);
    if (typeof destination.type === 'string' && destination.type.length > 0) {
      return destination.type;
    }

    const json: unknown = destination.toJSON?.() ?? destination.toString?.();
    if (typeof json === 'string') return json.length > 0 ? json : null;

    if (json != null && typeof json === 'object') {
      const [variant, value] = Object.entries(json)[0] ?? [];
      if (variant == null) return null;
      // `{ account: "2GD3…" }` — show the address, which is the useful part.
      if (typeof value === 'string' && value.length > 0) return value;
      // Any other single-key variant: its name, capitalised to match the unit
      // variants ("staked" -> "Staked").
      return variant.charAt(0).toUpperCase() + variant.slice(1);
    }
    return null;
  } catch {
    return null;
  }
}

function readNominations(nominators: any): string[] {
  if (nominators == null || !nominators.isSome) return [];
  try {
    return [...nominators.unwrap().targets].map((target: unknown) => String(target));
  } catch {
    return [];
  }
}

function readSubmittedEra(nominators: any): number | null {
  if (nominators == null || !nominators.isSome) return null;
  try {
    const era = nominators.unwrap().submittedIn;
    return era == null ? null : Number(era.toString());
  } catch {
    return null;
  }
}

/**
 * There is deliberately no `readUnclaimedEras`, though §9.6 allows for one "if
 * determinable". It is not, at acceptable cost: the obvious implementation
 * (diffing the ledger's `claimedRewards`) tracks which pages a *validator*
 * claimed, whereas a nominator earns only where a backed operator was elected
 * and they landed inside its exposure page — establishing which is on the order
 * of a thousand storage reads from the browser.
 *
 * Revisit when signing lands, and source it from the indexer's `Rewarded`
 * events rather than a storage sweep.
 */
