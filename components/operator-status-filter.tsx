'use client';

import type { OperatorStatus } from '@/lib/schemas/data';

/**
 * Which operators a field chart draws. The four statuses match the directory
 * table's control exactly, in the same order — a reader who filtered the table
 * to "active" and then meets a chart of everyone who ever ran will assume one
 * of the two is broken.
 *
 * Pinned is a fifth view, not an exemption: a filter that quietly keeps things
 * back is not a filter, and "Active" showing an operator that stopped six
 * months ago makes the whole control untrustworthy.
 *
 * This is a *display* filter only. The summary behind these charts is always
 * computed over the whole field, so hiding a bar never redefines the baseline,
 * margin of error or spread the rest are measured against.
 */

export type StatusFilter = OperatorStatus | 'all' | 'pinned';

/** The minimum an item needs for `filterOperators` to place it. */
export interface StatusFilterable {
  id: string;
  status: OperatorStatus;
}

/**
 * Applies the filter, strictly. `pinned` falls back to the whole field when
 * nothing is pinned rather than emptying the chart — a reader can unpin their
 * last operator while that view is selected, and a permanent blank is worse
 * than a view that quietly widens.
 */
export function filterOperators<T extends StatusFilterable>(
  items: readonly T[],
  filter: StatusFilter,
  pinned: ReadonlySet<string>,
): T[] {
  if (filter === 'pinned') {
    return pinned.size === 0 ? [...items] : items.filter((item) => pinned.has(item.id));
  }
  if (filter === 'all') return [...items];
  return items.filter((item) => item.status === filter);
}

export interface OperatorStatusFilterProps {
  id: string;
  value: StatusFilter;
  onChange: (value: StatusFilter) => void;
  /** How many operators the current selection is hiding. */
  hidden?: number;
  /**
   * How many of those are pinned — called out separately because it is the one
   * case where hiding is surprising: the reader chose those operators.
   */
  hiddenPinned?: number;
  /** Offers the "Pinned only" view. Omitted when nothing is pinned. */
  showPinnedOption?: boolean;
  /**
   * What the selection is called here, lower case. "Pinned" fits the directory,
   * where a ★ is something the reader did; on the staking page the same set is
   * the address's nominations, which the chain already holds.
   */
  selectionNoun?: string;
}

export function OperatorStatusFilter({
  id,
  value,
  onChange,
  hidden = 0,
  hiddenPinned = 0,
  showPinnedOption = false,
  selectionNoun = 'pinned',
}: OperatorStatusFilterProps) {
  const selectionTitle = selectionNoun.charAt(0).toUpperCase() + selectionNoun.slice(1);
  return (
    <div className="flex items-center gap-2">
      {hidden > 0 ? (
        <span className="text-xs" style={{ color: 'var(--text-muted)' }}>
          {hidden} hidden
          {hiddenPinned > 0 ? `, ${hiddenPinned} ${selectionNoun}` : ''}
        </span>
      ) : null}
      <label className="sr-only" htmlFor={id}>
        Operator status
      </label>
      <select
        id={id}
        className="rounded-md border px-2 py-1 text-sm"
        style={{
          borderColor: 'var(--border)',
          background: 'var(--surface)',
          color: 'var(--text-primary)',
        }}
        value={value}
        onChange={(event) => onChange(event.target.value as StatusFilter)}
      >
        <option value="active">Active</option>
        <option value="waiting">Waiting</option>
        <option value="inactive">Inactive</option>
        <option value="all">All statuses</option>
        {showPinnedOption ? <option value="pinned">{selectionTitle} only</option> : null}
      </select>
    </div>
  );
}
