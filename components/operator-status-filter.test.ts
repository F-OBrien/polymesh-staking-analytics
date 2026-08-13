import { describe, expect, it } from 'vitest';
import { filterOperators, type StatusFilter } from './operator-status-filter';

const field = [
  { id: 'a', status: 'active' as const },
  { id: 'b', status: 'active' as const },
  { id: 'w', status: 'waiting' as const },
  { id: 'x', status: 'inactive' as const },
];

const ids = (filter: StatusFilter, pinned: string[] = []) =>
  filterOperators(field, filter, new Set(pinned)).map((item) => item.id);

describe('filterOperators', () => {
  it('keeps only the selected status', () => {
    expect(ids('active')).toEqual(['a', 'b']);
    expect(ids('waiting')).toEqual(['w']);
    expect(ids('inactive')).toEqual(['x']);
    expect(ids('all')).toEqual(['a', 'b', 'w', 'x']);
  });

  it('hides a pinned operator that does not match the status', () => {
    // The exemption this replaced showed `x` under "Active", which made the
    // control look broken rather than looking like an exception.
    expect(ids('active', ['x'])).toEqual(['a', 'b']);
    expect(ids('inactive', ['a'])).toEqual(['x']);
  });

  it('shows only the pinned operators in the pinned view', () => {
    expect(ids('pinned', ['a', 'x'])).toEqual(['a', 'x']);
  });

  it('widens rather than blanking when the last pin is removed', () => {
    // Reachable: the option is only offered while a selection exists, but the
    // selection can be emptied while it is the active choice.
    expect(ids('pinned', [])).toEqual(['a', 'b', 'w', 'x']);
  });

  it('does not mutate or alias the input', () => {
    const result = filterOperators(field, 'all', new Set());
    expect(result).not.toBe(field);
    expect(result).toEqual([...field]);
  });
});
