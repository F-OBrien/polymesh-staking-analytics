'use client';

import type { OperatorStatus } from '@/lib/schemas/data';

/**
 * Which operators a field chart draws.
 *
 * The four statuses are the same four, in the same order, as the directory
 * table's control — a reader who has filtered the table to "active" and then
 * scrolls to a chart of every operator that ever ran is entitled to think one
 * of the two is broken.
 *
 * **Pinned is a fifth view, not an exemption.** Pinned operators were briefly
 * shown under every status on the reasoning that a ★ should not be silently
 * undone. That was wrong in a way worth recording: a filter that quietly keeps
 * things back is no longer a filter, and "Active" showing an operator that
 * stopped running six months ago makes the reader distrust the whole control
 * rather than notice the exception. The selection deserves its own view
 * instead, so "show me only my picks" is something a reader asks for and gets
 * exactly.
 *
 * Chart-side this is a *display* filter and nothing more. The summary behind
 * these charts is always computed over the whole field, so the baseline, the
 * margin of error and the spread do not move when the selection changes;
 * hiding a bar must not silently redefine what the rest are measured against.
 */

export type StatusFilter = OperatorStatus | 'all' | 'pinned';

/** The minimum an item needs for `filterOperators` to place it. */
export interface StatusFilterable {
  id: string;
  status: OperatorStatus;
}

/**
 * Applies the filter, strictly.
 *
 * `pinned` falls back to the whole field when nothing is pinned, rather than
 * returning an empty chart: the option is only offered when a selection exists,
 * but a reader can unpin their last operator while it is selected, and a
 * control that strands the view in a permanent blank is worse than one that
 * quietly widens.
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
   * How many of those are pinned.
   *
   * Called out separately because it is the one case where hiding is
   * surprising: the reader chose those operators, and without this the bar they
   * pinned simply is not there.
   */
  hiddenPinned?: number;
  /** Offers the "Pinned only" view. Omitted when nothing is pinned. */
  showPinnedOption?: boolean;
  /**
   * What the selection is called here, lower case.
   *
   * "Pinned" is the right word on the directory, where a ★ is something the
   * reader did. On the staking page the same set is the address's *nominations*
   * — the reader did not choose them in this UI, the chain already holds them —
   * and calling those "pinned" asks them to translate.
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
