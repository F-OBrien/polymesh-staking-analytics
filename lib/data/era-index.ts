import type { EraIndexFile } from '@/lib/schemas/data';

/**
 * Era ↔ date ↔ block, over the chain's whole life. Chunks carry `eraStart` only
 * for the eras they hold, which is enough for a chart axis; this covers the
 * rest, including everything a years-long reward history falls in.
 *
 * Do not replace any of this with arithmetic. An era is nominally 24 hours and
 * very nearly is, which makes the shortcut tempting, but `firstStart + era ×
 * 86400` drifts about four hours across the chain's life and lands in the wrong
 * day at the far end. Every function here is a lookup — a binary search over a
 * contiguous columnar array, so nothing has to be indexed on load.
 */

export interface EraIndex {
  readonly firstEra: number;
  readonly lastEra: number;
  /** Unix seconds at which `firstEra` began. */
  readonly firstStart: number;
  /** Unix seconds at which `lastEra` began. */
  readonly lastStart: number;

  /** Unix seconds the era began, or null if it is outside the index. */
  startOf(era: number): number | null;
  /** Block the era's transition was recorded in, or null. */
  blockOf(era: number): number | null;
  /** The era in progress at a moment, or null if outside the covered range. */
  eraAt(unixSeconds: number): number | null;
  /** The era in progress at a block, or null if outside the covered range. */
  eraAtBlock(block: number): number | null;
}

/**
 * Largest index whose value is <= `target`, or -1. The "<=" matters: an event
 * anywhere inside era N must resolve to N, not to the nearer boundary.
 */
function floorIndex(values: readonly number[], target: number): number {
  let low = 0;
  let high = values.length - 1;
  let result = -1;

  while (low <= high) {
    const mid = (low + high) >> 1;
    if ((values[mid] ?? 0) <= target) {
      result = mid;
      low = mid + 1;
    } else {
      high = mid - 1;
    }
  }

  return result;
}

export function createEraIndex(file: EraIndexFile): EraIndex {
  const { firstEra, block, start } = file;
  const count = start.length;
  const lastEra = firstEra + count - 1;

  const at = (era: number, column: readonly number[]): number | null => {
    const i = era - firstEra;
    return i >= 0 && i < count ? (column[i] ?? null) : null;
  };

  return {
    firstEra,
    lastEra,
    firstStart: start[0] ?? 0,
    lastStart: start.at(-1) ?? 0,

    startOf: (era) => at(era, start),
    blockOf: (era) => at(era, block),

    eraAt(unixSeconds) {
      const i = floorIndex(start, unixSeconds);
      return i < 0 ? null : firstEra + i;
    },

    eraAtBlock(blockNumber) {
      const i = floorIndex(block, blockNumber);
      return i < 0 ? null : firstEra + i;
    },
  };
}

/**
 * The era a reward was *earned in*, from the moment it was paid — a different
 * question from `eraAt`. A `Rewarded` event fires when the payout is made, and
 * Polymesh pays automatically as soon as the era it pays for ends (measured:
 * within a couple of minutes of the boundary, in 2021 and today alike), so the
 * era whose work earned it is the one before the event landed in.
 *
 * That is the module's one inference, and it rests on `validators::payouts()`
 * being automatic. On a chain where payouts are claimed manually a reward could
 * land arbitrarily late and this would be wrong.
 *
 * Null rather than a guess outside the index — a blank cell in a CSV filed for
 * reporting is honest, an invented era is not.
 */
export function earnedEraForReward(index: EraIndex, block: number): number | null {
  // Keyed on block, not timestamp: the block is the chain's own exact ordinal,
  // where the indexer's datetime is a string of inconsistent width.
  const paidIn = index.eraAtBlock(block);
  if (paidIn == null) return null;
  const earned = paidIn - 1;
  return earned >= index.firstEra ? earned : null;
}
