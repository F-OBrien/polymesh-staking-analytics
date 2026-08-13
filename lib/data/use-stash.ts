'use client';

import { useQuery, type UseQueryResult } from '@tanstack/react-query';
import { parseAsString, useQueryState } from 'nuqs';
import { useCallback, useState } from 'react';
import { resolveIndexerUrl, resolveNetwork, resolveRpcUrl } from '@/config/networks';
import {
  fetchRewardTotals,
  fetchRewards,
  type RewardEvent,
  type RewardTotals,
} from '@/lib/indexer/rewards';
import { earnedEraForReward, type EraIndex } from './era-index';
import { connectWallet, normaliseAddress, type WalletAccount } from '@/lib/chain/wallet';
import type { StashPosition } from '@/lib/chain/stash';
import type { StakeAllocation } from '@/lib/chain/allocation';

/**
 * The stash under inspection, and everything hanging off it.
 *
 * Nothing here loads `@polkadot/api` until a stash exists: queries are
 * `enabled`-gated on the address and chain modules are reached through
 * `await import()` inside the query function, never at module scope, so
 * arriving disconnected costs nothing. `npm run assert:lazy` checks this
 * against the built output.
 *
 * The address lives in `?stash=`, so a position is linkable and survives a
 * refresh without persisting a wallet address anywhere.
 */

/** The address being inspected, held in `?stash=`. */
export function useStashAddress() {
  const [stash, setStash] = useQueryState(
    'stash',
    parseAsString.withDefault('').withOptions({ history: 'push', shallow: true }),
  );

  const set = useCallback(
    (address: string | null) => {
      const next = address == null ? null : normaliseAddress(address);
      void setStash(next == null || next === '' ? null : next);
    },
    [setStash],
  );

  return { stash, setStash: set, clear: useCallback(() => set(null), [set]) };
}

export interface WalletState {
  accounts: WalletAccount[];
  connecting: boolean;
  error: Error | null;
}

/**
 * Wallet connection, deliberately outside TanStack Query: connecting is a
 * user-initiated action with a permission prompt, not a cacheable read, and a
 * query's retries and background refetches would each re-open the extension
 * dialog.
 */
export function useWallet() {
  const [state, setState] = useState<WalletState>({
    accounts: [],
    connecting: false,
    error: null,
  });

  const connect = useCallback(async (): Promise<WalletAccount[]> => {
    setState((previous) => ({ ...previous, connecting: true, error: null }));
    try {
      const accounts = await connectWallet();
      setState({ accounts, connecting: false, error: null });
      return accounts;
    } catch (error) {
      setState({
        accounts: [],
        connecting: false,
        error: error instanceof Error ? error : new Error(String(error)),
      });
      return [];
    }
  }, []);

  const disconnect = useCallback(() => {
    setState({ accounts: [], connecting: false, error: null });
  }, []);

  return { ...state, connect, disconnect };
}

/**
 * The stash's on-chain position. A minute of staleness: bonding changes are
 * user-initiated and rare, and this costs a websocket dial. Live makes it
 * immediate for anyone who wants that.
 */
export function useStashPosition(
  stash: string,
  activeEra: number | undefined,
): UseQueryResult<StashPosition> {
  return useQuery({
    queryKey: ['stash', stash, activeEra],
    enabled: stash !== '' && activeEra != null,
    staleTime: 60_000,
    // No retry: the dial already waits 12s, so even one more is 24 seconds of
    // skeleton before the user is told anything. The error state's Try again
    // button is faster and more honest.
    retry: false,
    queryFn: async () => {
      // Imported here, not at module scope — the boundary the lazy-loading
      // arrangement rests on.
      const [{ acquireApi }, { readStashPosition }] = await Promise.all([
        import('@/lib/chain/browser-api'),
        import('@/lib/chain/stash'),
      ]);

      const lease = await acquireApi(resolveRpcUrl(resolveNetwork()));
      try {
        return await readStashPosition(lease.api, stash, activeEra!);
      } finally {
        // Released in `finally` so a decoding failure cannot strand the socket.
        lease.release();
      }
    },
  });
}

/**
 * Where this stash's stake actually sits this era, and last. Separate from
 * `useStashPosition` because it depends on that query's nominations and is the
 * more expensive of the two.
 *
 * Not gated on having nominations: a chilled nominator's exposure stands until
 * the next election, and an operator's self-stake is exposed directly, so
 * skipping the read would report a working bond as idle.
 */
export function useStakeAllocation(
  stash: string,
  activeEra: number | undefined,
  targets: readonly string[],
): UseQueryResult<StakeAllocation> {
  return useQuery({
    // Targets are in the key — a nomination change alters the answer.
    queryKey: ['allocation', stash, activeEra, targets.join(',')],
    enabled: stash !== '' && activeEra != null,
    // Exposure is fixed for an era, so this is immutable until the next
    // election; a minute is just the granularity of noticing.
    staleTime: 60_000,
    retry: false,
    queryFn: async () => {
      const [{ acquireApi }, { readStakeAllocation }] = await Promise.all([
        import('@/lib/chain/browser-api'),
        import('@/lib/chain/allocation'),
      ]);

      const lease = await acquireApi(resolveRpcUrl(resolveNetwork()));
      try {
        return await readStakeAllocation(lease.api, stash, activeEra!, targets);
      } finally {
        lease.release();
      }
    },
  });
}

export interface RewardHistory {
  events: RewardEvent[];
  /** True when the page cap was hit, so the total is a floor not a total. */
  truncated: boolean;
}

/**
 * Lifetime total and payout count, in one request. Split from the detail walk
 * because the endpoint caps a page at 100 rows, so a long history is dozens of
 * sequential round trips to print a total the indexer will compute itself.
 */
export function useRewardTotals(stash: string): UseQueryResult<RewardTotals> {
  return useQuery({
    queryKey: ['reward-totals', stash],
    enabled: stash !== '',
    staleTime: 60 * 60_000,
    queryFn: ({ signal }) =>
      fetchRewardTotals(stash, { signal, endpoint: resolveIndexerUrl(resolveNetwork()) }),
  });
}

/**
 * Reward history from the indexer, event by event. Plain `fetch` with no
 * Polkadot dependency, so a pasted address shows its payout history without any
 * of the chain stack loading.
 *
 * `enabled` is a real choice: this is the expensive query, and `useRewardTotals`
 * answers the headline questions in one request, so the walk runs only when a
 * reader asks for the chart or the CSV. Passing an era index fills in which era
 * each payout was earned in — the indexer records a block, not an era.
 */
export function useRewardHistory(
  stash: string,
  { enabled = true, eraIndex }: { enabled?: boolean; eraIndex?: EraIndex | undefined } = {},
): UseQueryResult<RewardHistory> {
  return useQuery({
    // The era index is in the key: the same events resolve to different era
    // numbers once it loads, and a stash-only key would keep serving the
    // version with a blank era column.
    queryKey: ['rewards', stash, eraIndex == null ? 'no-eras' : eraIndex.lastEra],
    enabled: enabled && stash !== '',
    // Payouts land at most once an era, and this can be dozens of sequential
    // requests, so an hour is generous rather than stale.
    staleTime: 60 * 60_000,
    // Retrying the whole walk three times turns one slow failure into a very
    // slow one.
    retry: 1,
    queryFn: ({ signal }) =>
      fetchRewards(stash, {
        signal,
        endpoint: resolveIndexerUrl(resolveNetwork()),
        ...(eraIndex
          ? { earnedEra: (block: number) => earnedEraForReward(eraIndex, block) }
          : {}),
      }),
  });
}
